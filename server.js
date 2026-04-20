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
const net     = require('net');
const WebSocket = require('ws');
const forge   = require('node-forge');
const pki     = forge.pki;

// ─── CLI Argument Parser ──────────────────────────────────────────────────────
// Usage: node server.js [--proxy-port 9999] [--dashboard-port 9000]
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
  --proxy-port,     -p <port>   HTTP/HTTPS proxy port  (default: 9999)
  --dashboard-port, -d <port>   Web dashboard port     (default: 9000)
  --help,           -h          Show this help

Environment variables (override defaults, overridden by flags):
  PROXY_PORT   proxy port
  DASH_PORT    dashboard port

Examples:
  node server.js
  node server.js --proxy-port 8888 --dashboard-port 8000
  node server.js -p 8888 -d 8000
`);
      process.exit(0);
    }
  }
  return out;
}

const { proxyPort: _pp, dashPort: _dp } = parseArgs();

// ─── Config ───────────────────────────────────────────────────────────────────
const PROXY_PORT     = _pp || parseInt(process.env.PROXY_PORT) || 9999;
const DASHBOARD_PORT = _dp || parseInt(process.env.DASH_PORT)  || 9000;
const MAX_CAPTURES   = 2000;
const MAX_BODY_BYTES = 256 * 1024; // 256 KB
// When packaged inside Electron, __dirname may be inside an ASAR archive (read-only).
// The Electron main process sets CERTS_DIR env var to a writable userData path.
const CERTS_DIR      = process.env.CERTS_DIR || path.join(__dirname, 'certs');
const CA_KEY_PATH    = path.join(CERTS_DIR, 'ca.key');
const CA_CERT_PATH   = path.join(CERTS_DIR, 'ca.crt');
const LEAF_KEY_PATH  = path.join(CERTS_DIR, 'leaf.key');

// ─── State ────────────────────────────────────────────────────────────────────
let recording = true;
let sslProxying = { enabled: true, locations: [{ host: '*', port: '' }] };
let mapLocal    = { enabled: false, mappings: [] };
// Each mapping: { enabled, protocol, host, port, path, query, localPath, caseSensitive }
let mapRemote   = { enabled: false, rules: [] };
// Each rule: { id, name, description, enabled, conditions[], redirect, createdAt, updatedAt }
// Runtime-only counters for each rule (not persisted / not sent back on POST).
// ruleId → { count: number, lastMatchedAt: number|null }
const mapRemoteStats = new Map();

// ─── Sessions ─────────────────────────────────────────────────────────────────
// Each session owns its own capture ring buffer and binary-body map. One
// session is "active" at a time; recordCapture + /api/captures + the cache
// replay route all operate on the active session.
//
// `captures` and `captureBuffers` are intentionally kept as mutable aliases so
// every existing call site keeps working — switching the active session just
// reassigns these to the new session's internal arrays.
const sessions = new Map(); // id → { id, name, createdAt, captures: [], captureBuffers: Map }
let activeSessionId = null;
let captures       = []; // alias for the active session's captures (newest first)
let captureBuffers = new Map(); // alias for the active session's binary-body map

function createSession(name) {
  const id = crypto.randomUUID();
  const session = {
    id,
    name: name || `Session ${sessions.size + 1}`,
    createdAt: new Date().toISOString(),
    captures: [],
    captureBuffers: new Map(),
  };
  sessions.set(id, session);
  return session;
}

function setActiveSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  activeSessionId = id;
  captures       = s.captures;
  captureBuffers = s.captureBuffers;
  return true;
}

function sessionsPayload() {
  return {
    activeId: activeSessionId,
    sessions: [...sessions.values()].map(s => ({
      id:        s.id,
      name:      s.name,
      createdAt: s.createdAt,
      count:     s.captures.length,
      active:    s.id === activeSessionId,
    })),
  };
}

// Seed the default session on module load so the aliases above are live before
// any request is served.
setActiveSession(createSession('Session 1').id);

const emitter        = new EventEmitter();
const certCache      = {}; // hostname → { key, cert }
let CA               = null;
let sharedLeafKeys   = null;

// ─── SSL Proxying Filter ──────────────────────────────────────────────────────
function sslProxyingAllows(hostname, port) {
  if (!sslProxying.enabled) return false;
  if (!sslProxying.locations.length) return false;

  const h = hostname.toLowerCase();

  return sslProxying.locations.some(loc => {
    // Strip any path portion — users enter "kroger.com/*" meaning the host only
    const host = (loc.host || '').trim().split('/')[0].toLowerCase();

    let hMatch;
    if (!host || host === '*') {
      // Empty or bare wildcard → match everything
      hMatch = true;
    } else if (host.startsWith('*.')) {
      // *.kroger.com → matches any subdomain AND the bare domain itself
      const base = host.slice(2);
      hMatch = h === base || h.endsWith('.' + base);
    } else {
      // kroger.com → match the domain AND all its subdomains
      hMatch = h === host || h.endsWith('.' + host);
    }

    const pMatch = !loc.port || loc.port === '*' || loc.port === String(port);
    return hMatch && pMatch;
  });
}

// ─── Capture Filter ───────────────────────────────────────────────────────────
// When SSL Proxying is enabled and restricted to a specific host list, apply
// the same allowlist to *plain-HTTP* captures too — otherwise OS background
// noise (Windows Update cert-list downloads, connectivity checks, NTP probes,
// etc.) floods the dashboard even when the user has scoped the filter to a
// single domain.
//
// Semantics:
//   - sslProxying.enabled === false      → no filtering (capture everything)
//   - sslProxying.enabled === true       → forward to sslProxyingAllows()
//     (which is "*"-aware: a wildcard entry still matches all hosts)
//
// Non-matched HTTP traffic is still forwarded — we only skip recordCapture()
// so Windows Update / connectivity probes keep working silently.
function shouldCaptureHost(hostname, port) {
  if (!sslProxying.enabled) return true;
  return sslProxyingAllows(hostname, port);
}

// ─── JSON Cache Lookup ────────────────────────────────────────────────────────
// Powers the /<host>/<path> replay route. Walks the in-memory capture ring
// (newest-first) and returns the most recent successful GET capture whose
// content-type declares JSON and that matches the requested host + path+query
// exactly. Returns null if nothing matches.
function findCachedResponse(host, pathAndQuery) {
  for (const c of captures) {
    if (c.host !== host) continue;
    if (c.method !== 'GET') continue;
    if (c.path !== pathAndQuery) continue;
    if (!c.resBody) continue;
    if (!c.status || c.status >= 400) continue;
    const ct = (c.contentType || '').toLowerCase();
    if (!ct.includes('json')) continue;
    return c;
  }
  return null;
}

// ─── Map Local Matching ───────────────────────────────────────────────────────
function findMapLocalMatch(proto, hostname, port, urlPath) {
  if (!mapLocal.enabled || !mapLocal.mappings.length) return null;

  const h = hostname.toLowerCase();
  const p = String(port);
  const pathAndQuery = urlPath || '/';
  const [pathPart, queryPart] = pathAndQuery.split('?');

  for (const m of mapLocal.mappings) {
    if (!m.enabled || !m.localPath) continue;

    // Protocol check
    if (m.protocol && m.protocol !== '*' && m.protocol !== proto) continue;

    // Host check
    const mHost = (m.host || '').trim().toLowerCase();
    if (mHost && mHost !== '*') {
      if (mHost.startsWith('*.')) {
        const base = mHost.slice(2);
        if (h !== base && !h.endsWith('.' + base)) continue;
      } else {
        if (h !== mHost) continue;
      }
    }

    // Port check
    if (m.port && m.port !== '*' && m.port !== p) continue;

    // Path check
    const mPath = (m.path || '').trim();
    if (mPath && mPath !== '*') {
      const compare = m.caseSensitive
        ? (a, b) => a === b || a.startsWith(b)
        : (a, b) => a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(b.toLowerCase());
      if (!compare(pathPart, mPath)) continue;
    }

    // Query check
    const mQuery = (m.query || '').trim();
    if (mQuery && mQuery !== '*') {
      if (!queryPart || !queryPart.includes(mQuery)) continue;
    }

    return m;
  }
  return null;
}

// Serve a mapped local file for a request
function serveMapLocal(mapping, req, res, captureInfo) {
  const localPath = mapping.localPath;

  // If localPath is a directory, try to find a file based on the request path
  let filePath = localPath;
  try {
    const stat = fs.statSync(localPath);
    if (stat.isDirectory()) {
      // Use request path to find a file in the directory
      const safePath = (captureInfo.urlPath || '/').split('?')[0].replace(/\.\./g, '');
      filePath = path.join(localPath, safePath);
      // If still a directory or doesn't exist, try index.json
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(localPath, 'index.json');
      }
    }
  } catch {
    // File doesn't exist — will be caught below
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Map Local: file not found — ' + filePath);
      }
      if (recording) {
        recordCapture({
          ...captureInfo,
          status: 404, statusText: 'Map Local File Not Found',
          resHeaders: { 'content-type': 'text/plain', 'x-map-local': filePath },
          resBuf: Buffer.from('Map Local: file not found — ' + filePath),
          mapLocal: true,
        });
      }
      return;
    }

    // Guess content-type from extension
    const ext = path.extname(filePath).toLowerCase();
    const ctMap = {
      '.json': 'application/json; charset=utf-8',
      '.xml':  'application/xml; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.txt':  'text/plain; charset=utf-8',
      '.js':   'application/javascript; charset=utf-8',
      '.css':  'text/css; charset=utf-8',
    };
    const ct = ctMap[ext] || 'application/octet-stream';

    const resHeaders = {
      'content-type':   ct,
      'content-length': String(data.length),
      'x-map-local':    filePath,
    };

    if (!res.headersSent) {
      res.writeHead(200, resHeaders);
      res.end(data);
    }

    if (recording) {
      recordCapture({
        ...captureInfo,
        status: 200, statusText: 'OK (Map Local)',
        resHeaders,
        resBuf: data,
        mapLocal: true,
      });
    }
  });
}

// ─── Map Remote ───────────────────────────────────────────────────────────────
// Evaluate a single condition against a request context.
// ctx = { url, host, path, method, query, headers }
function evaluateCondition(cond, ctx) {
  const field = cond.field;
  const op    = cond.operator;
  const cs    = !!cond.caseSensitive;
  let haystack;

  switch (field) {
    case 'URL':    haystack = ctx.url;    break;
    case 'HOST':   haystack = ctx.host;   break;
    case 'PATH':   haystack = ctx.path;   break;
    case 'METHOD': haystack = ctx.method; break;
    case 'QUERY':  haystack = ctx.query;  break;
    case 'HEADER': {
      const name = (cond.headerName || '').toLowerCase();
      if (!name) return false;
      const v = ctx.headers[name];
      haystack = Array.isArray(v) ? v.join(', ') : (v || '');
      break;
    }
    default: return false;
  }

  const needle = cond.value != null ? String(cond.value) : '';
  const a = cs ? String(haystack || '') : String(haystack || '').toLowerCase();
  const b = cs ? needle                  : needle.toLowerCase();

  switch (op) {
    case 'CONTAINS':      return a.includes(b);
    case 'EQUALS':        return a === b;
    case 'STARTS_WITH':   return a.startsWith(b);
    case 'ENDS_WITH':     return a.endsWith(b);
    case 'MATCHES_REGEX': {
      try { return new RegExp(needle, cs ? '' : 'i').test(String(haystack || '')); }
      catch { return false; }
    }
    default: return false;
  }
}

function buildRequestContext(proto, hostname, port, urlPath, method, headers) {
  const pathAndQuery = urlPath || '/';
  const [pathPart, queryPart = ''] = pathAndQuery.split('?');
  const hostWithPort = (proto === 'https' && port === 443) || (proto === 'http' && port === 80)
    ? hostname
    : `${hostname}:${port}`;
  return {
    url:    `${proto}://${hostWithPort}${pathAndQuery}`,
    host:   hostname,
    path:   pathPart,
    method: method || 'GET',
    query:  queryPart,
    headers: Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
}

function findMapRemoteMatch(proto, hostname, port, urlPath, method, headers) {
  if (!mapRemote.enabled || !mapRemote.rules.length) return null;
  const ctx = buildRequestContext(proto, hostname, port, urlPath, method, headers);

  for (const rule of mapRemote.rules) {
    if (!rule.enabled) continue;
    if (!Array.isArray(rule.conditions) || !rule.conditions.length) continue;
    if (!rule.redirect || !rule.redirect.type) continue;

    const allMatch = rule.conditions.every(c => evaluateCondition(c, ctx));
    if (allMatch) return { rule, ctx };
  }
  return null;
}

// URL composition for redirect.type === 'URL'.
// Documented behavior:
//   - preservePath=true: append original path to target's path (dedupe slash at boundary).
//   - preservePath=false: keep only target's path (or '/').
//   - preserveQuery=true: if target has its own query, merge — target params win on key conflict.
//   - preserveQuery=false: use only target's query (if any).
function composeRedirectUrl(originalUrl, target) {
  const orig = new URL(originalUrl);
  const tgt  = new URL(target.target);

  // Path
  let finalPath;
  if (target.preservePath) {
    const base = tgt.pathname.replace(/\/+$/, '');    // trim trailing /
    const orig_ = orig.pathname.startsWith('/') ? orig.pathname : '/' + orig.pathname;
    finalPath = (base + orig_) || '/';
  } else {
    finalPath = tgt.pathname || '/';
  }

  // Query
  const params = new URLSearchParams();
  if (target.preserveQuery) {
    for (const [k, v] of orig.searchParams) params.append(k, v);
  }
  // Target params ALWAYS apply (and override on conflict when preserving query)
  for (const [k, v] of tgt.searchParams) {
    params.delete(k);
    params.append(k, v);
  }
  const queryStr = params.toString();

  return {
    protocol: tgt.protocol.replace(':', ''),  // 'http' | 'https'
    hostname: tgt.hostname,
    port:     tgt.port ? parseInt(tgt.port) : (tgt.protocol === 'https:' ? 443 : 80),
    path:     finalPath + (queryStr ? '?' + queryStr : ''),
    fullUrl:  `${tgt.protocol}//${tgt.host}${finalPath}${queryStr ? '?' + queryStr : ''}`,
  };
}

// Build the payload sent to clients — includes runtime stats merged onto each rule.
function mapRemotePayload() {
  return {
    enabled: mapRemote.enabled,
    rules: mapRemote.rules.map(r => {
      const s = mapRemoteStats.get(r.id) || { count: 0, lastMatchedAt: null };
      return { ...r, matchCount: s.count, lastMatchedAt: s.lastMatchedAt };
    }),
  };
}

function bumpMapRemoteStats(ruleId) {
  const cur = mapRemoteStats.get(ruleId) || { count: 0, lastMatchedAt: null };
  cur.count += 1;
  cur.lastMatchedAt = Date.now();
  mapRemoteStats.set(ruleId, cur);
  if (typeof broadcast === 'function') {
    broadcast({ type: 'map_remote_stats', data: { ruleId, count: cur.count, lastMatchedAt: cur.lastMatchedAt } });
  }
}

// Forward a request to a different URL per a Map Remote URL rule.
// Called from both HTTP and HTTPS handlers after a match.
function serveMapRemoteUrl(rule, origReq, origRes, captureInfo) {
  const target = rule.redirect;
  const composed = composeRedirectUrl(captureInfo.fullUrl, target);

  // Apply preservation flags
  const preserveMethod  = target.preserveMethod  !== false;
  const preserveHeaders = target.preserveHeaders !== false;
  const preserveBody    = target.preserveBody    !== false;

  const method = preserveMethod ? origReq.method : 'GET';

  // Headers — start from original if preserving, else minimal
  const fwdHeaders = preserveHeaders ? { ...origReq.headers } : {};
  delete fwdHeaders['proxy-connection'];
  delete fwdHeaders['proxy-authorization'];
  // Rewrite Host to the new target
  fwdHeaders['host'] = composed.port === 80 || composed.port === 443
    ? composed.hostname
    : `${composed.hostname}:${composed.port}`;

  if (!preserveBody || !preserveMethod) {
    // Drop body-related headers when not sending a body
    delete fwdHeaders['content-length'];
    delete fwdHeaders['transfer-encoding'];
    delete fwdHeaders['content-type'];
  }

  const transport = composed.protocol === 'https' ? https : http;
  const reqChunks = [];

  const proxyReq = transport.request({
    hostname: composed.hostname,
    port:     composed.port,
    path:     composed.path,
    method,
    headers:  fwdHeaders,
    rejectUnauthorized: false,
    servername: composed.protocol === 'https' ? composed.hostname : undefined, // SNI
  }, async proxyRes => {
    const resChunks = [];
    const rawEncoding = proxyRes.headers['content-encoding'] || '';
    const fwdResHeaders = { ...proxyRes.headers };
    delete fwdResHeaders['content-encoding'];
    delete fwdResHeaders['content-length'];
    delete fwdResHeaders['alt-svc'];
    fwdResHeaders['x-map-remote-rule']     = rule.name || rule.id;
    fwdResHeaders['x-map-remote-original'] = captureInfo.fullUrl;
    fwdResHeaders['x-map-remote-final']    = composed.fullUrl;

    if (!origRes.headersSent) origRes.writeHead(proxyRes.statusCode, fwdResHeaders);

    const decoder = createDecoder(rawEncoding);
    const source  = decoder ? proxyRes.pipe(decoder) : proxyRes;
    if (decoder) decoder.on('error', () => origRes.end());

    source.on('data', c => { resChunks.push(c); origRes.write(c); });
    source.on('end', async () => {
      origRes.end();
      bumpMapRemoteStats(rule.id);
      if (!recording) return;
      await recordCapture({
        ...captureInfo,
        reqBuf:     Buffer.concat(reqChunks),
        status:     proxyRes.statusCode,
        statusText: proxyRes.statusMessage,
        resHeaders: fwdResHeaders,
        resBuf:     Buffer.concat(resChunks),
        mapRemote: {
          ruleId:      rule.id,
          ruleName:    rule.name || '',
          originalUrl: captureInfo.fullUrl,
          finalUrl:    composed.fullUrl,
          matched:     rule.conditions,
        },
      });
    });
  });

  proxyReq.on('error', async err => {
    if (!origRes.headersSent) { origRes.writeHead(502); origRes.end('Map Remote error: ' + err.message); }
    bumpMapRemoteStats(rule.id);
    if (!recording) return;
    await recordCapture({
      ...captureInfo,
      reqBuf: Buffer.concat(reqChunks),
      status: 0, statusText: 'Map Remote Connection Error',
      resHeaders: {}, resBuf: Buffer.alloc(0),
      error: err.message,
      mapRemote: {
        ruleId:      rule.id,
        ruleName:    rule.name || '',
        originalUrl: captureInfo.fullUrl,
        finalUrl:    composed.fullUrl,
        matched:     rule.conditions,
      },
    });
  });

  if (preserveBody && preserveMethod) {
    origReq.on('data', c => { reqChunks.push(c); proxyReq.write(c); });
    origReq.on('end',  () => proxyReq.end());
  } else {
    // Drain the body but don't forward it
    origReq.on('data', c => reqChunks.push(c));
    origReq.on('end',  () => proxyReq.end());
  }
}

// Serve a local file per a Map Remote LOCAL_FILE rule (thin wrapper over serveMapLocal).
function serveMapRemoteLocal(rule, origReq, origRes, captureInfo) {
  const target = rule.redirect;
  const pseudoMapping = {
    localPath: target.filePath,
    // serveMapLocal infers content-type from extension; we override if provided
  };

  const statusOverride = target.statusCode || 200;
  const ctOverride     = target.contentType || null;

  fs.readFile(target.filePath, (err, data) => {
    if (err) {
      if (!origRes.headersSent) {
        origRes.writeHead(404, { 'Content-Type': 'text/plain' });
        origRes.end('Map Remote: file not found — ' + target.filePath);
      }
      bumpMapRemoteStats(rule.id);
      if (recording) {
        recordCapture({
          ...captureInfo,
          status: 404, statusText: 'Map Remote File Not Found',
          resHeaders: { 'content-type': 'text/plain', 'x-map-remote-file': target.filePath, 'x-map-remote-rule': rule.name || rule.id },
          resBuf: Buffer.from('Map Remote: file not found — ' + target.filePath),
          mapRemote: {
            ruleId:      rule.id,
            ruleName:    rule.name || '',
            originalUrl: captureInfo.fullUrl,
            finalUrl:    'file://' + target.filePath,
            matched:     rule.conditions,
          },
        });
      }
      return;
    }

    const ext = path.extname(target.filePath).toLowerCase();
    const ctMap = {
      '.json': 'application/json; charset=utf-8',
      '.xml':  'application/xml; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.txt':  'text/plain; charset=utf-8',
      '.js':   'application/javascript; charset=utf-8',
      '.css':  'text/css; charset=utf-8',
    };
    const ct = ctOverride || ctMap[ext] || 'application/octet-stream';

    const resHeaders = {
      'content-type':       ct,
      'content-length':     String(data.length),
      'x-map-remote-file':  target.filePath,
      'x-map-remote-rule':  rule.name || rule.id,
    };

    if (!origRes.headersSent) {
      origRes.writeHead(statusOverride, resHeaders);
      origRes.end(data);
    }

    bumpMapRemoteStats(rule.id);

    if (recording) {
      recordCapture({
        ...captureInfo,
        status: statusOverride, statusText: 'OK (Map Remote)',
        resHeaders,
        resBuf: data,
        mapRemote: {
          ruleId:      rule.id,
          ruleName:    rule.name || '',
          originalUrl: captureInfo.fullUrl,
          finalUrl:    'file://' + target.filePath,
          matched:     rule.conditions,
        },
      });
    }
  });
}

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
                               resHeaders, resBuf, error, mapLocal: isMapLocal,
                               mapRemote: mapRemoteInfo }) {
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
    mapLocal: isMapLocal || false,
    mapRemote: mapRemoteInfo || null,
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

  // ── Map Remote check (HTTPS) — runs before Map Local ──
  const mrMatch = findMapRemoteMatch('https', hostname, port, req.url, req.method, req.headers);
  if (mrMatch) {
    const { rule } = mrMatch;
    const capInfo = {
      id, t0, method: req.method, fullUrl,
      host: hostname, port, path: req.url, proto: 'https',
      reqHeaders: req.headers,
    };
    if (rule.redirect.type === 'URL') {
      serveMapRemoteUrl(rule, req, res, capInfo);
    } else if (rule.redirect.type === 'LOCAL_FILE') {
      req.on('data', c => reqChunks.push(c));
      req.on('end', () => serveMapRemoteLocal(rule, req, res, { ...capInfo, reqBuf: Buffer.concat(reqChunks) }));
    } else {
      // Unknown redirect type — fall through to normal forwarding
    }
    if (rule.redirect.type === 'URL' || rule.redirect.type === 'LOCAL_FILE') return;
  }

  req.on('data', c => reqChunks.push(c));

  // ── Map Local check (HTTPS) ──
  const mapLocalMatch = findMapLocalMatch('https', hostname, port, req.url);
  if (mapLocalMatch) {
    req.on('end', () => {
      serveMapLocal(mapLocalMatch, req, res, {
        id, t0, method: req.method, fullUrl,
        host: hostname, port, path: req.url, proto: 'https',
        reqHeaders: req.headers,
        reqBuf: Buffer.concat(reqChunks),
      });
    });
    return;
  }

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

  // If SSL proxying is disabled or this host isn't in the filter list, pass through
  if (!sslProxyingAllows(hostname, port)) {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const tunnel = net.connect(port, hostname, () => {
      if (head && head.length) tunnel.write(head);
      clientSocket.pipe(tunnel);
      tunnel.pipe(clientSocket);
    });
    tunnel.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => tunnel.destroy());
    return;
  }

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

// ─── HTTP Proxy Server (port 9999) ────────────────────────────────────────────
function createProxy() {
  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    const id = crypto.randomUUID();

    let url;
    try { url = new URL(req.url); }
    catch { res.writeHead(400); res.end('Bad Request'); return; }

    const reqChunks  = [];

    // ── Map Remote check (HTTP) — runs before Map Local ──
    const mrMatchHttp = findMapRemoteMatch('http', url.hostname, url.port || 80, url.pathname + (url.search || ''), req.method, req.headers);
    if (mrMatchHttp) {
      const { rule } = mrMatchHttp;
      const capInfo = {
        id, t0, method: req.method, fullUrl: req.url,
        host: url.hostname, port: url.port || 80,
        path: url.pathname + (url.search || ''), proto: 'http',
        reqHeaders: req.headers,
      };
      if (rule.redirect.type === 'URL') {
        serveMapRemoteUrl(rule, req, res, capInfo);
        return;
      } else if (rule.redirect.type === 'LOCAL_FILE') {
        req.on('data', c => reqChunks.push(c));
        req.on('end', () => serveMapRemoteLocal(rule, req, res, { ...capInfo, reqBuf: Buffer.concat(reqChunks) }));
        return;
      }
    }

    // ── Map Local check (HTTP) ──
    const mapLocalMatch = findMapLocalMatch('http', url.hostname, url.port || 80, url.pathname + (url.search || ''));
    if (mapLocalMatch) {
      req.on('data', c => reqChunks.push(c));
      req.on('end', () => {
        serveMapLocal(mapLocalMatch, req, res, {
          id, t0, method: req.method, fullUrl: req.url,
          host: url.hostname, port: url.port || 80,
          path: url.pathname + (url.search || ''), proto: 'http',
          reqHeaders: req.headers,
          reqBuf: Buffer.concat(reqChunks),
        });
      });
      return;
    }

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
        if (!shouldCaptureHost(url.hostname, url.port || 80)) return;
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
      if (!shouldCaptureHost(url.hostname, url.port || 80)) return;
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

// ─── Dashboard Server (port 9000) ─────────────────────────────────────────────
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

    if (req.url === '/api/ssl-proxying' && req.method === 'GET') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sslProxying));
      return;
    }

    if (req.url === '/api/ssl-proxying' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const update = JSON.parse(body);
          if (typeof update.enabled === 'boolean') sslProxying.enabled = update.enabled;
          if (Array.isArray(update.locations))       sslProxying.locations = update.locations;
          broadcast({ type: 'ssl_proxying', data: sslProxying });
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(sslProxying));
        } catch {
          res.writeHead(400); res.end('Bad Request');
        }
      });
      return;
    }

    if (req.url === '/api/map-local' && req.method === 'GET') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mapLocal));
      return;
    }

    if (req.url === '/api/map-local' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const update = JSON.parse(body);
          if (typeof update.enabled === 'boolean') mapLocal.enabled = update.enabled;
          if (Array.isArray(update.mappings))       mapLocal.mappings = update.mappings;
          broadcast({ type: 'map_local', data: mapLocal });
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mapLocal));
        } catch {
          res.writeHead(400); res.end('Bad Request');
        }
      });
      return;
    }

    // ── Sessions ─────────────────────────────────────────────────────────────
    if (req.url === '/api/sessions' && req.method === 'GET') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessionsPayload()));
      return;
    }

    if (req.url === '/api/sessions' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let name;
        try { name = (JSON.parse(body || '{}').name || '').trim() || undefined; }
        catch { name = undefined; }
        const created = createSession(name);
        setActiveSession(created.id);
        const payload = sessionsPayload();
        broadcast({ type: 'session_list',      data: payload });
        broadcast({ type: 'session_activated', data: { ...payload, captures: captures.slice(0, 300) } });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
      return;
    }

    {
      const activateMatch = req.url.match(/^\/api\/sessions\/([^/]+)\/activate$/);
      if (activateMatch && req.method === 'POST') {
        const ok = setActiveSession(activateMatch[1]);
        if (!ok) { res.writeHead(404, cors); res.end(JSON.stringify({ error: 'Session not found' })); return; }
        const payload = sessionsPayload();
        broadcast({ type: 'session_activated', data: { ...payload, captures: captures.slice(0, 300) } });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
    }

    {
      const delMatch = req.url.match(/^\/api\/sessions\/([^/]+)$/);
      if (delMatch && req.method === 'DELETE') {
        const id = delMatch[1];
        if (id === activeSessionId) {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot delete the active session. Switch to another first.' }));
          return;
        }
        if (sessions.size <= 1) {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot delete the last remaining session.' }));
          return;
        }
        if (!sessions.has(id)) { res.writeHead(404, cors); res.end(); return; }
        sessions.delete(id);
        const payload = sessionsPayload();
        broadcast({ type: 'session_list', data: payload });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
    }

    if (req.url === '/api/map-remote' && req.method === 'GET') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mapRemotePayload()));
      return;
    }

    if (req.url === '/api/map-remote' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const update = JSON.parse(body);
          if (typeof update.enabled === 'boolean') mapRemote.enabled = update.enabled;
          if (Array.isArray(update.rules)) {
            // Normalize rules: ensure id + timestamps + defaults
            mapRemote.rules = update.rules.map(r => {
              const now = new Date().toISOString();
              return {
                id:           r.id || crypto.randomUUID(),
                name:         r.name || 'Map Remote',
                description:  r.description || '',
                enabled:      r.enabled !== false,
                conditions:   Array.isArray(r.conditions) ? r.conditions : [],
                redirect:     r.redirect || { type: 'URL', target: '', preservePath: true, preserveQuery: true, preserveMethod: true, preserveHeaders: true, preserveBody: true },
                createdAt:    r.createdAt || now,
                updatedAt:    now,
              };
            });
            // Drop stats for rules that no longer exist
            const liveIds = new Set(mapRemote.rules.map(r => r.id));
            for (const k of [...mapRemoteStats.keys()]) {
              if (!liveIds.has(k)) mapRemoteStats.delete(k);
            }
          }
          const payload = mapRemotePayload();
          broadcast({ type: 'map_remote', data: payload });
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        } catch {
          res.writeHead(400); res.end('Bad Request');
        }
      });
      return;
    }

    // Test a single condition against a sample URL/request (for the "flask" UI panel)
    if (req.url === '/api/map-remote/test' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const sampleUrl = payload.url || '';
          const method    = (payload.method || 'GET').toUpperCase();
          const headers   = payload.headers || {};
          const cond      = payload.condition || null;
          if (!cond) { res.writeHead(400); res.end('Missing condition'); return; }
          const u = new URL(sampleUrl);
          const proto = u.protocol.replace(':', '');
          const port  = u.port ? parseInt(u.port) : (proto === 'https' ? 443 : 80);
          const ctx = buildRequestContext(proto, u.hostname, port, u.pathname + (u.search || ''), method, headers);
          const matched = evaluateCondition(cond, ctx);
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ matched, context: ctx }));
        } catch (e) {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // File browser for Map Local — lists directory contents
    if (req.url.startsWith('/api/browse')) {
      const parsed = new URL(req.url, 'http://localhost');
      let dir = parsed.searchParams.get('path') || '';

      // Default starting directory
      if (!dir) {
        dir = process.platform === 'win32'
          ? process.env.USERPROFILE || 'C:\\'
          : process.env.HOME || '/';
      }

      // Resolve to absolute
      dir = path.resolve(dir);

      fs.stat(dir, (err, stat) => {
        if (err) {
          res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Path not found', path: dir }));
          return;
        }

        // If it's a file, return it as the selected file
        if (!stat.isDirectory()) {
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: dir, isFile: true }));
          return;
        }

        fs.readdir(dir, { withFileTypes: true }, (err2, entries) => {
          if (err2) {
            res.writeHead(403, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Cannot read directory', path: dir }));
            return;
          }

          const parent = path.dirname(dir);
          const items = entries
            .filter(e => !e.name.startsWith('.'))
            .map(e => ({
              name: e.name,
              isDir: e.isDirectory(),
              path: path.join(dir, e.name),
            }))
            .sort((a, b) => {
              if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
              return a.name.localeCompare(b.name);
            });

          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: dir, parent: parent !== dir ? parent : null, items }));
        });
      });
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

    // Cache-replay route: /<host>/<path>?<query>
    // Serves a previously captured JSON response back at an origin-matching URL,
    // e.g. http://<ip>:9000/www.kroger.com/all/coupons?couponid=600 replays the
    // last GET capture for that exact URL. Only engages when the first path
    // segment contains a dot AND at least one capture has that host — so it
    // never shadows the dashboard's own static assets (app.js, etc.).
    {
      const cm = req.url.match(/^\/([^/?#]+)(\/[^?#]*)?(\?.*)?$/);
      if (cm && req.method === 'GET') {
        const host = decodeURIComponent(cm[1]);
        if (host.includes('.') && captures.some(c => c.host === host)) {
          const pq = (cm[2] || '/') + (cm[3] || '');
          const cached = findCachedResponse(host, pq);
          if (cached) {
            res.writeHead(200, {
              ...cors,
              'Content-Type':      cached.contentType || 'application/json; charset=utf-8',
              'X-Cached-From':     cached.url,
              'X-Cached-At':       new Date(cached.ts).toISOString(),
              'X-Cache-Id':        cached.id,
              'X-Cache-Truncated': cached.resBodyTrunc ? 'true' : 'false',
              'Cache-Control':     'no-store',
            });
            res.end(cached.resBody || '');
          } else {
            res.writeHead(404, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              error: 'No cached response for that URL',
              host,
              path: pq,
              hint:  'Send this request through the proxy at least once; the JSON response will then be served here.',
            }, null, 2));
          }
          return;
        }
      }
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
    sessions:  sessionsPayload(),
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

// Normal bootstrap — used by both the CLI and the Electron main process.
function startApp({ proxyPort = PROXY_PORT, dashPort = DASHBOARD_PORT, quiet = false } = {}) {
  return new Promise((resolve) => {
    let proxyReady = false, dashReady = false;
    const maybeResolve = () => {
      if (proxyReady && dashReady) resolve({ proxy, dashboard, wss, proxyPort, dashPort });
    };

    listenWithRetry(proxy, proxyPort, 'Proxy', () => {
      proxyReady = true;
      if (!quiet) {
        const ips = getLocalIPs();
        console.log(`
╔═══════════════════════════════════════════════╗
║        APIWebProxy  —  Phase 2  (HTTP+HTTPS)   ║
╠═══════════════════════════════════════════════╣
║  Proxy     :  0.0.0.0:${proxyPort}                    ║
║  Dashboard :  http://localhost:${dashPort}          ║
║  CA cert   :  http://localhost:${dashPort}/ca.crt   ║
╠═══════════════════════════════════════════════╣
║  1. Set device WiFi proxy → ${(ips[0]||'localhost')+':'+proxyPort}
║  2. Visit http://localhost:${dashPort}/ca.crt to install CA
╚═══════════════════════════════════════════════╝
`);
      }
      maybeResolve();
    });

    listenWithRetry(dashboard, dashPort, 'Dashboard', () => {
      dashReady = true;
      if (!quiet) console.log(`Dashboard → http://localhost:${dashPort}\n`);
      maybeResolve();
    });
  });
}

if (require.main === module) {
  startApp({ proxyPort: PROXY_PORT, dashPort: DASHBOARD_PORT });
}

// Exported for tests and the Electron main process
module.exports = {
  start: startApp,
  evaluateCondition,
  buildRequestContext,
  composeRedirectUrl,
  findMapRemoteMatch,
  // mutable state handles for tests
  _setMapRemote: (next) => {
    mapRemote.enabled = !!next.enabled;
    mapRemote.rules   = Array.isArray(next.rules) ? next.rules : [];
  },
  _getMapRemote: () => mapRemote,
  // Start the servers on chosen ports (used by integration test)
  _startForTest: ({ proxyPort, dashPort } = {}) => {
    return new Promise((resolve) => {
      const handles = { proxy, dashboard };
      let ready = 0;
      const done = () => { if (++ready === 2) resolve(handles); };
      proxy.listen(proxyPort || 0, '127.0.0.1', done);
      dashboard.listen(dashPort || 0, '127.0.0.1', done);
    });
  },
  _stopForTest: () => new Promise(resolve => {
    let n = 0;
    const done = () => { if (++n === 2) resolve(); };
    proxy.close(done);
    dashboard.close(done);
    for (const client of wss.clients) { try { client.terminate(); } catch {} }
  }),
};
