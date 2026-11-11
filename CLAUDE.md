# CLAUDE.md

Internal documentation for the passkeys demo. User-facing docs live in `README.md`; environment variables are documented only in `.env.example`.

## Purpose

A guided, live demo of the **Credential Overwrite → Account Takeover** attack (paper: *The State of Passkeys*, USENIX Security 2026, §6.2.2 "Swap credid"; WebAuthn §7.1.26) on the Fun with Flags and Passkeys CTF (`learning.passkeys.tools`, verifier #60 "Cred Overwrite"), using PASSKEYS-ATTACKER (`passkeys.tools` frontend + Chrome extension + `db.passkeys.tools` remote storage).

## Tech Stack

- **app**: Node.js 22 (ESM, no build step for server code), Express 5, `ws`, `playwright-core` (CDP client only, no bundled browsers), noVNC 1.4 client bundled with esbuild, vanilla JS/CSS frontend.
- **browser**: Debian bookworm, Chromium (called directly at `/usr/lib/chromium/chromium` to bypass the Debian wrapper, which injects its own `--load-extension=`), TigerVNC `Xvnc`, `socat`.

## Project Structure

```
.
├── app/                         # Demo website + orchestrator (one container)
│   ├── Dockerfile
│   ├── client/rfb.js            # esbuild entry: re-exports noVNC's CommonJS RFB as ESM → dist/rfb.js
│   ├── public/                  # Static UI: index.html, style.css, app.js (served at /)
│   └── src/
│       ├── server.js            # HTTP server, /ws (state), /vnc/:role (VNC bridge), basic auth
│       ├── config.js            # Env-var configuration
│       ├── auth.js              # Basic auth + derived cookie (for WebSocket upgrades)
│       ├── vnc-proxy.js         # WebSocket ↔ TCP bridge (websockify equivalent)
│       ├── browser-controller.js# CDP control of one browser: connect/restart, pages, events, snapshots, highlights
│       ├── page-scripts.js      # Functions evaluated inside the browsers (snapshots, highlights, Send capture)
│       ├── setup.js             # Behind-the-scenes setup run on start and on every reset
│       ├── passkeys-tools-store.js # Minimal db.passkeys.tools client (secret generation, key listing)
│       ├── scenario.js          # The guided steps: texts, done predicates, highlights, autopilot actions
│       ├── demo.js              # DemoController: state machine, facts, DB model, tick loop, published state
│       └── log.js
├── browser/                     # One image, run twice (victim, attacker)
│   ├── Dockerfile               # Bakes the passkeys.tools extension (git ref build arg)
│   └── entrypoint.sh            # Xvnc + socat + Chromium restart loop + managed policies
├── docker-compose.dev.yml       # Local builds, app src/public mounted, node --watch
├── docker-compose.prod.yml      # GHCR images
└── .github/workflows/docker.yml # Builds and pushes both images to GHCR
```

## Architecture

```
Viewer ──HTTP/WS──▶ app ──CDP (IP:9223)──▶ victim   (Chromium + Xvnc :5900)
                     │  └─TCP (5900)────────▶ attacker (Chromium + Xvnc :5900)
                     └─ /ws: JSON state push, UI actions back
```

- **Browsers**: each browser container runs `Xvnc` (display + VNC server), `socat` to expose Chromium's localhost-only DevTools port 9222 as 9223, and Chromium in a loop. When Chromium exits, the loop wipes the profile and starts it again. **Reset** relies on this: the app sends `Browser.close` over CDP and reconnects to the fresh instance, so the extension is effectively reinstalled. The VNC stream survives resets.
- **CDP addressing**: Chromium rejects DevTools HTTP requests whose `Host` header is a hostname, so the app resolves the service name to an IPv4 address and connects by IP.
- **Skins and lockdown**: `entrypoint.sh` writes `/etc/chromium/policies/managed/demo.json` from env: `BrowserThemeColor` (no theme-install infobar, unlike a theme extension), no password manager or translate prompts, popups allowed (the extension opens its interceptor via `window.open` after an async fetch), and `URLBlocklist ["*"]` + `URLAllowlist` (navigations only; subresources such as flag images still load).
- **Extension**: Chromium writes the extension's indexed declarativeNetRequest ruleset into the unpacked extension directory (`_metadata/`). If that directory is not writable for the browser user, loading fails ("rules.json: Internal error while parsing rules"), and Chromium then never opens its DevTools port. The Dockerfile therefore chowns the extension directory to the browser user. The extension ID is derived from its path (`sha256(path)` → first 32 hex chars mapped to a–p); `setup.js` computes it to open `popup.html` and write `chrome.storage.local`.

### Setup (`setup.js`)

Run on app start and on every reset, with a new random passkeys.tools secret and a new CTF instance UUID each time:

1. Restart both browsers (fresh profiles).
2. Extension storage: `interceptorMode` = `profile1` (victim) / `profile2` (attacker), `popupMode` = `inline` (interceptor opens as a tab, which reads best over VNC), `frontendUrl`.
3. passkeys.tools `localStorage.storageConfig` = remote + E2EE with the shared secret. **Sequential on purpose**: the frontend generates missing profile keys on load, so the victim browser generates them first (waits for `.tab-content.loaded`) and the attacker browser then finds them. Running both at once races and can replace keys.
4. CTF cookies `fwf_instance_id` (shared UUID, same effect as "Switch Instance"), `fwf_verifier_reg` (60), `fwf_verifier_auth` (2), then load the CTF in both.

### Guide engine (`scenario.js`, `demo.js`)

- A **tick** (500 ms) snapshots both browsers (CTF page: path, logged-in user, form/modal state; interceptor tab: op and selected options), draws the current task's highlight in the focused browser, and publishes state if it changed.
- **Task `done` predicates are evaluated live and never latched**, and each one also accepts all later states of the flow. The first unfinished task is therefore always the correct next action, including after detours (closed interceptor, wrong selection sent). Completion of a step depends only on **facts**.
- **Facts** come from events: `passkey-result` (CTF `/api/passkey/{registration,authentication}/verify` responses, captured via Playwright network events, with the credential ID taken from the request body) and `interceptor-send` (an init script reports the interceptor's selection at the exact moment Send is clicked, via `exposeBinding`). Facts: usernames, victim passkey, overwrite (+ reward), takeover, lockout, last login.
- The **database view** is a model built from those facts. A registration with a known credential ID that carries a reward means the stored key was overwritten. Key owner = `profile1` → victim, `profile2` → attacker.
- **Autopilot** runs the remaining tasks' `run()` functions with Playwright in the real browsers, waiting for each task's predicate before the next one. The live highlights make each action visible.
- Texts are HTML authored in `scenario.js`; `{victim}`, `{attacker}` and `{flag}` are replaced server-side, with user-typed names escaped.

### UI (`public/`)

- One WebSocket (`/ws`) pushes the whole state as JSON; the client renders each section only when its inputs change, so CSS animations don't restart.
- noVNC uses `scaleViewport`. Both panels have equal width, because the 16:10 screens are height-bound at 1080p and a wider active panel would only add letterboxing. The active browser gets a glow and a "Your turn" chip; the other one is dimmed.
- Celebration overlays cover the *non-acting* browser, so the real result (e.g. the CTF's flag modal) stays visible.

## Conventions

- All configuration via env vars (see `.env.example`). Steps/texts live only in `scenario.js`.
- Code in `page-scripts.js` runs inside the browsers and must be self-contained.
- After changing selectors of the CTF or passkeys.tools UIs, re-run the full flow (all steps with "Do it for me").
- Public instances shuffle reward flags (`REWARD_FLAG_ORDER`), so never hardcode the flag country; it is read from the reward response.
