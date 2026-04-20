'use strict';

// Tests use Node's built-in test runner (no new dependencies).
// Run with: npm test   (or: node --test test/)

const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const proxyModule = require('../server');
const {
  evaluateCondition,
  buildRequestContext,
  composeRedirectUrl,
  findMapRemoteMatch,
  _setMapRemote,
  _startForTest,
  _stopForTest,
} = proxyModule;

// ─── Condition evaluator — field × operator matrix ─────────────────────────
test('evaluateCondition — URL contains', () => {
  const ctx = buildRequestContext('https', 'api.example.com', 443, '/v1/users?id=1', 'GET', {});
  assert.equal(evaluateCondition({ field: 'URL', operator: 'CONTAINS', value: 'example.com' }, ctx), true);
  assert.equal(evaluateCondition({ field: 'URL', operator: 'CONTAINS', value: 'nope' },        ctx), false);
});

test('evaluateCondition — HOST equals / case insensitive by default', () => {
  const ctx = buildRequestContext('https', 'API.example.com', 443, '/', 'GET', {});
  assert.equal(evaluateCondition({ field: 'HOST', operator: 'EQUALS', value: 'api.example.com' }, ctx), true);
  assert.equal(evaluateCondition({ field: 'HOST', operator: 'EQUALS', value: 'api.example.com', caseSensitive: true }, ctx), false);
});

test('evaluateCondition — PATH starts_with / ends_with', () => {
  const ctx = buildRequestContext('https', 'h', 443, '/api/v1/users', 'GET', {});
  assert.equal(evaluateCondition({ field: 'PATH', operator: 'STARTS_WITH', value: '/api' },   ctx), true);
  assert.equal(evaluateCondition({ field: 'PATH', operator: 'ENDS_WITH',   value: 'users' },  ctx), true);
  assert.equal(evaluateCondition({ field: 'PATH', operator: 'STARTS_WITH', value: '/v2' },    ctx), false);
});

test('evaluateCondition — METHOD equals', () => {
  const ctx = buildRequestContext('https', 'h', 443, '/', 'POST', {});
  assert.equal(evaluateCondition({ field: 'METHOD', operator: 'EQUALS', value: 'POST' }, ctx), true);
  assert.equal(evaluateCondition({ field: 'METHOD', operator: 'EQUALS', value: 'GET'  }, ctx), false);
});

test('evaluateCondition — QUERY contains', () => {
  const ctx = buildRequestContext('https', 'h', 443, '/?foo=bar&baz=qux', 'GET', {});
  assert.equal(evaluateCondition({ field: 'QUERY', operator: 'CONTAINS', value: 'foo=bar' }, ctx), true);
  assert.equal(evaluateCondition({ field: 'QUERY', operator: 'CONTAINS', value: 'missing' }, ctx), false);
});

test('evaluateCondition — HEADER requires headerName + matches', () => {
  const ctx = buildRequestContext('https', 'h', 443, '/', 'GET', { 'X-Env': 'staging' });
  assert.equal(evaluateCondition({ field: 'HEADER', operator: 'EQUALS', value: 'staging', headerName: 'x-env' }, ctx), true);
  assert.equal(evaluateCondition({ field: 'HEADER', operator: 'EQUALS', value: 'staging' }, ctx), false, 'missing headerName = no match');
  assert.equal(evaluateCondition({ field: 'HEADER', operator: 'CONTAINS', value: 'stag', headerName: 'X-ENV' }, ctx), true, 'case-insensitive header lookup');
});

test('evaluateCondition — MATCHES_REGEX with invalid regex = no match, no throw', () => {
  const ctx = buildRequestContext('https', 'h', 443, '/users/123', 'GET', {});
  assert.equal(evaluateCondition({ field: 'PATH', operator: 'MATCHES_REGEX', value: '/users/\\d+' }, ctx), true);
  assert.equal(evaluateCondition({ field: 'PATH', operator: 'MATCHES_REGEX', value: '[invalid(' }, ctx), false);
});

test('evaluateCondition — case sensitivity', () => {
  const ctx = buildRequestContext('https', 'h', 443, '/Users', 'GET', {});
  assert.equal(evaluateCondition({ field: 'PATH', operator: 'CONTAINS', value: 'users' }, ctx), true);
  assert.equal(evaluateCondition({ field: 'PATH', operator: 'CONTAINS', value: 'users', caseSensitive: true }, ctx), false);
});

test('evaluateCondition — EQUALS allows empty-string intent', () => {
  const ctx = buildRequestContext('https', 'h', 443, '/', 'GET', {});
  assert.equal(evaluateCondition({ field: 'QUERY', operator: 'EQUALS', value: '' }, ctx), true, 'no query → empty matches empty');
});

// ─── URL composition ──────────────────────────────────────────────────────
test('composeRedirectUrl — preservePath=true, preserveQuery=true', () => {
  const out = composeRedirectUrl(
    'https://api.prod.com/v1/users/123?foo=bar',
    { type: 'URL', target: 'https://api.dev.com', preservePath: true, preserveQuery: true }
  );
  assert.equal(out.fullUrl, 'https://api.dev.com/v1/users/123?foo=bar');
});

test('composeRedirectUrl — preservePath=false, preserveQuery=true', () => {
  const out = composeRedirectUrl(
    'https://api.prod.com/v1/users/123?foo=bar',
    { type: 'URL', target: 'https://api.dev.com', preservePath: false, preserveQuery: true }
  );
  assert.equal(out.fullUrl, 'https://api.dev.com/?foo=bar');
});

test('composeRedirectUrl — preservePath=true, preserveQuery=false', () => {
  const out = composeRedirectUrl(
    'https://api.prod.com/v1/users/123?foo=bar',
    { type: 'URL', target: 'https://api.dev.com', preservePath: true, preserveQuery: false }
  );
  assert.equal(out.fullUrl, 'https://api.dev.com/v1/users/123');
});

test('composeRedirectUrl — target has path prefix → concatenate and dedupe slash', () => {
  const out = composeRedirectUrl(
    'https://api.prod.com/v1/users/123',
    { type: 'URL', target: 'https://api.dev.com/prefix/', preservePath: true, preserveQuery: false }
  );
  // trailing slash on target is trimmed before concatenation
  assert.equal(out.fullUrl, 'https://api.dev.com/prefix/v1/users/123');
});

test('composeRedirectUrl — target has query; preserveQuery merges (target wins on conflict)', () => {
  const out = composeRedirectUrl(
    'https://api.prod.com/x?foo=orig&keep=1',
    { type: 'URL', target: 'https://api.dev.com/?foo=override', preservePath: true, preserveQuery: true }
  );
  const u = new URL(out.fullUrl);
  assert.equal(u.searchParams.get('foo'),  'override', 'target param wins on conflict');
  assert.equal(u.searchParams.get('keep'), '1',        'non-conflicting original param is preserved');
});

test('composeRedirectUrl — HTTPS→HTTP crossover is allowed (caller decides protocol)', () => {
  const out = composeRedirectUrl(
    'https://secure.example.com/api',
    { type: 'URL', target: 'http://plain.example.com', preservePath: true, preserveQuery: true }
  );
  assert.equal(out.protocol, 'http');
  assert.equal(out.hostname, 'plain.example.com');
  assert.equal(out.port, 80);
});

test('composeRedirectUrl — target with explicit non-default port', () => {
  const out = composeRedirectUrl(
    'https://a.com/foo',
    { type: 'URL', target: 'http://dev.local:3000', preservePath: true, preserveQuery: true }
  );
  assert.equal(out.port, 3000);
  assert.equal(out.fullUrl, 'http://dev.local:3000/foo');
});

// ─── findMapRemoteMatch — first match wins; disabled rules skipped ────────
test('findMapRemoteMatch — first match wins, disabled rules are skipped', () => {
  _setMapRemote({
    enabled: true,
    rules: [
      { id: 'a', name: 'A', enabled: false,
        conditions: [{ field: 'HOST', operator: 'EQUALS', value: 'api.example.com' }],
        redirect: { type: 'URL', target: 'https://first.com' } },
      { id: 'b', name: 'B', enabled: true,
        conditions: [{ field: 'HOST', operator: 'EQUALS', value: 'api.example.com' }],
        redirect: { type: 'URL', target: 'https://second.com' } },
      { id: 'c', name: 'C', enabled: true,
        conditions: [{ field: 'HOST', operator: 'EQUALS', value: 'api.example.com' }],
        redirect: { type: 'URL', target: 'https://third.com' } },
    ],
  });
  const m = findMapRemoteMatch('https', 'api.example.com', 443, '/', 'GET', {});
  assert.ok(m);
  assert.equal(m.rule.id, 'b');
});

test('findMapRemoteMatch — all conditions must match (AND)', () => {
  _setMapRemote({
    enabled: true,
    rules: [{
      id: 'r', name: 'r', enabled: true,
      conditions: [
        { field: 'HOST',   operator: 'EQUALS', value: 'api.example.com' },
        { field: 'METHOD', operator: 'EQUALS', value: 'POST' },
      ],
      redirect: { type: 'URL', target: 'https://x' },
    }],
  });
  assert.equal(findMapRemoteMatch('https', 'api.example.com', 443, '/', 'GET',  {}), null);
  assert.ok  (findMapRemoteMatch('https', 'api.example.com', 443, '/', 'POST', {}));
});

test('findMapRemoteMatch — nothing matches when master toggle is off', () => {
  _setMapRemote({
    enabled: false,
    rules: [{ id: 'r', enabled: true,
      conditions: [{ field: 'HOST', operator: 'EQUALS', value: 'a.com' }],
      redirect: { type: 'URL', target: 'https://x' } }],
  });
  assert.equal(findMapRemoteMatch('https', 'a.com', 443, '/', 'GET', {}), null);
});

// ─── Integration: real HTTP round-trip through the proxy ──────────────────
// Spins up: upstream server → proxy (map-remote redirects to upstream) → client
test('integration — HTTP proxy rewrites URL and forwards to new host', async () => {
  // Upstream A: default, should never be hit (the thing being rewritten away)
  const upstreamA = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('from-A');
  });
  await new Promise(r => upstreamA.listen(0, '127.0.0.1', r));
  const portA = upstreamA.address().port;

  // Upstream B: the redirect target
  let receivedHost = '';
  let receivedUrl  = '';
  const upstreamB = http.createServer((req, res) => {
    receivedHost = req.headers.host;
    receivedUrl  = req.url;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('from-B');
  });
  await new Promise(r => upstreamB.listen(0, '127.0.0.1', r));
  const portB = upstreamB.address().port;

  // Configure Map Remote: any request to 127.0.0.1:portA → rewrite to 127.0.0.1:portB
  _setMapRemote({
    enabled: true,
    rules: [{
      id: 'integ-1', name: 'integ-1', enabled: true,
      conditions: [
        { field: 'HOST', operator: 'EQUALS', value: '127.0.0.1' },
        { field: 'PATH', operator: 'STARTS_WITH', value: '/alpha' },
      ],
      redirect: {
        type: 'URL',
        target: `http://127.0.0.1:${portB}`,
        preservePath: true, preserveQuery: true,
        preserveMethod: true, preserveHeaders: true, preserveBody: true,
      },
    }],
  });

  const handles = await _startForTest();
  const proxyPort = handles.proxy.address().port;

  // Client sends a request to upstreamA via the proxy — should be rewritten to upstreamB
  const body = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: `http://127.0.0.1:${portA}/alpha/hello?x=1`,
      headers: { Host: `127.0.0.1:${portA}` },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end',  () => resolve({ body: buf, headers: res.headers, status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(body.status, 200);
  assert.equal(body.body, 'from-B', 'request must be rewritten to upstream B');
  assert.equal(receivedUrl, '/alpha/hello?x=1', 'path + query preserved on upstream B');
  assert.ok(receivedHost.includes(String(portB)), 'Host header was rewritten to point at B');
  assert.equal(body.headers['x-map-remote-rule'], 'integ-1');

  await _stopForTest();
  await new Promise(r => upstreamA.close(r));
  await new Promise(r => upstreamB.close(r));
});

test('integration — LOCAL_FILE redirect serves file with inferred content-type', async () => {
  const tmp = path.join(os.tmpdir(), `mr-test-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ hello: 'world' }));

  _setMapRemote({
    enabled: true,
    rules: [{
      id: 'loc-1', name: 'loc-1', enabled: true,
      conditions: [{ field: 'PATH', operator: 'STARTS_WITH', value: '/api/mock' }],
      redirect: { type: 'LOCAL_FILE', filePath: tmp },
    }],
  });

  const handles = await _startForTest();
  const proxyPort = handles.proxy.address().port;

  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: `http://example.invalid/api/mock/users`,
      headers: { Host: 'example.invalid' },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end',  () => resolve({ body: buf, headers: res.headers, status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(result.status, 200);
  assert.ok(result.headers['content-type'].includes('application/json'));
  assert.equal(JSON.parse(result.body).hello, 'world');
  assert.equal(result.headers['x-map-remote-file'], tmp);

  await _stopForTest();
  fs.unlinkSync(tmp);
});

test('integration — loop prevention: rewritten request does not re-enter the proxy', async () => {
  // Setup: a rule that rewrites any request whose host is 127.0.0.1 to a specific upstream.
  // The proxy fires the outbound request directly (not through itself), so a single "hop"
  // must happen — no infinite recursion.
  let upstreamHitCount = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHitCount += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('once');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  _setMapRemote({
    enabled: true,
    rules: [{
      id: 'loop-1', name: 'loop-1', enabled: true,
      conditions: [{ field: 'HOST', operator: 'EQUALS', value: '127.0.0.1' }],
      redirect: {
        type: 'URL',
        target: `http://127.0.0.1:${upstreamPort}`,
        preservePath: true, preserveQuery: true,
        preserveMethod: true, preserveHeaders: true, preserveBody: true,
      },
    }],
  });

  const handles = await _startForTest();
  const proxyPort = handles.proxy.address().port;

  await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: `http://127.0.0.1:9999/some/path`,
      headers: { Host: '127.0.0.1:9999' },
    }, res => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(upstreamHitCount, 1, 'upstream must be hit exactly once — no re-evaluation');

  await _stopForTest();
  await new Promise(r => upstream.close(r));
});
