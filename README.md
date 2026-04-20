# Local › APIWebProxy

A zero-config HTTP/HTTPS proxy with a real-time dashboard — built for developers who need to inspect, debug, and export API traffic from any device on their local network.

Think Charles Proxy, but lightweight, open-source, and runs with a single `npm start`.

![Dashboard](https://img.shields.io/badge/dashboard-localhost%3A9000-blue) ![Proxy](https://img.shields.io/badge/proxy-localhost%3A9999-green) ![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

---

## Why

Most API debugging tools are either too heavy, too expensive, or too complex to set up. APIWebProxy runs entirely on your machine — no cloud, no accounts, no telemetry. Start it, point your device at it, and every request appears in the dashboard instantly.

---

## Features

- **Real-time dashboard** — requests stream in live via WebSocket as they happen
- **HTTP + HTTPS interception** — full MITM proxy with per-domain certificate generation
- **SSL Proxying Settings** — enable/disable HTTPS decryption per host with wildcard pattern support; unmatched hosts pass through as blind tunnels. The same host list also filters plain-HTTP captures, so OS background noise (Windows Update, connectivity probes) stays out of the dashboard.
- **Map Local** — serve matching requests from a local file instead of the remote server
- **Map Remote** — redirect matching requests to a different URL (or local file) with fine-grained `field × operator` conditions
- **Sessions** — create multiple isolated capture sessions and switch between them from the navbar; each session has its own captures, so you can keep kroger vs chick-fil-a traffic (or prod vs staging) cleanly separated
- **Four views** — **Domains** (grouped by host), **Timeline** (chronological), **Debug** (only tool-matched traffic from Map Local / Map Remote), and **Cached** (captured JSON responses grouped by host, replayable at local URLs)
- **Local JSON replay** — any captured JSON response is automatically served back at `http://<ip>:<dashboard-port>/<host>/<path>?<query>` — instant local API mock, one click to copy the replay URL
- **JSON pretty-print** — syntax-highlighted request and response bodies with a JSON toggle
- **HAR export** — export any filtered subset of traffic as a standard `.har` file, importable in Chrome DevTools, Postman, or Charles
- **Smart filter** — type `401` to see only 4xx errors, `post` for POST requests, or any hostname/path/body text
- **Image preview** — binary image responses render inline in the dashboard
- **cURL copy** — one click to copy any request as a `curl` command
- **Pause / resume** — stop recording without losing captured traffic (`Space` to toggle)
- **Multi-device** — proxy traffic from phones, tablets, simulators, or any machine on your network
- **CA certificate install** — built-in setup guide for macOS, Windows, iOS, and Android
- **Auto port recovery** — if the port is in use, the old process is killed and the server retakes it automatically
- **Desktop app** — ships as a native Electron app for macOS, Windows, and Linux with tray icon + start-at-login
- **Zero dependencies** — only `ws` and `node-forge` at runtime, no frameworks

---

## Quick Start

```bash
git clone <repo-url>
cd local-api-web-proxy
npm install
npm run dev
```

Open `http://localhost:9000` — the dashboard is live.

**On your device**, set the WiFi proxy to your machine's IP and port `9999`:

- **macOS:** System Settings → Network → Proxies → Web Proxy + Secure Web Proxy → `<your-ip>:9999`
- **Windows:** Settings → Network → Manual Proxy → `<your-ip>:9999`
- **iOS / Android:** WiFi settings → HTTP Proxy → Manual → `<your-ip>:9999`

---

## Running the Server

| Command | Description |
|---|---|
| `npm run dev` | Start with default ports (proxy `:9999`, dashboard `:9000`) |
| `npm start` | Same as `npm run dev` |
| `npm run start:custom` | Start with ports from env vars `PROXY_PORT` and `DASH_PORT` |

**Custom ports via env vars:**

```bash
PROXY_PORT=8888 DASH_PORT=8000 npm run start:custom
```

**Custom ports via flags:**

```bash
node server.js --proxy-port 8888 --dashboard-port 8000
# or shorthand
node server.js -p 8888 -d 8000
```

---

## HTTPS Setup (one-time per device)

To inspect HTTPS traffic, install the generated CA certificate on each device.

1. Start the server — it auto-generates a CA cert on first run
2. Open `http://<your-ip>:9000` on the device → click **CA Setup**
3. Download `LocalApiWebProxy.crt` and install it following the on-screen guide

The dashboard walks through installation for macOS, Windows, iOS, and Android.

---

## SSL Proxying Settings

**Tools → SSL Proxying Settings…** opens a dialog to control which HTTPS connections are decrypted.

### Enable / Disable

The **Enable SSL Proxying** toggle turns HTTPS decryption on or off globally. When disabled, all `CONNECT` tunnels are passed through as-is — the proxy carries the encrypted bytes without inspecting them.

### Host Filters

The **Locations** list restricts decryption to specific hosts. Add one row per host. Leave the port blank to match any port.

| Pattern | Matches |
|---|---|
| `*` (or empty) | All HTTPS traffic |
| `kroger.com` | `kroger.com` and all subdomains (`www.kroger.com`, `api.kroger.com`, …) |
| `*.kroger.com` | All subdomains of `kroger.com` (and `kroger.com` itself) |
| `kroger.com/*` | Path is ignored — treated the same as `kroger.com` |
| `api.kroger.com` | That exact host only |

Hosts not matched by any row in the list pass through as blind tunnels — their traffic is not decrypted and does not appear in the dashboard.

The same host list also filters **plain-HTTP captures**: requests to non-matching hosts are still forwarded (so Windows Update, connectivity checks, and other OS background traffic keep working), but they are not recorded or shown in the dashboard. This keeps the view focused on the domains you actually care about. If SSL Proxying is disabled entirely, HTTP is captured unfiltered (legacy behaviour).

### Keyboard Navigation

Inside the Locations list:
- `Tab` — move from Host → Port → next row's Host, adding a new row at the end
- `Shift+Tab` — move backwards
- `Enter` — jump to the next row's Host, or add a new row

---

## Map Remote

**Tools → Map Remote…** redirects matching requests to a different URL or a local file. Think "Charles Map Remote" — useful for pointing production traffic at a staging backend, swapping one API for another, or testing against a recorded response.

### Rule model

Each rule has:

- **Conditions** — one or more `field operator value` clauses combined with AND. Fields: `URL`, `HOST`, `PATH`, `METHOD`, `QUERY`, `HEADER`. Operators: `contains`, `equals`, `starts with`, `ends with`, `matches regex`. Case-sensitivity is per-condition (default off).
- **Redirect target** — one of:
  - **Another URL** — rewrite the outbound request to a different host/path. Five per-rule preserve flags: `path`, `query`, `method`, `headers`, `body`.
  - **Local file** — serve the file contents directly. Content-Type is inferred from the file extension (overridable). Default status is `200`.
  - *Mock server* — UI placeholder only. No mock-server subsystem ships with this build.

Rules are evaluated in list order. **First match wins.** Reorder with the ▲/▼ buttons. Matched rows show a cyan indicator and a "Map Remote" pill on the Overview tab linking back to the rule.

### URL composition

Given an original request `https://api.prod.com/v1/users/123?foo=bar` and a target of `https://api.dev.com`:

| preservePath | preserveQuery | Resulting URL |
|---|---|---|
| true  | true  | `https://api.dev.com/v1/users/123?foo=bar` |
| false | true  | `https://api.dev.com/?foo=bar` |
| true  | false | `https://api.dev.com/v1/users/123` |
| false | false | `https://api.dev.com/` |

If the target itself has a path prefix (e.g. `https://api.dev.com/prefix`) and `preservePath=true`, the preserved path is appended to it, and any trailing slash on the prefix is deduped: `→ https://api.dev.com/prefix/v1/users/123`.

If the target has its own query string and `preserveQuery=true`, the two are merged — **target params win on key conflict**.

`preserveMethod=false` forces the outbound request to `GET` and drops the body. `preserveBody=false` drops the body but keeps the method; body-related headers (`Content-Length`, `Transfer-Encoding`, `Content-Type`) are stripped in both cases.

### Loop prevention

Rewritten requests are fired out via a direct `http.request` / `https.request` call — they never re-enter this proxy's request handlers. Each hop is evaluated at most once; there is no risk of infinite rewrite chains even if the target host also matches a Map Remote condition.

### Cross-protocol redirects

HTTP → HTTPS and HTTPS → HTTP rewrites are allowed. When the rule's conditions reference a source protocol that differs from the target's protocol, the editor shows a warning — some clients (browsers especially) may reject the mixed-content response even though the proxy sent it.

### Import / export

The rules list has **Export** (downloads all rules as JSON) and **Import** buttons. Rules are an array of `MapRemoteRule` objects and survive the session only — they are re-loaded every time the server restarts (in-memory, like Map Local).

### Test a condition

Click the flask icon on any condition row to paste a sample URL and see whether the condition would match. Useful for iterating on regex without running real traffic.

---

## Sessions

The navbar has a **Session** dropdown (📁 Session 1 · N ⌄) that lets you keep captures isolated in separate sessions. Useful when you're inspecting more than one app in the same sitting and don't want the traffic to mix.

- **+ New Session** — creates a fresh session named `Session 2`, `Session 3`, … and switches to it. New captures go only into this session.
- Click any session row in the popover to switch to it. The dashboard re-renders with that session's captures; the other sessions stay intact.
- Hover a non-active session to reveal a delete button (the active session and the last remaining session can't be deleted — by design).
- The **Clear** button in the toolbar only clears the **active** session, so it's safe to use without blowing away traffic in other sessions.

Sessions are in-memory only. Restarting the server resets to a fresh `Session 1`. Map Local / Map Remote rules and the SSL Proxying filter are **global** — they apply to every session.

---

## Views

The toolbar under the navbar switches between four views of the same captures:

- **Domains** — groups requests by host with expand/collapse per domain.
- **Timeline** — flat chronological list, newest first.
- **Debug** — only shows requests matched by a Tools-menu feature (Map Local, Map Remote). Has a filter-chip row at the top to narrow to a single tool, plus a count badge on the tab.
- **Cached** — only shows successful JSON GET responses, grouped by host. Each row has a `↗` open-in-new-tab link and a 📋 copy button for the **replay URL**.

### Local JSON replay (Cached view)

Every cacheable capture — `GET` + 2xx + JSON `Content-Type` + non-empty body — is automatically served back at:

```
http://<dashboard-ip>:<dashboard-port>/<host>/<path>?<query>
```

So if the proxy captured `GET https://www.kroger.com/all/coupons?couponid=600`, the same JSON can be fetched from:

```
http://localhost:9000/www.kroger.com/all/coupons?couponid=600
```

Exact path + query match — `?couponid=600` and `?couponid=700` are treated as separate endpoints. The response comes back with the original `Content-Type` plus custom headers: `X-Cached-From`, `X-Cached-At`, `X-Cache-Id`, and `X-Cache-Truncated` (true if the capture hit the 256 KB body cap). `Cache-Control: no-store` prevents the browser from caching it further.

When the host matches a capture we have but the specific path doesn't, the server returns a 404 with a JSON hint explaining that the URL needs to be captured first. This disambiguation check protects the dashboard's own static assets (`app.js`, `styles.css`, `/ca.crt`) — they're never shadowed.

The **Cached URL** also appears as a dedicated row in the Overview tab of the detail panel when you click into a cacheable capture, with the same copy / open-in-new-tab affordances.

**Limits worth knowing:**
- GET only in v1. POST/PUT/DELETE are semantically trickier and aren't replayed.
- In-memory only. When captures are cleared or age out of the 2000-capture ring buffer, the cache URL starts returning 404.
- Response bodies over 256 KB are truncated (same cap as everything else in the proxy); the `X-Cache-Truncated: true` header tells clients when that happened.

---

## Desktop App (Electron)

Same codebase also ships as a native desktop app for macOS, Windows, and Linux — the dashboard runs in a BrowserWindow, the proxy runs in the main process, and a tray icon keeps it alive in the background.

### Run in dev

```bash
npm install
npm run electron:dev
```

This launches Electron pointing at the local dashboard. Use `PROXY_PORT` / `DASH_PORT` env vars to override defaults.

> **Note:** if `ELECTRON_RUN_AS_NODE=1` is set in your shell, the dev launcher (`electron/dev.js`) automatically strips it before spawning — required because that env var forces Electron into Node-mode and breaks the GUI.

### Build distributables

| Command | Output |
|---|---|
| `npm run dist:mac` | `dist/LocalAPIWebProxy-1.0.0-arm64.dmg` (Apple Silicon) |
| `npm run dist:mac15` | `dist-mac15/LocalAPIWebProxy-1.0.0-mac15-universal.dmg` (x64 + arm64, with `NSLocalNetworkUsageDescription`) |
| `npm run dist:win` | `dist/LocalAPIWebProxy-1.0.0-setup.exe` (NSIS installer, x64) |
| `npm run dist:linux` | `dist/LocalAPIWebProxy-1.0.0.AppImage` (x64) |

macOS builds must be run on macOS; Windows on Windows; Linux on Linux (or inside a matching Docker image). Code-signing is disabled by default — set `CSC_LINK` / `CSC_KEY_PASSWORD` (macOS) or `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` (Windows) to enable it.

### Packaged app behavior

- The CA certificate + leaf keys are stored in the OS's per-user app data directory (`app.getPath('userData')/certs`), not inside the app bundle — so they persist across updates and the bundle stays read-only.
- Closing the main window hides it; the tray keeps the proxy listening. Use **Tray → Quit** to fully stop.
- A single-instance lock ensures a second launch focuses the existing window instead of starting a second proxy.
- **Start at login** is enabled automatically on first launch and can be toggled any time via **Tray → Start at login**. The OS-level autostart registers the app with `--hidden` so it wakes up in the tray only (no window flash). Implementation: macOS + Windows use Electron's built-in `app.setLoginItemSettings()`; Linux writes `~/.config/autostart/LocalAPIWebProxy.desktop`.

### App icon

`scripts/generate-icon.js` produces two files from the same source — both platform-ready, zero dependencies:

- `resources/icon.png` — 1024×1024 PNG with an indigo rounded-square background and a white globe (outer ring + equator + central meridian + side meridians). Used directly by the Linux AppImage; electron-builder auto-generates `.icns` from it for the macOS dmg.
- `resources/icon.ico` — multi-size Windows icon (16/24/32/48/64/128/256) generated by downsampling the 1024 canvas with an alpha-weighted box filter and packing BMP-encoded entries into the ICO container. Required separately from the PNG because NSIS's `MUI_ICON` / `MUI_UNICON` (the installer wizard icons) don't accept PNG.

To tweak the design — e.g. change colour, stroke thickness, or add more latitude/meridian lines — edit the drawing section at the top of the script and run:

```bash
node scripts/generate-icon.js
```

The same icon is used by the tray when the app runs packaged.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Pause / resume recording |
| `E` | Export visible requests as HAR |
| `↑ ↓` | Navigate request list |
| `Esc` | Deselect request |

---

## Filter Syntax

| Query | Result |
|---|---|
| `401` | Status 401 only |
| `5` | All 5xx responses |
| `post` | POST requests only |
| `api.example.com` | Requests to that host |
| `authorization` | Requests containing that header/body text |

---

## HAR Export

Click **Export HAR** (or press `E`) to download a `.har` file of all currently visible requests. Apply a filter first to export only the traffic you care about.

HAR files are compatible with:
- Chrome DevTools → Network → Import HAR
- Postman → Import
- Charles Proxy → Import Session
- [har.tech](https://har.tech) and other online viewers

---

## Binary Responses

Non-text responses are handled automatically:
- **Images** — rendered inline in the Response tab
- **Other binary** — content-type and size are displayed
- **Raw access** — `GET /api/captures/:id/body` serves the raw bytes for any capture

---

## Architecture

```
┌─────────────────────┐        ┌────────────────────────┐
│   Device / Browser  │──────▶ │  Proxy  :9999          │
│  (proxy configured) │        │  HTTP + HTTPS MITM     │
└─────────────────────┘        │  Per-domain TLS certs  │
                                │  Map Local / Remote    │
                                └──────────┬─────────────┘
                                           │ capture (active session)
                                ┌──────────▼─────────────┐
                                │  Dashboard  :9000       │
                                │   · Static files        │
                                │   · WebSocket broadcast │
                                │   · /api/sessions, etc. │
                                │   · /<host>/<path>      │
                                │     JSON cache replay   │
                                └────────────────────────┘
```

- HTTPS interception uses `node-forge` to sign per-domain certificates on demand
- A shared leaf RSA key pair is generated once — only fast certificate signing happens per domain
- Responses are decompressed (gzip, deflate, brotli) before forwarding so browsers render correctly
- `Alt-Svc` headers are stripped to prevent QUIC/HTTP3 bypass
- Each capture lives inside an active session; Map Local, Map Remote, and the SSL filter are global across sessions
- Dashboard routes are disambiguated so the JSON-replay route (`/<host>/<path>`) never shadows static assets

---

## Limitations

| Scenario | Status |
|---|---|
| HTTP traffic | ✅ Full interception |
| HTTPS traffic (macOS/Windows/Chrome) | ✅ Works with CA installed |
| Chrome on Android | ✅ Works |
| Native Android apps (API 24+) | ⚠️ Debug builds only — see below |
| Apps with certificate pinning (banking, etc.) | ❌ Not interceptable by design |
| Google.com in Chrome | ❌ Hardcoded certificate pinning |

These are OS and app-level restrictions — the same limitations apply to Charles Proxy, mitmproxy, and Burp Suite.

---

## Intercepting HTTPS in Your Android App (Debug Builds)

Android 7+ (API 24) blocks user-installed CA certificates in apps by default. For **debug builds**, you can opt in by adding a Network Security Configuration.

**1. Create `res/xml/network_security_config.xml`:**

```xml
<network-security-config>
    <debug-overrides>
        <trust-anchors>
            <!-- Trust user-added CAs in debug builds only -->
            <certificates src="user" />
        </trust-anchors>
    </debug-overrides>
</network-security-config>
```

**2. Reference it in `AndroidManifest.xml`:**

```xml
<application
    android:networkSecurityConfig="@xml/network_security_config"
    ... >
```

**3. Install the CA cert on the device:**

Open `http://<your-mac-ip>:9000` in Chrome on the device → **CA Setup** → download and install `LocalApiWebProxy.crt`.

**4. Set the WiFi proxy** to `<your-mac-ip>:9999`.

> This only applies to debug builds (`debuggable="true"`). Release builds are unaffected — user CAs are never trusted in production.

---

## Stack

- **Runtime:** Node.js (no framework)
- **TLS / Certificates:** `node-forge`
- **WebSocket:** `ws`
- **Frontend:** Vanilla JS + CSS (no build step)

---

## License

MIT
