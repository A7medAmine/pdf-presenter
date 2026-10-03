# PDF Presenter

> Open-source PDF slide presenter with **real-time remote control** from any device.

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-green)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.18-green)

---

## Features

| Feature            | Details                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| Sharp rendering    | PDF.js at device-pixel resolution, so text stays crisp on phones and Retina screens |
| Remote control     | Control slides from a phone or tablet; the presenter approves each device once |
| Viewer mode        | Read-only audience view that follows the presenter live                  |
| Password sessions  | Optional viewer password                                                 |
| Real-time sync     | WebSockets keep presenter, remotes and viewers on the same slide         |
| Survives reloads   | Reloading the presenter page restores the session and slide              |
| Pointer            | Drag on the remote to show a red dot on every screen                     |
| Speaker notes      | Private notes and a teleprompter on the remote                           |
| Swap PDFs live     | Change the PDF mid-session; everyone follows automatically               |
| PDF links          | Web links and internal "go to page" links in the PDF are clickable      |
| Keyboard & clickers| Arrows, Space, Page Up/Down, Home/End and Bluetooth presentation clickers |
| Thumbnail strip    | Jump to any slide (thumbnails render lazily, even for long decks)        |
| Fullscreen         | On the presenter, viewer and remote ("big buttons" mode)                 |
| Dark / light theme | Remembered per browser                                                   |
| Offline ready      | All libraries, fonts and PDF.js font data are bundled, no internet needed |

---

## Video Tutorial

[![Watch the Video Tutorial](https://img.youtube.com/vi/KxRDcmIOq4s/0.jpg)](https://youtu.be/KxRDcmIOq4s)

The video covers installation, starting the app, remote control setup and the main features.

---

## Quick Start

### Automatic installation (recommended)

**Linux / macOS**

```bash
git clone https://github.com/A7medAmine/pdf-presenter.git
cd pdf-presenter
chmod +x linux-install.sh start-app-lnx.sh
./linux-install.sh      # once: installs Node.js 22 if needed + dependencies
./start-app-lnx.sh      # every time
```

**Windows**

```batch
git clone https://github.com/A7medAmine/pdf-presenter.git
cd pdf-presenter
windows-install.bat     :: once
start-app-win.bat       :: every time
```

When the server starts, it prints the local URL and the network URLs that phones on the same Wi-Fi can open.

### Manual installation

Requires **Node.js 18.18 or newer** (22 LTS recommended).

```bash
npm install --omit=dev
npm start               # http://localhost:3000
```

### Docker

```bash
docker compose up -d          # build and start
docker compose logs -f        # follow logs
docker compose down           # stop
```

The like counter is stored in the `pdf-presenter-data` volume. Uploaded PDFs are temporary by design: they are deleted when their session ends, so they need no volume.

---

## Using it

1. Open `http://localhost:3000` and click **Start Session**. A name and a viewer password are optional.
2. Upload a PDF (drag & drop or browse).
3. **Remote**: click **Remote** and scan the QR code with your phone. The presenter gets an approval request. Once accepted, the device can reconnect without asking again for the rest of the session.
4. **Viewers**: click **Viewer**, pick the orientation, and share the QR code or link. Viewers can also find public sessions at `/access`.

> **Phones can't connect?** In the Remote dialog, set **Server address** to your computer's LAN IP (detected automatically) and click **Apply**. Phones must be on the same network, and your firewall must allow port 3000.

### Keyboard shortcuts (presenter)

| Key                               | Action                       |
| --------------------------------- | ---------------------------- |
| `→` `↓` `Space` `Page Down`       | Next slide                   |
| `←` `↑` `Page Up`                 | Previous slide               |
| `Home` / `End`                    | First / last slide           |
| `F`                               | Toggle fullscreen            |
| `Esc`                             | Close dialog / cancel PDF swap |

Click the session name in the top bar to rename it.

---

## Configuration

Set environment variables, or copy `.env.example` to `.env`. Real environment variables always win over `.env`.

| Variable            | Default   | Description                                                           |
| ------------------- | --------- | --------------------------------------------------------------------- |
| `PORT`              | `3000`    | HTTP port                                                             |
| `HOST`              | `0.0.0.0` | Bind address                                                          |
| `NODE_ENV`          | `development` | `production` enables production defaults                          |
| `LOG_LEVEL`         | `info` (prod) / `debug` | `silent`, `error`, `warn`, `info`, `debug`              |
| `SESSION_TTL`       | `4`       | Hours a session may stay idle **without a connected presenter** before removal (sessions also end after 24 h regardless) |
| `MAX_FILE_SIZE`     | `100`     | Max PDF size in MB                                                    |
| `RATE_LIMIT_WINDOW` | `60`      | Session-creation rate-limit window, in minutes                        |
| `RATE_LIMIT_MAX`    | `20`      | Sessions one IP may create per window                                 |
| `TRUST_PROXY`       | unset     | Set to `1` behind **one** reverse proxy so client IPs and HTTPS are detected correctly |
| `UPLOAD_DIR`        | `uploads` | Where PDFs are stored while their session is alive                    |
| `DATA_DIR`          | `data`    | Where persistent state (likes) is stored                              |

### Reverse proxy (nginx)

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 100m;
}
```

Run the app with `TRUST_PROXY=1` behind a proxy. Any Node.js host with WebSocket support works (Railway, Render, Fly.io, a VPS…).

---

## Security model

- **No accounts, no cookies.** Each session has random secrets:
  - **Presenter token**: returned once on creation and kept in the presenter tab's `sessionStorage`. It is required to upload PDFs, read the full session state and rejoin as presenter. A reload or new tab with the token takes over; the old tab is notified.
  - **Access token**: embedded in PDF URLs (`/uploads/<random>.pdf?t=…`) and only handed out over the WebSocket after a successful join. Without it, PDFs return 404.
  - **Viewer token**: issued after a correct viewer password and valid for the session's lifetime.
- **Remotes** need presenter approval. Approval is remembered per device for the session, and devices can be blocked.
- Passwords are hashed with **scrypt**. Password attempts are rate-limited per IP and session.
- Uploads are capped in size, stored under random names, and checked for a PDF header. A replaced or ended PDF is deleted immediately, and leftovers are purged on startup.
- Strict **Content-Security-Policy**: no inline scripts, no third-party origins. WebSocket handshakes from other origins are refused.
- All socket events are validated, typed and rate-limited per connection. Malformed input gets an error response; it never crashes the server.

> Session IDs are listed publicly on `/access`. Protect sensitive presentations with a viewer password.

---

## Development

```bash
npm install          # including dev dependencies
npm run dev          # restart on file changes (node --watch)
npm test             # node:test suite: HTTP API, sockets, security helpers
npm run lint         # ESLint
npm run check        # lint + tests (same as CI)
```

### Project structure

```
pdf-presenter/
├── server.js                 # Entry point: config, listen, graceful shutdown
├── src/
│   ├── app.js                # Assembles HTTP + Socket.io (no side effects, testable)
│   ├── config.js             # Environment/.env parsing with safe defaults
│   ├── http.js               # Security headers, static files, REST API, PDF delivery
│   ├── realtime.js           # Socket.io roles, events, approval flow, expiry sweeper
│   ├── session-store.js      # In-memory sessions + PDF file lifecycle
│   ├── likes-store.js        # Like counter with atomic, debounced persistence
│   ├── security.js           # IDs, tokens, scrypt, sanitizers, validators
│   ├── network.js            # LAN address discovery
│   └── logger.js             # Leveled logger
├── public/
│   ├── index.html            # Presenter
│   ├── viewer.html           # Audience view
│   ├── remote.html           # Phone remote
│   ├── access.html           # Session directory
│   ├── js/
│   │   ├── presenter.js, viewer.js, remote.js, access.js   # Page modules
│   │   └── lib/
│   │       ├── common.js         # Shared helpers (API, storage, theme, fullscreen…)
│   │       ├── pdf-renderer.js   # HiDPI renderer with LRU cache and "latest wins" queue
│   │       └── dhikr.js          # Periodic reminders
│   ├── css/                  # style.css + self-hosted fonts.css
│   ├── fonts/  sounds/  favicon/
│   └── vendor/               # PDF.js 3.11.174 (+ cmaps, standard fonts), QRious
├── test/                     # node:test suites
├── Dockerfile, docker-compose.yml
└── linux-install.sh, windows-install.bat, start-app-*.{sh,bat}
```

### Socket.io protocol (summary)

Client → server events reply through an acknowledgement: `{ ok: true, ... }` or `{ ok: false, code, message }`.

| Event                     | Who       | Payload                                          |
| ------------------------- | --------- | ------------------------------------------------ |
| `join-session`            | presenter / viewer | `{ sessionId, role, presenterToken? , viewerToken? }` → `{ state }` |
| `remote-request-access`   | remote    | `{ sessionId, deviceId }` → `{ status: "approved" \| "pending" }` |
| `remote-accept` / `remote-reject` / `remote-block` | presenter | `{ remoteSocketId }` |
| `toggle-remote-requests`  | presenter | `{ enabled }`                                    |
| `slide-change`            | presenter / remote | `{ slide }` or `{ direction: "next" \| "prev" }` |
| `set-total-slides`        | presenter | `{ totalSlides }`                                |
| `cursor-move`             | remote    | `{ x, y, active }` (no ack, volatile)            |
| `rename-session` / `end-session` | presenter | `{ name }` / `{}`                        |
| `request-session-state`   | any member | `{}` → `{ state }`                              |

Server → client: `slide-update`, `total-slides-update`, `pdf-loaded`, `presence`, `presenter-status`, `session-renamed`, `session-ended`, `cursor-move`, `remote-pending`, `remote-request-cancelled`, `remote-approved`, `remote-rejected`, `presenter-replaced`.

---

## Tech stack

| Layer         | Technology                                                   |
| ------------- | ------------------------------------------------------------ |
| Frontend      | Vanilla HTML, CSS and ES modules (no build step)             |
| PDF rendering | [PDF.js](https://mozilla.github.io/pdf.js/) 3.11             |
| Backend       | [Express](https://expressjs.com/) 4, [Socket.io](https://socket.io/) 4, [Multer](https://github.com/expressjs/multer) 2 |
| QR codes      | [QRious](https://github.com/neocotic/qrious)                 |
| Tests / lint  | `node:test`, ESLint 9                                        |

---

## License

Apache License 2.0. See [LICENSE](LICENSE). Bundled fonts (DM Sans, DM Mono, Syne, Amiri) are under the SIL Open Font License. PDF.js is under Apache-2.0.
