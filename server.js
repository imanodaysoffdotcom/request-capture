#!/usr/bin/env node
'use strict';

// ============================================================================
// Request Capture Platform — Zero-dependency Node.js server
// Capture server on :8080, View server on :8081
// ============================================================================

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CAPTURE_PORT = 8080;
const VIEW_PORT = 8081;
const MAX_EVENTS = 5000;
const LOG_DIR = path.join(__dirname, 'logs');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let seq = 0;
let connSeq = 0;
const events = [];                       // ring buffer
const sessions = new Map();              // session_id -> { events[], key }
const fallbackToSession = new Map();     // fallback_key -> session_id
const sseClients = new Set();            // SSE response objects

// 1x1 transparent PNG
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(n) {
  return crypto.randomBytes(n).toString('hex');
}

function hashKey(ip, ua) {
  return crypto.createHash('sha256').update(ip + '|' + (ua || '')).digest('hex').slice(0, 16);
}

function rawHeadersToTuples(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    out.push([raw[i], raw[i + 1]]);
  }
  return out;
}

function getHeader(tuples, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of tuples) {
    if (k.toLowerCase() === lower) return v;
  }
  return '';
}

function mimeForExt(ext) {
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.css': 'text/css',
    '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.webmanifest': 'application/manifest+json',
    '.html': 'text/html',
    '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
    '.json': 'application/json',
  };
  return map[ext] || 'application/octet-stream';
}

function noCache(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  // Explicitly suppress ETag and Last-Modified
}

function pushEvent(ev) {
  if (events.length >= MAX_EVENTS) events.shift();
  events.push(ev);

  // Per-session store
  let sess = sessions.get(ev.session_id);
  if (!sess) {
    sess = { events: [], key: ev.session_key };
    sessions.set(ev.session_id, sess);
  }
  sess.events.push(ev);

  // Persist to JSONL
  const logFile = path.join(LOG_DIR, ev.session_id + '.jsonl');
  fs.appendFile(logFile, JSON.stringify(ev) + '\n', () => {});

  // Stdout summary
  console.log(`${ev.seq} ${ev.conn_id} ${ev.method} ${ev.url} ${ev.response.status} ${ev.dest || '-'}`);

  // SSE broadcast
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const client of sseClients) {
    try { client.write(data); } catch (_) { sseClients.delete(client); }
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

function resolveSession(req, remoteIp, headerTuples) {
  const cookieHeader = getHeader(headerTuples, 'cookie');
  let sid = '';
  if (cookieHeader) {
    const m = cookieHeader.match(/echo_sid=([a-f0-9]+)/);
    if (m) sid = m[1];
  }

  const ua = getHeader(headerTuples, 'user-agent');
  const fbKey = hashKey(remoteIp, ua);
  let needsSet = false;

  if (sid && sessions.has(sid)) {
    // Known session
  } else if (sid) {
    // Cookie present but unknown session — register it
    sessions.set(sid, { events: [], key: fbKey });
    fallbackToSession.set(fbKey, sid);
  } else if (fallbackToSession.has(fbKey)) {
    sid = fallbackToSession.get(fbKey);
  } else {
    // Brand new session
    sid = genId(4); // 8 hex chars
    sessions.set(sid, { events: [], key: fbKey });
    fallbackToSession.set(fbKey, sid);
    needsSet = true;
  }

  return { session_id: sid, session_key: fbKey, needsSet };
}

// ---------------------------------------------------------------------------
// /full test page
// ---------------------------------------------------------------------------

const FULL_HTML = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Full Capture Test</title>
<link rel="icon" href="/icons/fav.png">
<link rel="apple-touch-icon" href="/icons/apple.png">
<link rel="manifest" href="/m.webmanifest">
<link rel="preload" as="script" href="/js/preloaded.js">
<link rel="prefetch" href="/pf/next.html">
<link rel="modulepreload" href="/js/mp.mjs">
<link rel="preconnect" href="http://127.0.0.1:8080">
<link rel="dns-prefetch" href="http://127.0.0.1:8080">
<link rel="stylesheet" href="/css/a.css">
</head><body>
<h1>Request Capture Test</h1>
<p class="font-test">Font test text</p>
<div class="bg-test" style="width:100px;height:100px"></div>
<img src="/img/plain.png" alt="plain">
<img srcset="/img/1x.png 1x, /img/2x.png 2x" alt="srcset">
<picture><source srcset="/img/src.webp" type="image/webp"><img src="/img/fallback.png" alt="picture"></picture>
<video poster="/img/poster.png" src="/media/v.mp4" preload="metadata" width="1" height="1"></video>
<audio src="/media/a.mp3" preload="auto"></audio>
<iframe src="/bare" width="1" height="1"></iframe>
<object data="/obj/o.svg" width="1" height="1"></object>
<embed src="/emb/e.svg" width="1" height="1">
<input type="image" src="/img/btn.png" alt="btn" width="1" height="1">
<script src="/js/classic.js"></script>
<script type="module" src="/js/main.mjs"></script>
<script src="/js/preloaded.js"></script>
<a id="ping" href="/clicked" ping="/api/ping" target="_blank">Ping Link</a>
<form id="f" method="post" action="/api/form" target="_blank">
  <input type="text" name="field" value="test">
  <button type="submit">Submit</button>
</form>
<script>
window.addEventListener('load', () => {
  fetch('/api/fetch', {method:'POST', headers:{'content-type':'application/json'}, body:'{"k":1}'});
  const xhr = new XMLHttpRequest(); xhr.open('GET','/api/xhr'); xhr.send();
  navigator.sendBeacon('/api/beacon','b=1');
  fetch('http://127.0.0.1:8080/api/cors', {method:'PUT', headers:{'X-Custom':'1'}});
  try { const ws = new WebSocket('ws://localhost:8080/ws'); ws.onopen = () => setTimeout(() => ws.close(), 2000); } catch(e) {}
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
});
</script>
</body></html>`;

const BARE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>bare</title></head><body><p>bare</p></body></html>';

// ---------------------------------------------------------------------------
// Expected requests for /full
// ---------------------------------------------------------------------------

const EXPECTED_REQUESTS = [
  { url: '/full', method: 'GET', desc: 'Main page' },
  { url: '/icons/fav.png', method: 'GET', desc: 'Favicon' },
  { url: '/icons/apple.png', method: 'GET', desc: 'Apple touch icon' },
  { url: '/m.webmanifest', method: 'GET', desc: 'Web manifest' },
  { url: '/js/preloaded.js', method: 'GET', desc: 'Preloaded script' },
  { url: '/pf/next.html', method: 'GET', desc: 'Prefetched page' },
  { url: '/js/mp.mjs', method: 'GET', desc: 'Module-preloaded script' },
  { url: '/css/a.css', method: 'GET', desc: 'Main stylesheet' },
  { url: '/css/b.css', method: 'GET', desc: 'Imported stylesheet' },
  { url: '/img/bg.png', method: 'GET', desc: 'CSS background image' },
  { url: '/fonts/f.woff2', method: 'GET', desc: 'CSS font' },
  { url: '/img/plain.png', method: 'GET', desc: 'Plain img' },
  { url: '/img/1x.png', method: 'GET', desc: 'srcset 1x image' },
  { url: '/img/2x.png', method: 'GET', desc: 'srcset 2x image' },
  { url: '/img/src.webp', method: 'GET', desc: 'picture source webp' },
  { url: '/img/fallback.png', method: 'GET', desc: 'picture fallback img' },
  { url: '/img/poster.png', method: 'GET', desc: 'Video poster' },
  { url: '/media/v.mp4', method: 'GET', desc: 'Video source' },
  { url: '/media/a.mp3', method: 'GET', desc: 'Audio source' },
  { url: '/bare', method: 'GET', desc: 'Iframe page' },
  { url: '/obj/o.svg', method: 'GET', desc: 'Object SVG' },
  { url: '/emb/e.svg', method: 'GET', desc: 'Embed SVG' },
  { url: '/img/btn.png', method: 'GET', desc: 'Input image' },
  { url: '/js/classic.js', method: 'GET', desc: 'Classic script' },
  { url: '/js/main.mjs', method: 'GET', desc: 'Module script entry' },
  { url: '/js/dep.mjs', method: 'GET', desc: 'Module dependency' },
  { url: '/api/fetch', method: 'POST', desc: 'Fetch API call' },
  { url: '/api/xhr', method: 'GET', desc: 'XMLHttpRequest' },
  { url: '/api/beacon', method: 'POST', desc: 'sendBeacon' },
  { url: '/api/cors', method: 'OPTIONS', desc: 'CORS preflight' },
  { url: '/api/cors', method: 'PUT', desc: 'CORS actual request' },
  { url: '/ws', method: 'GET', desc: 'WebSocket upgrade' },
  { url: '/sw.js', method: 'GET', desc: 'Service worker' },
];

// ---------------------------------------------------------------------------
// CSS with sub-resources
// ---------------------------------------------------------------------------

const CSS_A = `@import url(/css/b.css);
.bg-test { background-image: url(/img/bg.png); }
@font-face { font-family: 'TestFont'; src: url(/fonts/f.woff2) format('woff2'); }
.font-test { font-family: 'TestFont', sans-serif; }`;

const CSS_B = `/* b.css */ body { margin: 0; }`;

// ---------------------------------------------------------------------------
// Capture server request handler
// ---------------------------------------------------------------------------

function handleCaptureRequest(req, res, connId) {
  const startTime = Date.now();
  const headerTuples = rawHeadersToTuples(req.rawHeaders);
  const remoteIp = req.socket.remoteAddress || '127.0.0.1';
  const remotePort = req.socket.remotePort || 0;
  const httpVersion = req.httpVersion;
  const host = getHeader(headerTuples, 'host') || `localhost:${CAPTURE_PORT}`;
  const urlPath = req.url || '/';
  const method = req.method;

  // Session
  const sessInfo = resolveSession(req, remoteIp, headerTuples);

  // Collect body
  const bodyChunks = [];
  req.on('data', (chunk) => bodyChunks.push(chunk));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(bodyChunks);
    const bodyStr = bodyBuf.toString('utf8');

    // Set cookie if needed
    if (sessInfo.needsSet) {
      res.setHeader('Set-Cookie', `echo_sid=${sessInfo.session_id}; Path=/; SameSite=Lax`);
    }

    noCache(res);

    // Route and respond
    const respInfo = routeCapture(req, res, method, urlPath, headerTuples, bodyStr, sessInfo);

    // Build event
    const ev = {
      seq: ++seq,
      ts: new Date().toISOString(),
      conn_id: connId,
      session_id: sessInfo.session_id,
      session_key: sessInfo.session_key,
      method,
      url: urlPath,
      http_version: httpVersion,
      host,
      headers: headerTuples,
      remote_ip: remoteIp,
      remote_port: remotePort,
      body: {
        encoding: 'utf8',
        bytes: bodyBuf.length,
        data: bodyStr.slice(0, 10000),
      },
      response: {
        status: respInfo.status,
        content_type: respInfo.contentType,
        bytes: respInfo.bytes,
      },
      aborted: req.destroyed,
      duration_ms: Date.now() - startTime,
      // promoted fields
      dest: getHeader(headerTuples, 'sec-fetch-dest'),
      mode: getHeader(headerTuples, 'sec-fetch-mode'),
      site: getHeader(headerTuples, 'sec-fetch-site'),
      referer: getHeader(headerTuples, 'referer'),
      accept: getHeader(headerTuples, 'accept'),
      has_cookie: !!getHeader(headerTuples, 'cookie'),
      priority: getHeader(headerTuples, 'priority'),
      purpose: getHeader(headerTuples, 'purpose') || getHeader(headerTuples, 'x-purpose'),
      sec_ch_ua: getHeader(headerTuples, 'sec-ch-ua'),
      user_agent: getHeader(headerTuples, 'user-agent'),
    };

    pushEvent(ev);
  });

  req.on('error', () => {});
}

// ---------------------------------------------------------------------------
// Routing logic for capture server
// ---------------------------------------------------------------------------

function routeCapture(req, res, method, urlPath, headerTuples, bodyStr, sessInfo) {
  const parsedUrl = new URL(urlPath, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const ext = path.extname(pathname).toLowerCase();
  const dest = getHeader(headerTuples, 'sec-fetch-dest');
  const accept = getHeader(headerTuples, 'accept');

  // --- Special routes ---

  if (pathname === '/bare' && method === 'GET') {
    return sendResponse(res, 200, 'text/html; charset=utf-8', BARE_HTML);
  }

  if (pathname === '/full' && method === 'GET') {
    return sendResponse(res, 200, 'text/html; charset=utf-8', FULL_HTML);
  }

  if (pathname === '/full.expected.json' && method === 'GET') {
    return sendResponse(res, 200, 'application/json', JSON.stringify(EXPECTED_REQUESTS, null, 2));
  }

  if (pathname === '/sw.js') {
    return sendResponse(res, 200, 'text/javascript', '// empty service worker\nself.addEventListener("fetch", () => {});\n');
  }

  if (pathname === '/css/a.css') {
    return sendResponse(res, 200, 'text/css', CSS_A);
  }

  if (pathname === '/css/b.css') {
    return sendResponse(res, 200, 'text/css', CSS_B);
  }

  if (pathname === '/js/main.mjs') {
    return sendResponse(res, 200, 'text/javascript', "import '/js/dep.mjs';");
  }

  if (pathname === '/js/mp.mjs') {
    return sendResponse(res, 200, 'text/javascript', 'export default 1;');
  }

  if (pathname === '/js/dep.mjs') {
    return sendResponse(res, 200, 'text/javascript', 'export default 2;');
  }

  // --- WebSocket upgrade handled elsewhere ---

  // --- /api/* routes ---
  if (pathname.startsWith('/api/')) {
    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8080');
      res.setHeader('Access-Control-Allow-Methods', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Max-Age', '0');
      const jsonBody = JSON.stringify({
        method, url: urlPath, headers: rawHeadersToTuples(req.rawHeaders),
        body: bodyStr, echo: true,
      });
      return sendResponse(res, 200, 'application/json', jsonBody);
    }

    // Non-OPTIONS API
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8080');
    const jsonBody = JSON.stringify({
      method, url: urlPath, headers: rawHeadersToTuples(req.rawHeaders),
      body: bodyStr, echo: true,
    });
    return sendResponse(res, 200, 'application/json', jsonBody);
  }

  // --- File extension rules ---

  // CSS
  if (ext === '.css' || dest === 'style') {
    return sendResponse(res, 200, 'text/css', '/* echo */');
  }

  // JavaScript
  if (ext === '.js' || ext === '.mjs' || dest === 'script') {
    return sendResponse(res, 200, 'text/javascript', '/* echo */');
  }

  // Images
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico'].includes(ext) || dest === 'image') {
    const ct = mimeForExt(ext || '.png');
    res.setHeader('Content-Type', ct);
    res.writeHead(200);
    res.end(PIXEL_PNG);
    return { status: 200, contentType: ct, bytes: PIXEL_PNG.length };
  }

  // SVG
  if (ext === '.svg') {
    return sendResponse(res, 200, 'image/svg+xml', EMPTY_SVG);
  }

  // Fonts
  if (['.woff2', '.woff', '.ttf'].includes(ext) || dest === 'font') {
    const ct = mimeForExt(ext || '.woff2');
    res.writeHead(204, { 'Content-Type': ct });
    res.end();
    return { status: 204, contentType: ct, bytes: 0 };
  }

  // Web manifest
  if (ext === '.webmanifest' || dest === 'manifest') {
    return sendResponse(res, 200, 'application/manifest+json', '{}');
  }

  // HTML
  if (ext === '.html') {
    return sendResponse(res, 200, 'text/html', '<!doctype html><title>echo</title>');
  }

  // Media — serve the pixel PNG as stand-in (browsers won't decode but won't error)
  if (['.mp4', '.mp3', '.ogg', '.wav'].includes(ext) || dest === 'video' || dest === 'audio') {
    const ct = mimeForExt(ext || '.mp4');
    res.setHeader('Content-Type', ct);
    // Send an empty body with 200 so the request completes
    res.writeHead(200);
    res.end(Buffer.alloc(0));
    return { status: 200, contentType: ct, bytes: 0 };
  }

  // Default
  return sendResponse(res, 200, 'text/plain', 'ok');
}

function sendResponse(res, status, contentType, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.setHeader('Content-Type', contentType);
  res.writeHead(status);
  res.end(buf);
  return { status, contentType, bytes: buf.length };
}

// ---------------------------------------------------------------------------
// WebSocket handshake
// ---------------------------------------------------------------------------

function handleWebSocketUpgrade(req, socket, head) {
  const headerTuples = rawHeadersToTuples(req.rawHeaders);
  const key = getHeader(headerTuples, 'sec-websocket-key');
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC85B178')
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n');

  socket.write(responseHeaders);

  // Resolve session info for the WS event
  const remoteIp = socket.remoteAddress || '127.0.0.1';
  const sessInfo = resolveSession(req, remoteIp, headerTuples);
  const connId = socket.__connId || 'c?';

  // Log as event
  const ev = {
    seq: ++seq,
    ts: new Date().toISOString(),
    conn_id: connId,
    session_id: sessInfo.session_id,
    session_key: sessInfo.session_key,
    method: 'GET',
    url: req.url,
    http_version: req.httpVersion,
    host: getHeader(headerTuples, 'host') || `localhost:${CAPTURE_PORT}`,
    headers: headerTuples,
    remote_ip: remoteIp,
    remote_port: socket.remotePort || 0,
    body: { encoding: 'utf8', bytes: 0, data: '' },
    response: { status: 101, content_type: 'websocket', bytes: 0 },
    aborted: false,
    duration_ms: 0,
    dest: getHeader(headerTuples, 'sec-fetch-dest'),
    mode: getHeader(headerTuples, 'sec-fetch-mode'),
    site: getHeader(headerTuples, 'sec-fetch-site'),
    referer: getHeader(headerTuples, 'referer'),
    accept: getHeader(headerTuples, 'accept'),
    has_cookie: !!getHeader(headerTuples, 'cookie'),
    priority: getHeader(headerTuples, 'priority'),
    purpose: getHeader(headerTuples, 'purpose') || getHeader(headerTuples, 'x-purpose'),
    sec_ch_ua: getHeader(headerTuples, 'sec-ch-ua'),
    user_agent: getHeader(headerTuples, 'user-agent'),
  };
  pushEvent(ev);

  // Send "hello" text frame
  const helloPayload = Buffer.from('hello', 'utf8');
  const frame = Buffer.alloc(2 + helloPayload.length);
  frame[0] = 0x81; // FIN + text opcode
  frame[1] = helloPayload.length;
  helloPayload.copy(frame, 2);
  socket.write(frame);

  // Close after 1 second
  setTimeout(() => {
    // Send close frame
    const closeFrame = Buffer.alloc(2);
    closeFrame[0] = 0x88; // FIN + close opcode
    closeFrame[1] = 0;
    try {
      socket.write(closeFrame);
      socket.end();
    } catch (_) {}
  }, 1000);

  socket.on('error', () => {});
}

// ---------------------------------------------------------------------------
// Capture server
// ---------------------------------------------------------------------------

const captureServer = http.createServer((req, res) => {
  const connId = req.socket.__connId || 'c?';
  handleCaptureRequest(req, res, connId);
});

captureServer.on('connection', (socket) => {
  const id = 'c' + (++connSeq);
  socket.__connId = id;
  const ip = socket.remoteAddress;
  const port = socket.remotePort;
  console.log(`[tcp] ${id} open ${ip}:${port}`);
  socket.on('close', () => {
    console.log(`[tcp] ${id} close ${ip}:${port}`);
  });
});

captureServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    handleWebSocketUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

// ---------------------------------------------------------------------------
// Dashboard HTML for view server
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Request Capture Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --dim: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --font: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font); font-size: 13px;
    background: var(--bg); color: var(--text);
    padding: 16px;
  }
  h1 { font-size: 18px; margin-bottom: 12px; color: var(--accent); }

  .toolbar {
    display: flex; gap: 8px; align-items: center;
    margin-bottom: 12px; flex-wrap: wrap;
  }
  .toolbar select, .toolbar button {
    font-family: var(--font); font-size: 12px;
    background: var(--surface); color: var(--text);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 4px 10px; cursor: pointer;
  }
  .toolbar button:hover { border-color: var(--accent); }

  .status {
    margin-left: auto; font-size: 11px; color: var(--dim);
  }
  .status .dot {
    display: inline-block; width: 8px; height: 8px;
    border-radius: 50%; background: var(--green);
    margin-right: 4px; vertical-align: middle;
  }

  table {
    width: 100%; border-collapse: collapse;
    background: var(--surface); border-radius: 6px;
    overflow: hidden;
  }
  thead th {
    text-align: left; padding: 8px 10px;
    background: var(--border); color: var(--dim);
    font-weight: 600; font-size: 11px; text-transform: uppercase;
    position: sticky; top: 0; z-index: 1;
  }
  tbody tr { cursor: pointer; border-bottom: 1px solid var(--border); }
  tbody tr:hover { background: rgba(88,166,255,0.06); }
  td { padding: 5px 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; }

  .method { font-weight: 700; }
  .method-GET { color: var(--green); }
  .method-POST { color: var(--yellow); }
  .method-PUT { color: var(--accent); }
  .method-DELETE { color: var(--red); }
  .method-OPTIONS { color: var(--dim); }

  .status-2 { color: var(--green); }
  .status-3 { color: var(--accent); }
  .status-4 { color: var(--yellow); }
  .status-5 { color: var(--red); }

  .detail {
    display: none; background: var(--bg);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 12px; margin: 4px 0;
    max-height: 400px; overflow: auto;
  }
  .detail.open { display: block; }
  .detail pre {
    font-size: 12px; white-space: pre-wrap; word-break: break-all;
    line-height: 1.5;
  }
  .detail h3 { color: var(--accent); margin: 8px 0 4px; font-size: 12px; }

  .diff-panel {
    display: none; background: var(--surface);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 16px; margin-top: 12px;
  }
  .diff-panel.open { display: block; }
  .diff-present { color: var(--green); }
  .diff-present::before { content: '\\2713 '; }
  .diff-missing { color: var(--red); }
  .diff-missing::before { content: '\\2717 '; }
  .diff-extra { color: var(--dim); }
  .diff-extra::before { content: '? '; }

  #event-count { font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<h1>Request Capture Dashboard</h1>
<div class="toolbar">
  <label>Session: <select id="session-picker"><option value="">All</option></select></label>
  <button onclick="clearEvents()">Clear</button>
  <button onclick="downloadJSONL()">Download JSONL</button>
  <button onclick="runDiff()">Diff vs Expected</button>
  <span class="status"><span class="dot" id="sse-dot"></span>
    <span id="event-count">0</span> events
  </span>
</div>

<table>
<thead>
  <tr>
    <th>Seq</th><th>Time</th><th>Conn</th><th>Method</th>
    <th>URL</th><th>Dest</th><th>Mode</th><th>Site</th>
    <th>Status</th><th>Bytes</th>
  </tr>
</thead>
<tbody id="tbody"></tbody>
</table>

<div class="diff-panel" id="diff-panel">
  <h3 style="color:var(--accent);margin-bottom:8px">Expected vs Observed</h3>
  <div id="diff-results"></div>
</div>

<script>
const tbody = document.getElementById('tbody');
const picker = document.getElementById('session-picker');
const countEl = document.getElementById('event-count');
const sseDot = document.getElementById('sse-dot');
let allEvents = [];
let currentSession = '';

// Load initial data
fetch('/sessions.json').then(r => r.json()).then(ids => {
  ids.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = id;
    picker.appendChild(opt);
  });
});

picker.addEventListener('change', () => {
  currentSession = picker.value;
  if (currentSession) {
    fetch('/session/' + currentSession + '.json').then(r => r.json()).then(evts => {
      allEvents = evts;
      renderTable();
    });
  } else {
    // Reload all
    allEvents = [];
    tbody.innerHTML = '';
  }
});

// SSE
let es;
function connectSSE() {
  es = new EventSource('/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    allEvents.push(ev);
    if (!currentSession || ev.session_id === currentSession) {
      appendRow(ev);
    }
    countEl.textContent = allEvents.length;
    // Add session to picker if new
    if (ev.session_id && !picker.querySelector('option[value="'+ev.session_id+'"]')) {
      const opt = document.createElement('option');
      opt.value = ev.session_id; opt.textContent = ev.session_id;
      picker.appendChild(opt);
    }
  };
  es.onopen = () => { sseDot.style.background = 'var(--green)'; };
  es.onerror = () => { sseDot.style.background = 'var(--red)'; };
}
connectSSE();

function renderTable() {
  tbody.innerHTML = '';
  allEvents.forEach(appendRow);
  countEl.textContent = allEvents.length;
}

function appendRow(ev) {
  const tr = document.createElement('tr');
  const statusClass = 'status-' + String(ev.response.status)[0];
  tr.innerHTML =
    '<td>' + ev.seq + '</td>' +
    '<td>' + ev.ts.slice(11, 23) + '</td>' +
    '<td>' + ev.conn_id + '</td>' +
    '<td class="method method-' + ev.method + '">' + ev.method + '</td>' +
    '<td title="' + escHtml(ev.url) + '">' + escHtml(ev.url) + '</td>' +
    '<td>' + (ev.dest || '-') + '</td>' +
    '<td>' + (ev.mode || '-') + '</td>' +
    '<td>' + (ev.site || '-') + '</td>' +
    '<td class="' + statusClass + '">' + ev.response.status + '</td>' +
    '<td>' + ev.response.bytes + '</td>';

  // Detail panel
  const detailTr = document.createElement('tr');
  const detailTd = document.createElement('td');
  detailTd.colSpan = 10;
  const div = document.createElement('div');
  div.className = 'detail';
  div.innerHTML = buildDetail(ev);
  detailTd.appendChild(div);
  detailTr.appendChild(detailTd);
  detailTr.style.display = 'none';

  tr.addEventListener('click', () => {
    const isOpen = div.classList.contains('open');
    div.classList.toggle('open');
    detailTr.style.display = isOpen ? 'none' : '';
  });

  tbody.appendChild(tr);
  tbody.appendChild(detailTr);

  // Auto-scroll
  tbody.parentElement.scrollTop = tbody.parentElement.scrollHeight;
}

function buildDetail(ev) {
  let h = '<h3>Request Headers</h3><pre>';
  ev.headers.forEach(([k,v]) => {
    h += escHtml(k) + ': ' + escHtml(v) + '\\n';
  });
  h += '</pre>';
  if (ev.body.bytes > 0) {
    h += '<h3>Body (' + ev.body.bytes + ' bytes)</h3><pre>' + escHtml(ev.body.data) + '</pre>';
  }
  h += '<h3>Response</h3><pre>' +
    'Status: ' + ev.response.status + '\\n' +
    'Content-Type: ' + escHtml(ev.response.content_type) + '\\n' +
    'Bytes: ' + ev.response.bytes + '</pre>';
  h += '<h3>Meta</h3><pre>' +
    'Session: ' + ev.session_id + '\\n' +
    'Connection: ' + ev.conn_id + '\\n' +
    'Duration: ' + ev.duration_ms + 'ms\\n' +
    'HTTP/' + ev.http_version + '\\n' +
    'Remote: ' + ev.remote_ip + ':' + ev.remote_port + '</pre>';
  return h;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function clearEvents() {
  allEvents = [];
  tbody.innerHTML = '';
  countEl.textContent = '0';
}

function downloadJSONL() {
  const data = allEvents.map(e => JSON.stringify(e)).join('\\n');
  const blob = new Blob([data], { type: 'application/x-jsonlines' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (currentSession || 'all') + '.jsonl';
  a.click();
}

async function runDiff() {
  const panel = document.getElementById('diff-panel');
  const results = document.getElementById('diff-results');
  panel.classList.add('open');

  const expected = await fetch('http://localhost:8080/full.expected.json').then(r => r.json());
  const observed = allEvents.map(e => e.method + ' ' + e.url.split('?')[0]);

  let html = '';
  expected.forEach(exp => {
    const key = exp.method + ' ' + exp.url;
    const found = observed.includes(key);
    html += '<div class="' + (found ? 'diff-present' : 'diff-missing') + '">' +
      escHtml(key) + ' — ' + escHtml(exp.desc) + '</div>';
  });

  // Extra (unexpected) requests
  const expectedKeys = new Set(expected.map(e => e.method + ' ' + e.url));
  observed.forEach(o => {
    if (!expectedKeys.has(o)) {
      html += '<div class="diff-extra">' + escHtml(o) + ' (unexpected)</div>';
    }
  });

  results.innerHTML = html;
}
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// View server (port 8081) — dashboard + API
// ---------------------------------------------------------------------------

const viewServer = http.createServer((req, res) => {
  const urlPath = req.url || '/';
  const parsedUrl = new URL(urlPath, 'http://localhost');
  const pathname = parsedUrl.pathname;

  // CORS for dashboard fetching from capture server
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (pathname === '/' || pathname === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200);
    res.end(DASHBOARD_HTML);
    return;
  }

  if (pathname === '/events') {
    // SSE endpoint
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':ok\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (pathname === '/sessions.json') {
    const ids = Array.from(sessions.keys());
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(ids));
    return;
  }

  const sessionMatch = pathname.match(/^\/session\/([a-f0-9]+)\.json$/);
  if (sessionMatch) {
    const sid = sessionMatch[1];
    const sess = sessions.get(sid);
    if (sess) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(sess.events));
    } else {
      res.writeHead(404);
      res.end('{"error":"session not found"}');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ---------------------------------------------------------------------------
// Start servers
// ---------------------------------------------------------------------------

captureServer.listen(CAPTURE_PORT, () => {
  console.log(`[capture] listening on http://localhost:${CAPTURE_PORT}`);
  console.log(`  /full  — comprehensive test page`);
  console.log(`  /bare  — minimal page`);
});

viewServer.listen(VIEW_PORT, () => {
  console.log(`[view]    listening on http://localhost:${VIEW_PORT}`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  captureServer.close();
  viewServer.close();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[error]', err.message);
});
