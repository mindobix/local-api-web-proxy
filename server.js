'use strict';

const http    = require('http');
const https   = require('https');
const tls     = require('tls');
const fs      = require('fs');
const path    = require('path');
const zlib    = require('zlib');
const os      = require('os');
const crypto  = require('crypto');
const { EventEmitter } = require('events');
const { execSync }    = require('child_process');
const WebSocket = require('ws');
const forge   = require('node-forge');
const pki     = forge.pki;

// ─── CLI Argument Parser ──────────────────────────────────────────────────────
// Usage: node server.js [--proxy-port 8888] [--dashboard-port 8000]
// Also reads env vars:  PROXY_PORT, DASH_PORT
function parseArgs() {
  const args = process.argv.slice(2);
  const out  = {};
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--proxy-port'     || args[i] === '-p') && args[i + 1]) out.proxyPort  = parseInt(args[++i]);
    if ((args[i] === '--dashboard-port' || args[i] === '-d') && args[i + 1]) out.dashPort   = parseInt(args[++i]);
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node server.js [options]

Options:
  --proxy-port,     -p <port>   HTTP/HTTPS proxy port  (default: 8888)
  --dashboard-port, -d <port>   Web dashboard port     (default: 8000)
  --help,           -h          Show this help

Environment variables (override defaults, overridden by flags):
  PROXY_PORT   proxy port
  DASH_PORT    dashboard port

Examples:
  node server.js
  node server.js --proxy-port 9999 --dashboard-port 9000
  node server.js -p 9999 -d 9000
`);
      process.exit(0);
    }
  }
  return out;
}

const { proxyPort: _pp, dashPort: _dp } = parseArgs();

// ─── Config ───────────────────────────────────────────────────────────────────
const PROXY_PORT     = _pp || parseInt(process.env.PROXY_PORT) || 8888;
const DASHBOARD_PORT = _dp || parseInt(process.env.DASH_PORT)  || 8000;
const MAX_CAPTURES   = 2000;
const MAX_BODY_BYTES = 256 * 1024; // 256 KB
const CERTS_DIR      = path.join(__dirname, 'certs');
const CA_KEY_PATH    = path.join(CERTS_DIR, 'ca.key');
const CA_CERT_PATH   = path.join(CERTS_DIR, 'ca.crt');
const LEAF_KEY_PATH  = path.join(CERTS_DIR, 'leaf.key');

// ─── State ────────────────────────────────────────────────────────────────────
let recording = true;
const captures       = []; // newest first
const captureBuffers = new Map(); // id → { buf, contentType } for binary responses
const emitter        = new EventEmitter();
const certCache      = {}; // hostname → { key, cert }
let CA               = null;
let sharedLeafKeys   = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getLocalIPs() {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    }
  }
  return ips;
}

function decompressBody(buf, encoding = '') {
  return new Promise(resolve => {
    if (encoding.includes('br'))      return zlib.brotliDecompress(buf, (e, r) => resolve(e ? buf : r));
    if (encoding.includes('gzip'))    return zlib.gunzip(buf,          (e, r) => resolve(e ? buf : r));
    if (encoding.includes('deflate')) return zlib.inflate(buf,         (e, r) => resolve(e ? buf : r));
    resolve(buf);
  });
}

function createDecoder(encoding = '') {
  if (encoding.includes('br'))      return zlib.createBrotliDecompress();
  if (encoding.includes('gzip'))    return zlib.createGunzip();
  if (encoding.includes('deflate')) return zlib.createInflate();
  return null;
}

function isTextType(ct = '') {
  return /text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql)/.test(ct);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.crt':  'application/x-x509-ca-cert',
  '.ico':  'image/x-icon',
};

// ─── CA + Certificate Management ──────────────────────────────────────────────
function loadOrCreateCA() {
  if (!fs.existsSync(CERTS_DIR)) fs.mkdirSync(CERTS_DIR, { recursive: true });

  if (fs.existsSync(CA_KEY_PATH) && fs.existsSync(CA_CERT_PATH)) {
    try {
      const keyPem  = fs.readFileSync(CA_KEY_PATH,  'utf8');
      const certPem = fs.readFileSync(CA_CERT_PATH, 'utf8');
      console.log('  CA cert loaded from disk.');
      return { key: keyPem, cert: certPem,
               forgeCert: pki.certificateFromPem(certPem),
               forgeKey:  pki.privateKeyFromPem(keyPem) };
    } catch { console.warn('  Corrupt CA files — regenerating.'); }
  }

  console.log('  Generating CA certificate (one-time, ~5s)…');
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey    = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName',       value: 'LocalApiWebProxy CA' },
    { name: 'organizationName', value: 'LocalApiWebProxy' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const keyPem  = pki.privateKeyToPem(keys.privateKey);
  const certPem = pki.certificateToPem(cert);
  fs.writeFileSync(CA_KEY_PATH,  keyPem);
  fs.writeFileSync(CA_CERT_PATH, certPem);
  console.log('  CA certificate saved.');
  return { key: keyPem, cert: certPem, forgeCert: cert, forgeKey: keys.privateKey };
}

// Shared leaf key pair — generated once, reused for all domain certs.
// Only the certificate changes per domain (signing is fast); key gen is the slow part.
function loadOrCreateLeafKeys() {
  if (fs.existsSync(LEAF_KEY_PATH)) {
    try {
      const privPem = fs.readFileSync(LEAF_KEY_PATH, 'utf8');
      const privKey = pki.privateKeyFromPem(privPem);
      const pubKey  = pki.setRsaPublicKey(privKey.n, privKey.e);
      console.log('  Shared leaf key loaded from disk.');
      return { privateKey: privKey, publicKey: pubKey };
    } catch { console.warn('  Corrupt leaf key — regenerating.'); }
  }

  console.log('  Generating shared leaf key pair (one-time, ~3s)…');
  const keys = pki.rsa.generateKeyPair(2048);
  fs.writeFileSync(LEAF_KEY_PATH, pki.privateKeyToPem(keys.privateKey));
  console.log('  Shared leaf key saved.');
  return keys;
}

// Fast — just signs a new cert using the already-loaded shared key pair
function getCertForHost(hostname) {
  if (certCache[hostname]) return certCache[hostname];

  const cert = pki.createCertificate();
  cert.publicKey    = sharedLeafKeys.publicKey;
  cert.serialNumber = (Date.now() % 0xFFFFFF).toString(16).padStart(6, '0');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(CA.forgeCert.subject.attributes);
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
    { name: 'basicConstraints', cA: false },
  ]);
  cert.sign(CA.forgeKey, forge.md.sha256.create());

  certCache[hostname] = {
    key:  pki.privateKeyToPem(sharedLeafKeys.privateKey),
    cert: pki.certificateToPem(cert),
  };
  return certCache[hostname];
}

// ─── Shared capture logic ──────────────────────────────────────────────────────
async function recordCapture({ id, t0, method, fullUrl, host, port, path: urlPath,
                               proto, reqHeaders, reqBuf, status, statusText,
                               resHeaders, resBuf, error }) {
  const encoding = (resHeaders || {})['content-encoding'] || '';
  const decoded  = await decompressBody(resBuf || Buffer.alloc(0), encoding);
  const ct       = ((resHeaders || {})['content-type'] || '').split(';')[0].trim();
  const isText   = isTextType(ct);

  const capture = {
    id, ts: t0,
    method, url: fullUrl,
    host,   port: String(port),
    path: urlPath,
    proto,
    reqHeaders,
    reqBody:      reqBuf && reqBuf.length ? reqBuf.slice(0, MAX_BODY_BYTES).toString('utf8') : null,
    reqBodyTrunc: reqBuf ? reqBuf.length > MAX_BODY_BYTES : false,
    status, statusText,
    resHeaders: resHeaders || {},
    contentType: ct,
    resBody:      isText ? decoded.slice(0, MAX_BODY_BYTES).toString('utf8') : null,
    resBodyTrunc: decoded.length > MAX_BODY_BYTES,
    resBodyBin:   !isText && decoded.length > 0,
    duration: Date.now() - t0,
    reqSize:  reqBuf  ? reqBuf.length : 0,
    resSize:  resBuf  ? resBuf.length : 0,
    error: error || null,
  };

  // Store binary body for on-demand serving (images, etc.)
  if (!isText && decoded.length > 0 && decoded.length <= 4 * 1024 * 1024) {
    captureBuffers.set(id, { buf: decoded, contentType: ct });
  }

  captures.unshift(capture);
  if (captures.length > MAX_CAPTURES) {
    const evicted = captures.pop();
    if (evicted) captureBuffers.delete(evicted.id);
  }
  emitter.emit('capture', capture);
}

// ─── Inner HTTPS intercept server ─────────────────────────────────────────────
// Receives decrypted HTTPS traffic via interceptServer.emit('connection', tlsSocket)
const interceptServer = http.createServer((req, res) => {
  const hostname = req.socket._proxyHost;
  const port     = req.socket._proxyPort || 443;
  if (!hostname) { res.writeHead(500); res.end('Proxy: missing hostname'); return; }

  const t0      = Date.now();
  const id      = crypto.randomUUID();
  const urlHost = port !== 443 ? `${hostname}:${port}` : hostname;
  const fullUrl = `https://${urlHost}${req.url}`;

  const reqChunks = [];
  req.on('data', c => reqChunks.push(c));

  const fwdHeaders = { ...req.headers, host: urlHost };
  delete fwdHeaders['proxy-connection'];
  delete fwdHeaders['proxy-authorization'];

  const proxyReq = https.request({
    hostname, port,
    path:    req.url,
    method:  req.method,
    headers: fwdHeaders,
    rejectUnauthorized: false, // allow self-signed on upstream
  }, async proxyRes => {
    const resChunks = [];
    const rawEncoding = proxyRes.headers['content-encoding'] || '';
    // Strip content-encoding + alt-svc — we decompress before forwarding
    const fwdResHeaders = { ...proxyRes.headers };
    delete fwdResHeaders['content-encoding'];
    delete fwdResHeaders['content-length']; // decompressed size differs
    delete fwdResHeaders['alt-svc'];

    res.writeHead(proxyRes.statusCode, fwdResHeaders);

    const decoder = createDecoder(rawEncoding);
    const source  = decoder ? proxyRes.pipe(decoder) : proxyRes;
    if (decoder) decoder.on('error', () => res.end());

    source.on('data', c => { resChunks.push(c); res.write(c); });
    source.on('end', async () => {
      res.end();
      if (!recording) return;
      await recordCapture({
        id, t0, method: req.method, fullUrl,
        host: hostname, port, path: req.url, proto: 'https',
        reqHeaders: req.headers,
        reqBuf:     Buffer.concat(reqChunks),
        status:     proxyRes.statusCode,
        statusText: proxyRes.statusMessage,
        resHeaders: fwdResHeaders, // no content-encoding; body already decoded
        resBuf:     Buffer.concat(resChunks),
      });
    });
  });

  proxyReq.on('error', async err => {
    if (!res.headersSent) { res.writeHead(502); res.end('Proxy error: ' + err.message); }
    if (!recording) return;
    await recordCapture({
      id, t0, method: req.method, fullUrl,
      host: hostname, port, path: req.url, proto: 'https',
      reqHeaders: req.headers,
      reqBuf: Buffer.concat(reqChunks),
      status: 0, statusText: 'Connection Error',
      resHeaders: {}, resBuf: Buffer.alloc(0),
      error: err.message,
    });
  });

  req.on('data', c => proxyReq.write(c));
  req.on('end',  () => proxyReq.end());
});
interceptServer.on('clientError', () => {});

// ─── CONNECT handler — HTTPS MITM ─────────────────────────────────────────────
function handleConnect(req, clientSocket, head) {
  const [hostname, portStr] = req.url.split(':');
  const port = parseInt(portStr) || 443;

  // 1. Acknowledge tunnel to client
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  // 2. Get/generate signed cert for this hostname (fast — just signing)
  let certInfo;
  try { certInfo = getCertForHost(hostname); }
  catch (err) {
    console.error('Cert error for', hostname, err.message);
    clientSocket.destroy();
    return;
  }

  // 3. Wrap the client socket in TLS — we act as the TLS server
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer:           true,
    key:                certInfo.key,
    cert:               certInfo.cert,
    ALPNProtocols:      ['http/1.1'], // force HTTP/1.1; skip HTTP/2 complexity
    rejectUnauthorized: false,
  });

  if (head && head.length) tlsSocket.push(head);

  tlsSocket._proxyHost = hostname;
  tlsSocket._proxyPort = port;
  tlsSocket.on('error', () => {});

  // 4. Feed decrypted stream into our inner HTTP server
  interceptServer.emit('connection', tlsSocket);
}

// ─── HTTP Proxy Server (port 8888) ────────────────────────────────────────────
function createProxy() {
  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    const id = crypto.randomUUID();

    let url;
    try { url = new URL(req.url); }
    catch { res.writeHead(400); res.end('Bad Request'); return; }

    const reqChunks  = [];
    const fwdHeaders = { ...req.headers };
    delete fwdHeaders['proxy-connection'];
    delete fwdHeaders['proxy-authorization'];

    const proxyReq = http.request({
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname + (url.search || ''),
      method:   req.method,
      headers:  fwdHeaders,
    }, async proxyRes => {
      const resChunks = [];
      const rawEncoding = proxyRes.headers['content-encoding'] || '';
      const fwdResHeaders = { ...proxyRes.headers };
      delete fwdResHeaders['content-encoding'];
      delete fwdResHeaders['content-length']; // decompressed size differs
      delete fwdResHeaders['alt-svc'];

      res.writeHead(proxyRes.statusCode, fwdResHeaders);

      const decoder = createDecoder(rawEncoding);
      const source  = decoder ? proxyRes.pipe(decoder) : proxyRes;
      if (decoder) decoder.on('error', () => res.end());

      source.on('data', c => { resChunks.push(c); res.write(c); });
      source.on('end', async () => {
        res.end();
        if (!recording) return;
        await recordCapture({
          id, t0, method: req.method, fullUrl: req.url,
          host: url.hostname, port: url.port || 80,
          path: url.pathname + (url.search || ''), proto: 'http',
          reqHeaders: req.headers,
          reqBuf:  Buffer.concat(reqChunks),
          status:  proxyRes.statusCode,
          statusText: proxyRes.statusMessage,
          resHeaders: fwdResHeaders, // no content-encoding; body already decoded
          resBuf:  Buffer.concat(resChunks),
        });
      });
    });

    proxyReq.on('error', async err => {
      if (!res.headersSent) { res.writeHead(502); res.end('Proxy error: ' + err.message); }
      if (!recording) return;
      await recordCapture({
        id, t0, method: req.method, fullUrl: req.url,
        host: url.hostname, port: url.port || 80,
        path: url.pathname + (url.search || ''), proto: 'http',
        reqHeaders: req.headers,
        reqBuf: Buffer.concat(reqChunks),
        status: 0, statusText: 'Connection Error',
        resHeaders: {}, resBuf: Buffer.alloc(0),
        error: err.message,
      });
    });

    req.on('data', c => proxyReq.write(c));
    req.on('end',  () => proxyReq.end());
  });

  // HTTPS — MITM instead of plain tunnel
  server.on('connect', handleConnect);

  return server;
}

// ─── Dashboard Server (port 8000) ─────────────────────────────────────────────
function createDashboard() {
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    if (req.url === '/api/status') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        recording, proxyPort: PROXY_PORT,
        ips: getLocalIPs(), count: captures.length,
      }));
      return;
    }

    if (req.url === '/api/captures') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(captures.slice(0, 500)));
      return;
    }

    // Serve binary body for a specific capture (images, PDFs, etc.)
    const bodyMatch = req.url.match(/^\/api\/captures\/([^/]+)\/body$/);
    if (bodyMatch) {
      const data = captureBuffers.get(bodyMatch[1]);
      if (!data) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        ...cors,
        'Content-Type':   data.contentType || 'application/octet-stream',
        'Content-Length': data.buf.length,
        'Cache-Control':  'no-store',
      });
      res.end(data.buf);
      return;
    }

    // Serve CA cert for download / device install
    if (req.url === '/ca.crt') {
      if (!fs.existsSync(CA_CERT_PATH)) { res.writeHead(404); res.end('CA not ready'); return; }
      const certPem = fs.readFileSync(CA_CERT_PATH);
      res.writeHead(200, {
        ...cors,
        'Content-Type':        'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="LocalApiWebProxy.crt"',
        'Content-Length':      certPem.length,
      });
      res.end(certPem);
      return;
    }

    // Static files
    const urlPath  = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const filePath = path.join(__dirname, 'public', urlPath);
    if (!filePath.startsWith(path.join(__dirname, 'public'))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { ...cors, 'Content-Type': MIME[ext] || 'text/plain', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  return server;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('\n╔═══════════════════════════════════════════════╗');
console.log('║        APIWebProxy  —  Phase 2  (HTTP+HTTPS)   ║');
console.log('╠═══════════════════════════════════════════════╣');
console.log('║  Initializing certificates…                   ║');
console.log('╚═══════════════════════════════════════════════╝');

CA             = loadOrCreateCA();
sharedLeafKeys = loadOrCreateLeafKeys();

const proxy     = createProxy();
const dashboard = createDashboard();
const wss       = new WebSocket.Server({ server: dashboard });

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// Suppress unhandled errors on WSS — listenWithRetry on dashboard handles them
wss.on('error', () => {});

wss.on('connection', ws => {
  ws.send(JSON.stringify({
    type:      'init',
    recording,
    proxyPort: PROXY_PORT,
    ips:       getLocalIPs(),
    captures:  captures.slice(0, 300),
  }));

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'toggle_recording') {
        recording = !recording;
        broadcast({ type: 'status', recording, ips: getLocalIPs(), proxyPort: PROXY_PORT });
      } else if (msg.type === 'clear') {
        captures.length = 0;
        captureBuffers.clear();
        broadcast({ type: 'cleared' });
      }
    } catch {}
  });

  ws.on('error', () => {});
});

emitter.on('capture', c => broadcast({ type: 'capture', data: c }));

// ─── Port helpers ─────────────────────────────────────────────────────────────
function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const match = out.match(/LISTENING\s+(\d+)/);
      if (match) execSync(`taskkill /PID ${match[1]} /F`, { stdio: 'ignore' });
    } else {
      execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' });
    }
  } catch {} // nothing listening — that's fine
}

function listenWithRetry(server, port, label, onReady) {
  server.listen(port, '0.0.0.0', onReady);

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`  Port ${port} in use — killing old process and retrying…`);
      killPort(port);
      setTimeout(() => server.listen(port, '0.0.0.0', onReady), 600);
    } else {
      console.error(`${label} error:`, err.message);
      process.exit(1);
    }
  });
}

listenWithRetry(proxy, PROXY_PORT, 'Proxy', () => {
  const ips = getLocalIPs();
  console.log(`
╔═══════════════════════════════════════════════╗
║        APIWebProxy  —  Phase 2  (HTTP+HTTPS)   ║
╠═══════════════════════════════════════════════╣
║  Proxy     :  0.0.0.0:${PROXY_PORT}                    ║
║  Dashboard :  http://localhost:${DASHBOARD_PORT}          ║
║  CA cert   :  http://localhost:${DASHBOARD_PORT}/ca.crt   ║
╠═══════════════════════════════════════════════╣
║  1. Set device WiFi proxy → ${(ips[0]||'localhost')+':'+PROXY_PORT}
║  2. Visit http://localhost:${DASHBOARD_PORT}/ca.crt to install CA
╚═══════════════════════════════════════════════╝
`);
});

listenWithRetry(dashboard, DASHBOARD_PORT, 'Dashboard', () => {
  console.log(`Dashboard → http://localhost:${DASHBOARD_PORT}\n`);
});
