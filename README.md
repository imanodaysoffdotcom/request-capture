# Request Capture Platform

A zero-dependency Node.js server that captures every HTTP request with full fidelity, preserving raw headers in wire order. Serves a rich, real-time dashboard on the same port.

## Quick Start

```bash
cd request-capture
node server.js
```

Then open:
- **http://localhost:8080/_dashboard** — full-featured request viewer dashboard
- **http://localhost:8080/full** — comprehensive test page that triggers 30+ request types
- **http://localhost:8080/bare** — minimal HTML5 page (baseline comparison)

## Architecture

Everything runs on a single port (8080), making it compatible with Render's free tier and other single-port platforms.

```
:8080 Single Server
  |
  +-- /_dashboard          → Rich viewer dashboard (HTML + inline CSS/JS)
  +-- /_api/sessions       → List all sessions (JSON)
  +-- /_api/session/:id    → Events for a session (JSON)
  +-- /_api/events?since=N → Events since sequence N (JSON)
  +-- /_api/stats          → Current stats (JSON)
  +-- /_api/events/stream  → SSE live feed
  +-- /_api/export/:id.jsonl → Download session as JSONL
  +-- /_api/export/:id.csv → Download session as CSV
  +-- DELETE /_api/session/:id → Clear a session
  |
  +-- /full                → Comprehensive test page
  +-- /bare                → Minimal page
  +-- /api/*               → JSON echo with CORS
  +-- /ws                  → WebSocket handshake
  +-- /css, /js, /img      → Sub-resources (echo by type)
  +-- *                    → Smart response by file extension
  |
  +--------> Ring buffer (10,000 events)
  +--------> logs/<session>.jsonl (persisted)
  +--------> stdout summary
```

All requests to `/_dashboard` and `/_api/*` are excluded from the capture log.

## Dashboard Features

- **Session sidebar** — lists all sessions with request count, IP, user agent, last seen
- **Request table** — sortable columns: Seq, Time, Method, URL, Status, Dest, Mode, Site, IP, Size, Duration
- **Click to expand** — shows all headers, request body, response info, connection info, fetch metadata
- **Search/filter** — filter by URL, method, status, IP, content type
- **Quick filters** — Documents, API, Assets, Errors, All
- **Real-time updates** — SSE pushes new requests live
- **Stats bar** — total requests, unique IPs, active sessions, requests/min
- **Request timeline** — visual sparkline of the last 5 minutes
- **Export** — JSONL or CSV download
- **Diff tool** — compare captured requests against expected (`/full.expected.json`)
- **Connection view** — group requests by TCP connection ID
- **IP lookup** — click any IP to open ipinfo.io
- **Mobile responsive** — works on phone screens
- **Keyboard shortcuts** — `/` to focus search, `Esc` to close modals

## What It Captures

Every request is logged with:

- Sequential ID, ISO timestamp, Unix timestamp (ms)
- Method, full URL, path, query string
- HTTP version
- All headers as ordered `[name, value]` pairs (from `req.rawHeaders`)
- Remote IP (with X-Forwarded-For extraction) and port
- Request body (up to 1MB, UTF-8)
- Response status, content-type, bytes sent
- Duration in ms
- Client abort detection
- Connection ID (TCP socket tracking)
- Session ID (cookie-based with IP+UA fallback)
- Promoted fields: Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, Referer, Accept, User-Agent, Sec-CH-UA, Priority, Purpose
- GeoIP hint headers (CF-IPCountry, X-Forwarded-For) when available

## Persistence

Data is written to `logs/<session_id>.jsonl` files. On startup, the server reloads from the `logs/` directory so data survives restarts.

## Deploy

### Docker

```bash
docker build -t request-capture .
docker run -p 8080:8080 request-capture
```

### Render

Set the start command to `node server.js`. The server uses the `PORT` environment variable (defaults to 8080).

## Testing

```bash
cd test
npm install
npx playwright install chromium
npm test
```

## Why Node

- `req.rawHeaders` preserves original capitalization, wire order, and duplicate headers
- Zero dependencies — ships with `http`, `crypto`, `fs`, `path`
- WebSocket handshake via `crypto.createHash('sha1')`
- Connection-level tracking via `server.on('connection')`
