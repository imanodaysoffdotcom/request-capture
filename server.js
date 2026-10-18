#!/usr/bin/env node
'use strict';

// ============================================================================
// Request Capture Platform — Zero-dependency Node.js server
// Single port :8080 — captures requests AND serves a rich dashboard
// ============================================================================

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 8080;
const MAX_EVENTS = 10000;
const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const LOG_DIR = path.join(__dirname, 'logs');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let seq = 0;
let connSeq = 0;
const events = [];                       // ring buffer of all events
const sessions = new Map();              // session_id -> { events[], key, ip, user_agent, first_seen, last_seen }
const fallbackToSession = new Map();     // fallback_key -> session_id
const sseClients = new Set();            // SSE response objects

// Stats
const stats = {
  totalRequests: 0,
  uniqueIPs: new Set(),
  requestTimes: [],  // timestamps for rate calc
};

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
}

function extractClientIp(req, headerTuples) {
  // Render / reverse proxy headers
  const xff = getHeader(headerTuples, 'x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xRealIp = getHeader(headerTuples, 'x-real-ip');
  if (xRealIp) return xRealIp;
  return req.socket.remoteAddress || '127.0.0.1';
}

function escCsv(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ---------------------------------------------------------------------------
// Event management
// ---------------------------------------------------------------------------

function pushEvent(ev) {
  if (events.length >= MAX_EVENTS) events.shift();
  events.push(ev);
  stats.totalRequests++;
  stats.uniqueIPs.add(ev.remote_ip);
  stats.requestTimes.push(Date.now());
  // Trim request times older than 5 min
  const fiveMinAgo = Date.now() - 300000;
  while (stats.requestTimes.length > 0 && stats.requestTimes[0] < fiveMinAgo) {
    stats.requestTimes.shift();
  }

  // Per-session store
  let sess = sessions.get(ev.session_id);
  if (!sess) {
    sess = {
      events: [], key: ev.session_key,
      ip: ev.remote_ip,
      user_agent: ev.user_agent || '',
      first_seen: ev.ts,
      last_seen: ev.ts,
    };
    sessions.set(ev.session_id, sess);
  }
  sess.events.push(ev);
  sess.last_seen = ev.ts;
  if (!sess.ip) sess.ip = ev.remote_ip;
  if (!sess.user_agent) sess.user_agent = ev.user_agent || '';

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
// Load persisted logs on startup
// ---------------------------------------------------------------------------

function loadPersistedLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl'));
    let loaded = 0;
    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const content = fs.readFileSync(path.join(LOG_DIR, file), 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.seq > seq) seq = ev.seq;
          if (events.length >= MAX_EVENTS) events.shift();
          events.push(ev);

          let sess = sessions.get(ev.session_id);
          if (!sess) {
            sess = {
              events: [], key: ev.session_key || '',
              ip: ev.remote_ip || '',
              user_agent: ev.user_agent || '',
              first_seen: ev.ts,
              last_seen: ev.ts,
            };
            sessions.set(ev.session_id, sess);
            if (ev.session_key) fallbackToSession.set(ev.session_key, ev.session_id);
          }
          sess.events.push(ev);
          sess.last_seen = ev.ts;
          stats.uniqueIPs.add(ev.remote_ip);
          loaded++;
        } catch (_) {}
      }
    }
    if (loaded > 0) {
      stats.totalRequests = loaded;
      console.log(`[startup] Loaded ${loaded} events from ${files.length} session files`);
    }
  } catch (_) {}
}

loadPersistedLogs();

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
    sessions.set(sid, {
      events: [], key: fbKey, ip: remoteIp, user_agent: ua,
      first_seen: new Date().toISOString(), last_seen: new Date().toISOString(),
    });
    fallbackToSession.set(fbKey, sid);
  } else if (fallbackToSession.has(fbKey)) {
    sid = fallbackToSession.get(fbKey);
  } else {
    sid = genId(4);
    sessions.set(sid, {
      events: [], key: fbKey, ip: remoteIp, user_agent: ua,
      first_seen: new Date().toISOString(), last_seen: new Date().toISOString(),
    });
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
<link rel="preconnect" href="http://127.0.0.1:${PORT}">
<link rel="dns-prefetch" href="http://127.0.0.1:${PORT}">
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
<script src="/js/classic.js"><\/script>
<script type="module" src="/js/main.mjs"><\/script>
<script src="/js/preloaded.js"><\/script>
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
  fetch('http://127.0.0.1:${PORT}/api/cors', {method:'PUT', headers:{'X-Custom':'1'}});
  try { const ws = new WebSocket('ws://localhost:${PORT}/ws'); ws.onopen = () => setTimeout(() => ws.close(), 2000); } catch(e) {}
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
});
<\/script>
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
// Dashboard HTML
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = buildDashboardHTML();

function buildDashboardHTML() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Request Capture Dashboard</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%230a0e14'/><circle cx='50' cy='50' r='35' fill='none' stroke='%234dabf7' stroke-width='4'/><circle cx='50' cy='50' r='22' fill='none' stroke='%234dabf7' stroke-width='3' opacity='.7'/><circle cx='50' cy='50' r='10' fill='none' stroke='%234dabf7' stroke-width='2' opacity='.5'/><circle cx='50' cy='50' r='4' fill='%2340c057'/><line x1='50' y1='50' x2='72' y2='28' stroke='%2340c057' stroke-width='3' stroke-linecap='round'/></svg>">
<style>
/* ==================== CSS Variables & Reset ==================== */
:root {
  --bg: #0a0e14;
  --surface: #131920;
  --surface-hover: #1a2230;
  --surface-raised: #1e2a38;
  --border: #243040;
  --border-light: #2d3d50;
  --text: #e4ecf5;
  --text-secondary: #8899aa;
  --text-dim: #5a6a7a;
  --accent: #4dabf7;
  --accent-hover: #74c0fc;
  --accent-bg: rgba(77, 171, 247, 0.08);
  --green: #51cf66;
  --green-bg: rgba(81, 207, 102, 0.08);
  --red: #ff6b6b;
  --red-bg: rgba(255, 107, 107, 0.08);
  --yellow: #fcc419;
  --yellow-bg: rgba(252, 196, 25, 0.08);
  --orange: #ff922b;
  --purple: #cc5de8;
  --mono: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --radius: 8px;
  --radius-sm: 4px;
  --shadow: 0 2px 12px rgba(0,0,0,0.3);
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  font-family: var(--sans);
  font-size: 13px;
  background: var(--bg);
  color: var(--text);
  display: flex;
  flex-direction: column;
}

/* ==================== Top Bar ==================== */
.topbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  z-index: 100;
}
.topbar-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: -0.3px;
  white-space: nowrap;
}
.topbar-title span { color: var(--text-dim); font-weight: 400; }

/* ==================== Stats Bar ==================== */
.stats-bar {
  display: flex;
  gap: 2px;
  padding: 6px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.stat-card {
  flex: 1;
  padding: 8px 14px;
  background: var(--bg);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stat-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--text-dim);
  font-weight: 600;
}
.stat-value {
  font-size: 18px;
  font-weight: 700;
  font-family: var(--mono);
  color: var(--text);
}

/* ==================== Filter Bar ==================== */
.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.filter-input {
  flex: 1;
  min-width: 200px;
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  outline: none;
}
.filter-input:focus { border-color: var(--accent); }
.filter-input::placeholder { color: var(--text-dim); }

.quick-filters { display: flex; gap: 4px; flex-wrap: wrap; }
.qf-btn {
  padding: 4px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}
.qf-btn:hover { border-color: var(--accent); color: var(--accent); }
.qf-btn.active {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
}

.action-btns { display: flex; gap: 4px; margin-left: auto; }
.action-btn {
  padding: 5px 12px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}
.action-btn:hover { border-color: var(--accent); color: var(--text); }

/* ==================== Main Layout ==================== */
.main-layout {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ==================== Session Sidebar ==================== */
.sidebar {
  width: 260px;
  min-width: 200px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}
.sidebar-header {
  padding: 10px 14px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.sidebar-header .count {
  background: var(--border);
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 10px;
  color: var(--text-secondary);
}
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}
.session-item {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  margin-bottom: 2px;
  transition: background 0.1s;
}
.session-item:hover { background: var(--surface-hover); }
.session-item.active { background: var(--accent-bg); border: 1px solid var(--accent); }
.session-id {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 4px;
}
.session-meta {
  font-size: 10px;
  color: var(--text-dim);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.session-meta .badge {
  display: inline-block;
  background: var(--border);
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 9px;
  color: var(--text-secondary);
  margin-right: 4px;
}
.session-all {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  margin-bottom: 4px;
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 12px;
}
.session-all:hover { background: var(--surface-hover); }
.session-all.active { background: var(--accent-bg); color: var(--accent); }

/* ==================== Content Area ==================== */
.content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Timeline */
.timeline {
  height: 48px;
  padding: 6px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.timeline canvas { width: 100%; height: 100%; }

/* Request Table */
.table-wrapper {
  flex: 1;
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
thead { position: sticky; top: 0; z-index: 10; }
thead th {
  text-align: left;
  padding: 7px 10px;
  background: var(--surface-raised);
  color: var(--text-dim);
  font-weight: 700;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  border-bottom: 2px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
thead th:hover { color: var(--text-secondary); }
thead th.sorted-asc::after { content: ' \\25B2'; font-size: 8px; }
thead th.sorted-desc::after { content: ' \\25BC'; font-size: 8px; }

/* Column widths */
.col-seq { width: 50px; }
.col-time { width: 90px; }
.col-method { width: 65px; }
.col-url { width: auto; }
.col-status { width: 50px; }
.col-dest { width: 70px; }
.col-mode { width: 65px; }
.col-site { width: 75px; }
.col-ip { width: 120px; }
.col-size { width: 60px; }
.col-dur { width: 55px; }

tbody tr.req-row {
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background 0.1s;
}
tbody tr.req-row:hover { background: var(--surface-hover); }
tbody tr.req-row.expanded { background: var(--accent-bg); }
td {
  padding: 5px 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
}
td.cell-mono { font-family: var(--mono); font-size: 11px; }

.method { font-weight: 700; font-family: var(--mono); font-size: 11px; }
.method-GET { color: var(--green); }
.method-POST { color: var(--yellow); }
.method-PUT { color: var(--accent); }
.method-DELETE { color: var(--red); }
.method-OPTIONS { color: var(--text-dim); }
.method-PATCH { color: var(--orange); }
.method-HEAD { color: var(--purple); }

.status-2 { color: var(--green); }
.status-3 { color: var(--accent); }
.status-4 { color: var(--yellow); }
.status-5 { color: var(--red); }
.status-1 { color: var(--purple); }

.ip-link {
  color: var(--text-secondary);
  text-decoration: none;
  font-family: var(--mono);
  font-size: 11px;
}
.ip-link:hover { color: var(--accent); text-decoration: underline; }

/* ==================== Detail Panel ==================== */
.detail-row { display: none; }
.detail-row.open { display: table-row; }
.detail-cell {
  padding: 0 !important;
  background: var(--bg);
}
.detail-content {
  padding: 16px;
  max-height: 500px;
  overflow: auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.detail-section {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 12px 14px;
  border: 1px solid var(--border);
}
.detail-section.full-width { grid-column: 1 / -1; }
.detail-section h4 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--accent);
  margin-bottom: 8px;
  font-weight: 700;
}
.detail-kv {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 12px;
  font-size: 12px;
  font-family: var(--mono);
}
.detail-kv .key {
  color: var(--text-dim);
  white-space: nowrap;
}
.detail-kv .val {
  color: var(--text);
  word-break: break-all;
}
.header-table {
  width: 100%;
  border-collapse: collapse;
}
.header-table tr { border-bottom: 1px solid var(--border); }
.header-table td {
  padding: 3px 0;
  font-family: var(--mono);
  font-size: 11px;
  vertical-align: top;
  white-space: normal;
  word-break: break-all;
}
.header-table td:first-child {
  color: var(--accent);
  padding-right: 12px;
  white-space: nowrap;
  font-weight: 600;
}
.body-pre {
  background: var(--bg);
  padding: 10px;
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow: auto;
  color: var(--text-secondary);
  line-height: 1.6;
}

/* ==================== Diff Modal ==================== */
.modal-overlay {
  display: none;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.6);
  z-index: 1000;
  justify-content: center;
  align-items: center;
}
.modal-overlay.open { display: flex; }
.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  overflow: auto;
  box-shadow: var(--shadow);
}
.modal h3 {
  color: var(--accent);
  margin-bottom: 12px;
  font-size: 14px;
}
.modal-close {
  float: right;
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 18px;
}
.modal-close:hover { color: var(--text); }
.diff-item { padding: 4px 0; font-family: var(--mono); font-size: 12px; }
.diff-present { color: var(--green); }
.diff-present::before { content: '\\2713 '; }
.diff-missing { color: var(--red); }
.diff-missing::before { content: '\\2717 '; }
.diff-extra { color: var(--text-dim); }
.diff-extra::before { content: '? '; }

/* ==================== SSE indicator ==================== */
.sse-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--green);
  display: inline-block;
  margin-right: 6px;
}
.sse-dot.disconnected { background: var(--red); }

/* ==================== Scrollbar ==================== */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-light); }

/* ==================== Mobile ==================== */
@media (max-width: 768px) {
  .sidebar { display: none; }
  .stats-bar { flex-wrap: wrap; }
  .stat-card { min-width: 80px; }
  .filter-bar { flex-direction: column; }
  .filter-input { min-width: 100%; }
  .action-btns { margin-left: 0; width: 100%; }
  .detail-content { grid-template-columns: 1fr; }
  .col-dest, .col-mode, .col-site, .col-ip { display: none; }
  .topbar-title span { display: none; }
}
@media (max-width: 480px) {
  .col-dur, .col-size { display: none; }
  .quick-filters { display: none; }
}
</style>
</head>
<body>

<!-- Top Bar -->
<div class="topbar">
  <div class="topbar-title">Request Capture <span>Dashboard</span></div>
  <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">
    <span class="sse-dot" id="sse-dot"></span>
    <span style="font-size:11px;color:var(--text-dim)" id="sse-status">Connected</span>
  </div>
</div>

<!-- Stats Bar -->
<div class="stats-bar">
  <div class="stat-card">
    <span class="stat-label">Total Requests</span>
    <span class="stat-value" id="stat-total">0</span>
  </div>
  <div class="stat-card">
    <span class="stat-label">Unique IPs</span>
    <span class="stat-value" id="stat-ips">0</span>
  </div>
  <div class="stat-card">
    <span class="stat-label">Sessions</span>
    <span class="stat-value" id="stat-sessions">0</span>
  </div>
  <div class="stat-card">
    <span class="stat-label">Req/min (5m)</span>
    <span class="stat-value" id="stat-rpm">0</span>
  </div>
</div>

<!-- Filter Bar -->
<div class="filter-bar">
  <input class="filter-input" id="search" placeholder="Filter: URL, method, status, IP, content-type..." autocomplete="off">
  <div class="quick-filters">
    <button class="qf-btn active" data-filter="all" onclick="setQuickFilter('all',this)">All</button>
    <button class="qf-btn" data-filter="docs" onclick="setQuickFilter('docs',this)">Documents</button>
    <button class="qf-btn" data-filter="api" onclick="setQuickFilter('api',this)">API</button>
    <button class="qf-btn" data-filter="assets" onclick="setQuickFilter('assets',this)">Assets</button>
    <button class="qf-btn" data-filter="errors" onclick="setQuickFilter('errors',this)">Errors</button>
  </div>
  <div class="action-btns">
    <button class="action-btn" onclick="exportJSONL()">Export JSONL</button>
    <button class="action-btn" onclick="exportCSV()">Export CSV</button>
    <button class="action-btn" onclick="openDiff()">Diff Expected</button>
    <button class="action-btn" onclick="toggleView()">Connections</button>
    <button class="action-btn" onclick="clearDisplay()">Clear</button>
    <button class="action-btn" style="background:var(--red);color:#fff;font-weight:600" onclick="deleteAllSessions()">🗑 Delete All</button>
  </div>
</div>

<!-- Main Layout -->
<div class="main-layout">
  <!-- Sidebar -->
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      Sessions <span class="count" id="sidebar-count">0</span>
    </div>
    <div class="session-list" id="session-list">
      <div class="session-all active" id="session-all" onclick="selectSession('')">All Sessions</div>
    </div>
  </div>

  <!-- Content -->
  <div class="content">
    <!-- Timeline -->
    <div class="timeline">
      <canvas id="timeline-canvas"></canvas>
    </div>

    <!-- Request Table -->
    <div class="table-wrapper" id="table-wrapper">
      <table>
        <thead>
          <tr>
            <th class="col-seq" onclick="sortBy('seq')">Seq</th>
            <th class="col-time" onclick="sortBy('ts')">Time</th>
            <th class="col-method" onclick="sortBy('method')">Method</th>
            <th class="col-url" onclick="sortBy('url')">URL</th>
            <th class="col-status" onclick="sortBy('response.status')">Status</th>
            <th class="col-dest" onclick="sortBy('dest')">Dest</th>
            <th class="col-mode" onclick="sortBy('mode')">Mode</th>
            <th class="col-site" onclick="sortBy('site')">Site</th>
            <th class="col-ip" onclick="sortBy('remote_ip')">IP</th>
            <th class="col-size" onclick="sortBy('response.bytes')">Size</th>
            <th class="col-dur" onclick="sortBy('duration_ms')">ms</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- Diff Modal -->
<div class="modal-overlay" id="diff-modal">
  <div class="modal">
    <button class="modal-close" onclick="closeDiff()">&times;</button>
    <h3>Expected vs Observed</h3>
    <div id="diff-results"></div>
  </div>
</div>

<script>
// ==================== State ====================
let allEvents = [];
let filteredEvents = [];
let currentSession = '';
let currentFilter = '';
let quickFilter = 'all';
let sortField = 'seq';
let sortDir = 'asc';
let viewMode = 'requests'; // 'requests' or 'connections'
let sessionMap = new Map(); // id -> summary
let autoScroll = true;

const $ = id => document.getElementById(id);
const tbody = $('tbody');
const tableWrapper = $('table-wrapper');

// ==================== Init ====================
async function init() {
  // Load stats
  refreshStats();
  // Load sessions
  const sessResp = await fetch('/_api/sessions');
  const sessList = await sessResp.json();
  sessList.forEach(s => {
    sessionMap.set(s.id, s);
  });
  renderSessionList();

  // Load all events
  const evResp = await fetch('/_api/events?since=0');
  const evts = await evResp.json();
  allEvents = evts;
  applyFilters();
  renderTable();

  // Start SSE
  connectSSE();
  // Stats refresh
  setInterval(refreshStats, 5000);
  // Timeline refresh
  setInterval(drawTimeline, 2000);
  drawTimeline();
}

// ==================== SSE ====================
let es;
function connectSSE() {
  es = new EventSource('/_api/events/stream');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    allEvents.push(ev);
    // Update session map
    if (!sessionMap.has(ev.session_id)) {
      sessionMap.set(ev.session_id, {
        id: ev.session_id, request_count: 1,
        first_seen: ev.ts, last_seen: ev.ts,
        ip: ev.remote_ip, user_agent: ev.user_agent || ''
      });
      renderSessionList();
    } else {
      const s = sessionMap.get(ev.session_id);
      s.request_count = (s.request_count || 0) + 1;
      s.last_seen = ev.ts;
      updateSessionItem(ev.session_id);
    }
    if (matchesFilters(ev)) {
      filteredEvents.push(ev);
      appendRow(ev);
    }
  };
  es.onopen = () => {
    $('sse-dot').classList.remove('disconnected');
    $('sse-status').textContent = 'Connected';
  };
  es.onerror = () => {
    $('sse-dot').classList.add('disconnected');
    $('sse-status').textContent = 'Reconnecting...';
  };
}

// ==================== Stats ====================
async function refreshStats() {
  try {
    const r = await fetch('/_api/stats');
    const s = await r.json();
    $('stat-total').textContent = s.totalRequests.toLocaleString();
    $('stat-ips').textContent = s.uniqueIPs.toLocaleString();
    $('stat-sessions').textContent = s.activeSessions.toLocaleString();
    $('stat-rpm').textContent = s.requestsPerMin.toFixed(1);
  } catch(e) {}
}

// ==================== Sessions ====================
function renderSessionList() {
  const list = $('session-list');
  // Keep the "All" item
  list.innerHTML = '<div class="session-all' + (currentSession === '' ? ' active' : '') +
    '" id="session-all" onclick="selectSession(\\'\\')">' +
    'All Sessions <span style="float:right;color:var(--text-dim)">' + allEvents.length + '</span></div>';

  const sessions = Array.from(sessionMap.entries())
    .sort((a,b) => (b[1].last_seen || '').localeCompare(a[1].last_seen || ''));

  $('sidebar-count').textContent = sessions.length;

  sessions.forEach(([id, s]) => {
    const div = document.createElement('div');
    div.className = 'session-item' + (currentSession === id ? ' active' : '');
    div.id = 'sess-' + id;
    div.onclick = () => selectSession(id);
    const uaShort = (s.user_agent || '').slice(0, 40);
    div.innerHTML =
      '<div class="session-id">' + esc(id) + '</div>' +
      '<div class="session-meta">' +
        '<span><span class="badge">' + (s.request_count || 0) + ' req</span> ' + esc(s.ip || '') + '</span>' +
        '<span>' + esc(uaShort) + '</span>' +
        '<span>' + formatTime(s.last_seen) + '</span>' +
      '</div>';
    list.appendChild(div);
  });
}

function updateSessionItem(id) {
  const el = document.getElementById('sess-' + id);
  if (el) {
    const s = sessionMap.get(id);
    const badge = el.querySelector('.badge');
    if (badge) badge.textContent = (s.request_count || 0) + ' req';
  }
}

function selectSession(id) {
  currentSession = id;
  // Update active state
  document.querySelectorAll('.session-item,.session-all').forEach(el => el.classList.remove('active'));
  if (id === '') {
    $('session-all').classList.add('active');
  } else {
    const el = document.getElementById('sess-' + id);
    if (el) el.classList.add('active');
  }
  applyFilters();
  renderTable();
}

// ==================== Filtering ====================
function matchesFilters(ev) {
  // Session filter
  if (currentSession && ev.session_id !== currentSession) return false;

  // Quick filter
  if (quickFilter !== 'all') {
    if (quickFilter === 'docs' && ev.dest !== 'document' && ev.dest !== 'iframe') return false;
    if (quickFilter === 'api' && !ev.url.startsWith('/api/')) return false;
    if (quickFilter === 'assets' && !['image','style','script','font','manifest'].includes(ev.dest)) return false;
    if (quickFilter === 'errors') {
      const s = ev.response ? ev.response.status : 0;
      if (s < 400) return false;
    }
  }

  // Text filter
  if (currentFilter) {
    const f = currentFilter.toLowerCase();
    const haystack = [
      ev.method, ev.url, String(ev.response?.status || ''),
      ev.remote_ip || '', ev.dest || '', ev.mode || '',
      ev.response?.content_type || '', ev.user_agent || ''
    ].join(' ').toLowerCase();
    if (!haystack.includes(f)) return false;
  }

  return true;
}

function applyFilters() {
  filteredEvents = allEvents.filter(matchesFilters);
  if (sortField !== 'seq' || sortDir !== 'asc') {
    doSort();
  }
}

$('search').addEventListener('input', (e) => {
  currentFilter = e.target.value;
  applyFilters();
  renderTable();
});

function setQuickFilter(filter, btn) {
  quickFilter = filter;
  document.querySelectorAll('.qf-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyFilters();
  renderTable();
}

// ==================== Sorting ====================
function sortBy(field) {
  if (sortField === field) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortField = field;
    sortDir = 'asc';
  }
  // Update header classes
  document.querySelectorAll('thead th').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
  });
  applyFilters();
  renderTable();
}

function doSort() {
  filteredEvents.sort((a, b) => {
    let va = getNestedVal(a, sortField);
    let vb = getNestedVal(b, sortField);
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    let cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return sortDir === 'desc' ? -cmp : cmp;
  });
}

function getNestedVal(obj, path) {
  return path.split('.').reduce((o, k) => (o || {})[k], obj) || '';
}

// ==================== Table Rendering ====================
function renderTable() {
  tbody.innerHTML = '';
  filteredEvents.forEach(appendRow);
}

function appendRow(ev) {
  const tr = document.createElement('tr');
  tr.className = 'req-row';
  const statusChar = String(ev.response?.status || 0)[0];
  const ip = ev.remote_ip || '';
  const cleanIp = ip.replace('::ffff:', '');

  tr.innerHTML =
    '<td class="cell-mono">' + ev.seq + '</td>' +
    '<td class="cell-mono">' + formatTime(ev.ts) + '</td>' +
    '<td class="method method-' + ev.method + '">' + ev.method + '</td>' +
    '<td class="cell-mono" title="' + esc(ev.url) + '">' + esc(ev.url) + '</td>' +
    '<td class="cell-mono status-' + statusChar + '">' + (ev.response?.status || '') + '</td>' +
    '<td>' + esc(ev.dest || '-') + '</td>' +
    '<td>' + esc(ev.mode || '-') + '</td>' +
    '<td>' + esc(ev.site || '-') + '</td>' +
    '<td><a class="ip-link" href="https://ipinfo.io/' + esc(cleanIp) + '" target="_blank" title="Lookup ' + esc(cleanIp) + '" onclick="event.stopPropagation()">' + esc(cleanIp) + '</a></td>' +
    '<td class="cell-mono">' + formatBytes(ev.response?.bytes || 0) + '</td>' +
    '<td class="cell-mono">' + (ev.duration_ms || 0) + '</td>';

  // Detail row
  const detailTr = document.createElement('tr');
  detailTr.className = 'detail-row';
  const detailTd = document.createElement('td');
  detailTd.className = 'detail-cell';
  detailTd.colSpan = 11;

  tr.addEventListener('click', () => {
    const isOpen = detailTr.classList.contains('open');
    // Close others
    document.querySelectorAll('.detail-row.open').forEach(r => {
      r.classList.remove('open');
      r.previousElementSibling?.classList.remove('expanded');
    });
    if (!isOpen) {
      detailTd.innerHTML = buildDetailHTML(ev);
      detailTr.classList.add('open');
      tr.classList.add('expanded');
    }
  });

  detailTr.appendChild(detailTd);
  tbody.appendChild(tr);
  tbody.appendChild(detailTr);

  if (autoScroll) {
    tableWrapper.scrollTop = tableWrapper.scrollHeight;
  }
}

function buildDetailHTML(ev) {
  const ip = (ev.remote_ip || '').replace('::ffff:', '');
  let html = '<div class="detail-content">';

  // Request info
  html += '<div class="detail-section"><h4>Request</h4><div class="detail-kv">';
  html += kv('Method', ev.method) + kv('URL', ev.url) + kv('HTTP', ev.http_version);
  html += kv('Host', ev.host || '') + kv('Session', ev.session_id);
  html += kv('Connection', ev.conn_id) + kv('Duration', ev.duration_ms + 'ms');
  html += kv('Aborted', ev.aborted ? 'Yes' : 'No');
  html += '</div></div>';

  // Response info
  html += '<div class="detail-section"><h4>Response</h4><div class="detail-kv">';
  html += kv('Status', ev.response?.status || '');
  html += kv('Content-Type', ev.response?.content_type || '');
  html += kv('Bytes', formatBytes(ev.response?.bytes || 0));
  html += '</div></div>';

  // Network info
  html += '<div class="detail-section"><h4>Network</h4><div class="detail-kv">';
  html += kv('Remote IP', '<a class="ip-link" href="https://ipinfo.io/' + esc(ip) + '" target="_blank">' + esc(ip) + '</a>');
  html += kv('Remote Port', ev.remote_port || '');
  html += kv('Timestamp', ev.ts);
  html += kv('Unix', ev.ts_unix || new Date(ev.ts).getTime());
  html += '</div></div>';

  // Promoted headers
  html += '<div class="detail-section"><h4>Fetch Metadata</h4><div class="detail-kv">';
  html += kv('Sec-Fetch-Dest', ev.dest || '-');
  html += kv('Sec-Fetch-Mode', ev.mode || '-');
  html += kv('Sec-Fetch-Site', ev.site || '-');
  html += kv('Priority', ev.priority || '-');
  html += kv('Purpose', ev.purpose || '-');
  html += kv('Referer', ev.referer || '-');
  html += kv('Accept', ev.accept || '-');
  html += kv('Sec-CH-UA', ev.sec_ch_ua || '-');
  html += '</div></div>';

  // All headers
  html += '<div class="detail-section full-width"><h4>Headers (' + (ev.headers?.length || 0) + ')</h4>';
  html += '<table class="header-table">';
  (ev.headers || []).forEach(([k, v]) => {
    html += '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>';
  });
  html += '</table></div>';

  // Body
  if (ev.body && ev.body.bytes > 0) {
    html += '<div class="detail-section full-width"><h4>Body (' + ev.body.bytes + ' bytes, ' + (ev.body.encoding || 'utf8') + ')</h4>';
    html += '<pre class="body-pre">' + esc(ev.body.data || '') + '</pre></div>';
  }

  // User agent
  if (ev.user_agent) {
    html += '<div class="detail-section full-width"><h4>User Agent</h4>';
    html += '<pre class="body-pre">' + esc(ev.user_agent) + '</pre></div>';
  }

  html += '</div>';
  return html;
}

function kv(key, val) {
  return '<span class="key">' + esc(key) + '</span><span class="val">' + val + '</span>';
}

// ==================== Timeline ====================
function drawTimeline() {
  const canvas = $('timeline-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * (window.devicePixelRatio || 1);
  canvas.height = rect.height * (window.devicePixelRatio || 1);
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  const w = rect.width, h = rect.height;

  ctx.clearRect(0, 0, w, h);

  // Last 5 minutes in 1-second buckets
  const now = Date.now();
  const buckets = 300;
  const counts = new Array(buckets).fill(0);
  const fiveMinAgo = now - 300000;

  const eventsToUse = currentSession ? allEvents.filter(e => e.session_id === currentSession) : allEvents;
  eventsToUse.forEach(ev => {
    const t = new Date(ev.ts).getTime();
    if (t >= fiveMinAgo) {
      const idx = Math.floor((t - fiveMinAgo) / 1000);
      if (idx >= 0 && idx < buckets) counts[idx]++;
    }
  });

  const max = Math.max(...counts, 1);
  const barW = w / buckets;

  // Grid line
  ctx.strokeStyle = '#243040';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.5); ctx.lineTo(w, h * 0.5);
  ctx.stroke();

  // Bars
  counts.forEach((c, i) => {
    if (c === 0) return;
    const barH = (c / max) * (h - 4);
    const x = i * barW;
    ctx.fillStyle = c > max * 0.7 ? '#ff6b6b' : c > max * 0.3 ? '#fcc419' : '#4dabf7';
    ctx.globalAlpha = 0.7;
    ctx.fillRect(x, h - barH - 2, Math.max(barW - 0.5, 1), barH);
  });
  ctx.globalAlpha = 1;

  // Labels
  ctx.fillStyle = '#5a6a7a';
  ctx.font = '9px ' + getComputedStyle(document.body).fontFamily;
  ctx.fillText('5m ago', 4, 10);
  ctx.fillText('now', w - 24, 10);
}

// ==================== View Modes ====================
function toggleView() {
  if (viewMode === 'requests') {
    viewMode = 'connections';
    renderConnectionView();
  } else {
    viewMode = 'requests';
    renderTable();
  }
}

function renderConnectionView() {
  tbody.innerHTML = '';
  // Group by conn_id
  const groups = new Map();
  filteredEvents.forEach(ev => {
    const cid = ev.conn_id || '?';
    if (!groups.has(cid)) groups.set(cid, []);
    groups.get(cid).push(ev);
  });

  groups.forEach((evts, cid) => {
    // Connection header
    const headerTr = document.createElement('tr');
    headerTr.className = 'req-row';
    headerTr.style.background = 'var(--surface-raised)';
    headerTr.innerHTML =
      '<td colspan="11" style="font-weight:700;color:var(--accent);font-size:12px;font-family:var(--mono)">' +
      'Connection ' + esc(cid) + ' — ' + evts.length + ' requests' +
      (evts.length > 0 ? ' — ' + esc(evts[0].remote_ip || '') : '') +
      '</td>';
    tbody.appendChild(headerTr);

    evts.forEach(appendRow);
  });
}

// ==================== Export ====================
function exportJSONL() {
  const data = filteredEvents.map(e => JSON.stringify(e)).join('\\n');
  download(data, (currentSession || 'all') + '.jsonl', 'application/x-jsonlines');
}

function exportCSV() {
  const headers = ['seq','timestamp','method','url','status','dest','mode','site','ip','bytes','duration_ms','conn_id','session_id'];
  let csv = headers.join(',') + '\\n';
  filteredEvents.forEach(ev => {
    csv += [
      ev.seq, ev.ts, ev.method, escCsvJS(ev.url),
      ev.response?.status || '', ev.dest || '', ev.mode || '', ev.site || '',
      ev.remote_ip || '', ev.response?.bytes || 0, ev.duration_ms || 0,
      ev.conn_id || '', ev.session_id || ''
    ].map(escCsvJS).join(',') + '\\n';
  });
  download(csv, (currentSession || 'all') + '.csv', 'text/csv');
}

function escCsvJS(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ==================== Diff ====================
async function openDiff() {
  const modal = $('diff-modal');
  const results = $('diff-results');
  modal.classList.add('open');

  try {
    const expected = await fetch('/full.expected.json').then(r => r.json());
    const observed = filteredEvents.map(e => e.method + ' ' + (e.url || '').split('?')[0]);

    let html = '';
    expected.forEach(exp => {
      const key = exp.method + ' ' + exp.url;
      const found = observed.includes(key);
      html += '<div class="diff-item ' + (found ? 'diff-present' : 'diff-missing') + '">' +
        esc(key) + ' — ' + esc(exp.desc) + '</div>';
    });

    const expectedKeys = new Set(expected.map(e => e.method + ' ' + e.url));
    const seen = new Set();
    observed.forEach(o => {
      if (!expectedKeys.has(o) && !seen.has(o)) {
        html += '<div class="diff-item diff-extra">' + esc(o) + ' (unexpected)</div>';
        seen.add(o);
      }
    });

    results.innerHTML = html;
  } catch (e) {
    results.innerHTML = '<div style="color:var(--red)">Failed to load expected requests: ' + esc(e.message) + '</div>';
  }
}

function closeDiff() {
  $('diff-modal').classList.remove('open');
}

// ==================== Misc ====================
function clearDisplay() {
  allEvents = [];
  filteredEvents = [];
  tbody.innerHTML = '';
}

function deleteAllSessions() {
  const pw = prompt('Enter password to delete ALL sessions and records:');
  if (pw === null) return; // cancelled
  fetch('/_api/sessions/delete-all', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ password: pw })
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) {
      alert('Error: ' + data.error);
    } else {
      alert('Deleted ' + data.deleted + ' session(s). All records cleared.');
      allEvents = [];
      filteredEvents = [];
      tbody.innerHTML = '';
      document.querySelector('.sessions-list').innerHTML = '';
      document.querySelectorAll('.stat-value').forEach(el => el.textContent = '0');
      currentSession = null;
    }
  })
  .catch(err => alert('Request failed: ' + err.message));
}

function formatTime(ts) {
  if (!ts) return '-';
  return ts.slice(11, 23);
}

function formatBytes(b) {
  if (b === 0) return '0';
  if (b < 1024) return b + '';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'K';
  return (b / (1024 * 1024)).toFixed(1) + 'M';
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Scroll detection
tableWrapper.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = tableWrapper;
  autoScroll = scrollHeight - scrollTop - clientHeight < 50;
});

// Close modal on overlay click
$('diff-modal').addEventListener('click', (e) => {
  if (e.target === $('diff-modal')) closeDiff();
});

// Keyboard shortcut
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDiff();
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement !== $('search')) {
    e.preventDefault();
    $('search').focus();
  }
});

// Go!
init();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Capture server request handler
// ---------------------------------------------------------------------------

function handleCaptureRequest(req, res, connId) {
  const startTime = Date.now();
  const headerTuples = rawHeadersToTuples(req.rawHeaders);
  const remoteIp = extractClientIp(req, headerTuples);
  const remotePort = req.socket.remotePort || 0;
  const httpVersion = req.httpVersion;
  const host = getHeader(headerTuples, 'host') || `localhost:${PORT}`;
  const urlPath = req.url || '/';
  const method = req.method;

  // Session
  const sessInfo = resolveSession(req, remoteIp, headerTuples);

  // Collect body
  const bodyChunks = [];
  let bodyLen = 0;
  req.on('data', (chunk) => {
    if (bodyLen < MAX_BODY_BYTES) {
      bodyChunks.push(chunk);
      bodyLen += chunk.length;
    }
  });

  req.on('end', () => {
    const bodyBuf = Buffer.concat(bodyChunks).slice(0, MAX_BODY_BYTES);
    const bodyStr = bodyBuf.toString('utf8');

    // Set cookie if needed
    if (sessInfo.needsSet) {
      res.setHeader('Set-Cookie', `echo_sid=${sessInfo.session_id}; Path=/; SameSite=Lax`);
    }

    noCache(res);

    // Route and respond
    const respInfo = routeCapture(req, res, method, urlPath, headerTuples, bodyStr, sessInfo);

    // Build event
    const now = new Date();
    const ev = {
      seq: ++seq,
      ts: now.toISOString(),
      ts_unix: now.getTime(),
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
        bytes: bodyLen,
        data: bodyStr.slice(0, 10000),
      },
      response: {
        status: respInfo.status,
        content_type: respInfo.contentType,
        bytes: respInfo.bytes,
      },
      aborted: req.destroyed,
      duration_ms: Date.now() - startTime,
      // Promoted fields
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
      // GeoIP hint headers (from CDN/proxy)
      cf_ipcountry: getHeader(headerTuples, 'cf-ipcountry'),
      x_forwarded_for: getHeader(headerTuples, 'x-forwarded-for'),
    };

    pushEvent(ev);
  });

  req.on('error', () => {});
}

// ---------------------------------------------------------------------------
// Routing logic
// ---------------------------------------------------------------------------

function routeCapture(req, res, method, urlPath, headerTuples, bodyStr, sessInfo) {
  const parsedUrl = new URL(urlPath, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const ext = path.extname(pathname).toLowerCase();

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

  // --- /api/* routes ---
  if (pathname.startsWith('/api/')) {
    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Max-Age', '0');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    const jsonBody = JSON.stringify({
      method, url: urlPath, headers: rawHeadersToTuples(req.rawHeaders),
      body: bodyStr, echo: true,
    });
    return sendResponse(res, 200, 'application/json', jsonBody);
  }

  // --- File extension rules ---
  if (ext === '.css') return sendResponse(res, 200, 'text/css', '/* echo */');
  if (ext === '.js' || ext === '.mjs') return sendResponse(res, 200, 'text/javascript', '/* echo */');

  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico'].includes(ext)) {
    const ct = mimeForExt(ext || '.png');
    res.setHeader('Content-Type', ct);
    res.writeHead(200);
    res.end(PIXEL_PNG);
    return { status: 200, contentType: ct, bytes: PIXEL_PNG.length };
  }

  if (ext === '.svg') return sendResponse(res, 200, 'image/svg+xml', EMPTY_SVG);

  if (['.woff2', '.woff', '.ttf'].includes(ext)) {
    const ct = mimeForExt(ext || '.woff2');
    res.writeHead(204, { 'Content-Type': ct });
    res.end();
    return { status: 204, contentType: ct, bytes: 0 };
  }

  if (ext === '.webmanifest') return sendResponse(res, 200, 'application/manifest+json', '{}');
  if (ext === '.html') return sendResponse(res, 200, 'text/html', '<!doctype html><title>echo</title>');

  if (['.mp4', '.mp3', '.ogg', '.wav'].includes(ext)) {
    const ct = mimeForExt(ext || '.mp4');
    res.setHeader('Content-Type', ct);
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
// Dashboard API handlers
// ---------------------------------------------------------------------------

function handleDashboardAPI(req, res, pathname) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET /_dashboard — main HTML
  if (pathname === '/_dashboard' || pathname === '/_dashboard/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200);
    res.end(DASHBOARD_HTML);
    return;
  }

  // GET /_api/sessions
  if (pathname === '/_api/sessions') {
    const result = [];
    for (const [id, sess] of sessions) {
      result.push({
        id,
        request_count: sess.events.length,
        first_seen: sess.first_seen || (sess.events[0]?.ts || ''),
        last_seen: sess.last_seen || (sess.events[sess.events.length - 1]?.ts || ''),
        ip: sess.ip || (sess.events[0]?.remote_ip || ''),
        user_agent: sess.user_agent || (sess.events[0]?.user_agent || ''),
      });
    }
    result.sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''));
    sendJSON(res, 200, result);
    return;
  }

  // GET /_api/session/:id
  const sessMatch = pathname.match(/^\/_api\/session\/([a-f0-9]+)$/);
  if (sessMatch) {
    const sid = sessMatch[1];
    const sess = sessions.get(sid);
    if (sess) {
      sendJSON(res, 200, sess.events);
    } else {
      sendJSON(res, 404, { error: 'session not found' });
    }
    return;
  }

  // DELETE /_api/session/:id
  if (req.method === 'DELETE') {
    const delMatch = pathname.match(/^\/_api\/session\/([a-f0-9]+)$/);
    if (delMatch) {
      const sid = delMatch[1];
      sessions.delete(sid);
      // Remove from events
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].session_id === sid) events.splice(i, 1);
      }
      // Delete log file
      try { fs.unlinkSync(path.join(LOG_DIR, sid + '.jsonl')); } catch (_) {}
      sendJSON(res, 200, { deleted: sid });
      return;
    }
  }

  // POST /_api/sessions/delete-all — password protected
  if (req.method === 'POST' && pathname === '/_api/sessions/delete-all') {
    // Read body for password
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed.password !== 'password') {
          sendJSON(res, 403, { error: 'Invalid password' });
          return;
        }
        // Delete all sessions, events, and log files
        const count = sessions.size;
        for (const [sid] of sessions) {
          try { fs.unlinkSync(path.join(LOG_DIR, sid + '.jsonl')); } catch (_) {}
        }
        sessions.clear();
        fallbackToSession.clear();
        events.length = 0;
        seq = 0;
        stats.totalRequests = 0;
        stats.uniqueIPs.clear();
        stats.requestTimes.length = 0;
        sendJSON(res, 200, { deleted: count, message: 'All sessions and records deleted' });
      } catch (_) {
        sendJSON(res, 400, { error: 'Invalid request body' });
      }
    });
    return;
  }

  // GET /_api/events?since=<seq>
  if (pathname === '/_api/events') {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const since = parseInt(parsedUrl.searchParams.get('since') || '0', 10);
    const result = events.filter(e => e.seq > since);
    sendJSON(res, 200, result);
    return;
  }

  // GET /_api/stats
  if (pathname === '/_api/stats') {
    const now = Date.now();
    const oneMinAgo = now - 60000;
    const recentCount = stats.requestTimes.filter(t => t > oneMinAgo).length;
    sendJSON(res, 200, {
      totalRequests: stats.totalRequests,
      uniqueIPs: stats.uniqueIPs.size,
      activeSessions: sessions.size,
      requestsPerMin: recentCount,
    });
    return;
  }

  // GET /_api/export/:id.jsonl
  const jsonlMatch = pathname.match(/^\/_api\/export\/([a-f0-9]+)\.jsonl$/);
  if (jsonlMatch) {
    const sid = jsonlMatch[1];
    const sess = sessions.get(sid);
    if (sess) {
      const data = sess.events.map(e => JSON.stringify(e)).join('\n');
      res.setHeader('Content-Type', 'application/x-jsonlines');
      res.setHeader('Content-Disposition', `attachment; filename="${sid}.jsonl"`);
      res.writeHead(200);
      res.end(data);
    } else {
      sendJSON(res, 404, { error: 'session not found' });
    }
    return;
  }

  // GET /_api/export/:id.csv
  const csvMatch = pathname.match(/^\/_api\/export\/([a-f0-9]+)\.csv$/);
  if (csvMatch) {
    const sid = csvMatch[1];
    const sess = sessions.get(sid);
    if (sess) {
      const headers = ['seq', 'timestamp', 'method', 'url', 'status', 'dest', 'mode', 'site', 'ip', 'bytes', 'duration_ms', 'conn_id'];
      let csv = headers.join(',') + '\n';
      for (const ev of sess.events) {
        csv += [
          ev.seq, ev.ts, ev.method, escCsv(ev.url),
          ev.response?.status || '', ev.dest || '', ev.mode || '', ev.site || '',
          ev.remote_ip || '', ev.response?.bytes || 0, ev.duration_ms || 0,
          ev.conn_id || ''
        ].map(escCsv).join(',') + '\n';
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${sid}.csv"`);
      res.writeHead(200);
      res.end(csv);
    } else {
      sendJSON(res, 404, { error: 'session not found' });
    }
    return;
  }

  // GET /_api/events/stream — SSE
  if (pathname === '/_api/events/stream') {
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

  // 404 for unknown /_api routes
  sendJSON(res, 404, { error: 'not found' });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(body);
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

  const wsAccept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC85B178')
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAccept}`,
    '', '',
  ].join('\r\n');

  socket.write(responseHeaders);

  const remoteIp = extractClientIp({ socket }, headerTuples);
  const sessInfo = resolveSession(req, remoteIp, headerTuples);
  const connId = socket.__connId || 'c?';

  const now = new Date();
  const ev = {
    seq: ++seq,
    ts: now.toISOString(),
    ts_unix: now.getTime(),
    conn_id: connId,
    session_id: sessInfo.session_id,
    session_key: sessInfo.session_key,
    method: 'GET',
    url: req.url,
    http_version: req.httpVersion,
    host: getHeader(headerTuples, 'host') || `localhost:${PORT}`,
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
    cf_ipcountry: getHeader(headerTuples, 'cf-ipcountry'),
    x_forwarded_for: getHeader(headerTuples, 'x-forwarded-for'),
  };
  pushEvent(ev);

  // Send "hello" text frame
  const helloPayload = Buffer.from('hello', 'utf8');
  const frame = Buffer.alloc(2 + helloPayload.length);
  frame[0] = 0x81;
  frame[1] = helloPayload.length;
  helloPayload.copy(frame, 2);
  socket.write(frame);

  // Close after 1 second
  setTimeout(() => {
    const closeFrame = Buffer.alloc(2);
    closeFrame[0] = 0x88;
    closeFrame[1] = 0;
    try { socket.write(closeFrame); socket.end(); } catch (_) {}
  }, 1000);

  socket.on('error', () => {});
}

// ---------------------------------------------------------------------------
// Main server — single port
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const connId = req.socket.__connId || 'c?';
  const urlPath = req.url || '/';
  const parsedUrl = new URL(urlPath, 'http://localhost');
  const pathname = parsedUrl.pathname;

  // Dashboard and API routes — excluded from capture logging
  if (pathname.startsWith('/_dashboard') || pathname.startsWith('/_api/')) {
    handleDashboardAPI(req, res, pathname);
    return;
  }

  // Everything else is captured
  handleCaptureRequest(req, res, connId);
});

server.on('connection', (socket) => {
  const id = 'c' + (++connSeq);
  socket.__connId = id;
  const ip = socket.remoteAddress;
  const port = socket.remotePort;
  console.log(`[tcp] ${id} open ${ip}:${port}`);
  socket.on('close', () => {
    console.log(`[tcp] ${id} close ${ip}:${port}`);
  });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    handleWebSocketUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`\n  Request Capture Platform`);
  console.log(`  ========================`);
  console.log(`  Server:     http://localhost:${PORT}`);
  console.log(`  Dashboard:  http://localhost:${PORT}/_dashboard`);
  console.log(`  Test page:  http://localhost:${PORT}/full`);
  console.log(`  Bare page:  http://localhost:${PORT}/bare`);
  console.log(`  Expected:   http://localhost:${PORT}/full.expected.json`);
  console.log(`  SSE stream: http://localhost:${PORT}/_api/events/stream`);
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[error]', err.message);
});
