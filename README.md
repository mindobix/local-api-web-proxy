# Local › APIWebProxy

A zero-config HTTP/HTTPS proxy with a real-time dashboard — built for developers who need to inspect, debug, and export API traffic from any device on their local network.

Think Charles Proxy, but lightweight, open-source, and runs with a single `npm start`.

![Dashboard](https://img.shields.io/badge/dashboard-localhost%3A8000-blue) ![Proxy](https://img.shields.io/badge/proxy-localhost%3A8888-green) ![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

---

## Why

Most API debugging tools are either too heavy, too expensive, or too complex to set up. APIWebProxy runs entirely on your machine — no cloud, no accounts, no telemetry. Start it, point your device at it, and every request appears in the dashboard instantly.

---

## Features

- **Real-time dashboard** — requests stream in live via WebSocket as they happen
- **HTTP + HTTPS interception** — full MITM proxy with per-domain certificate generation
- **SSL Proxying Settings** — enable/disable HTTPS decryption per host with wildcard pattern support; unmatched hosts pass through as blind tunnels
- **Domains + Timeline views** — browse traffic grouped by host or in chronological order
- **JSON pretty-print** — syntax-highlighted request and response bodies with a JSON toggle
- **HAR export** — export any filtered subset of traffic as a standard `.har` file, importable in Chrome DevTools, Postman, or Charles
- **Smart filter** — type `401` to see only 4xx errors, `post` for POST requests, or any hostname/path/body text
- **Image preview** — binary image responses render inline in the dashboard
- **cURL copy** — one click to copy any request as a `curl` command
- **Pause / resume** — stop recording without losing captured traffic (`Space` to toggle)
- **Multi-device** — proxy traffic from phones, tablets, simulators, or any machine on your network
- **CA certificate install** — built-in setup guide for macOS, Windows, iOS, and Android
- **Auto port recovery** — if the port is in use, the old process is killed and the server retakes it automatically
- **Zero dependencies** — only `ws` and `node-forge`, no frameworks

---

## Quick Start

```bash
git clone <repo-url>
cd local-api-web-proxy
npm install
npm run dev
```

Open `http://localhost:8000` — the dashboard is live.

**On your device**, set the WiFi proxy to your machine's IP and port `8888`:

- **macOS:** System Settings → Network → Proxies → Web Proxy + Secure Web Proxy → `<your-ip>:8888`
- **Windows:** Settings → Network → Manual Proxy → `<your-ip>:8888`
- **iOS / Android:** WiFi settings → HTTP Proxy → Manual → `<your-ip>:8888`

---

## Running the Server

| Command | Description |
|---|---|
| `npm run dev` | Start with default ports (proxy `:8888`, dashboard `:8000`) |
| `npm start` | Same as `npm run dev` |
| `npm run start:custom` | Start with ports from env vars `PROXY_PORT` and `DASH_PORT` |

**Custom ports via env vars:**

```bash
PROXY_PORT=9999 DASH_PORT=9000 npm run start:custom
```

**Custom ports via flags:**

```bash
node server.js --proxy-port 9999 --dashboard-port 9000
# or shorthand
node server.js -p 9999 -d 9000
```

---

## HTTPS Setup (one-time per device)

To inspect HTTPS traffic, install the generated CA certificate on each device.

1. Start the server — it auto-generates a CA cert on first run
2. Open `http://<your-ip>:8000` on the device → click **CA Setup**
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

### Keyboard Navigation

Inside the Locations list:
- `Tab` — move from Host → Port → next row's Host, adding a new row at the end
- `Shift+Tab` — move backwards
- `Enter` — jump to the next row's Host, or add a new row

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
│   Device / Browser  │──────▶ │  Proxy  :8888          │
│  (proxy configured) │        │  HTTP + HTTPS MITM     │
└─────────────────────┘        │  Per-domain TLS certs  │
                                └──────────┬─────────────┘
                                           │ capture
                                ┌──────────▼─────────────┐
                                │  Dashboard  :8000       │
                                │  WebSocket broadcast    │
                                │  Static file server     │
                                └────────────────────────┘
```

- HTTPS interception uses `node-forge` to sign per-domain certificates on demand
- A shared leaf RSA key pair is generated once — only fast certificate signing happens per domain
- Responses are decompressed (gzip, deflate, brotli) before forwarding so browsers render correctly
- `Alt-Svc` headers are stripped to prevent QUIC/HTTP3 bypass

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

Open `http://<your-mac-ip>:8000` in Chrome on the device → **CA Setup** → download and install `LocalApiWebProxy.crt`.

**4. Set the WiFi proxy** to `<your-mac-ip>:8888`.

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
