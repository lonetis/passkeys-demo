# CLAUDE.md

Internal documentation for the passkeys demo. User-facing docs live in `README.md`; environment variables are documented only in `.env.example`.

## Purpose

Guided, live demos of the **Credential Overwrite → Account Takeover** attack (paper: *The State of Passkeys*, USENIX Security 2026, §6.2.2 "Swap credid", §6.2.7 credential ID leak via `allowCredentials`; WebAuthn §7.1.26) on the Fun with Flags and Passkeys CTF (`learning.passkeys.tools`, verifier #60 "Cred Overwrite"), using PASSKEYS-ATTACKER (`passkeys.tools` frontend + Chrome extension + `db.passkeys.tools` remote storage).

Two scenarios ("versions"), each run as an independent **demo instance** on its own pair of browsers:

- **`full-story`**: both people start from scratch (sign-ups, the victim's passkey, overwrite, takeover, lockout). Both browsers share one remote passkeys.tools key store, so the victim's credential ID shows up in the attacker's interceptor as `profile1 | ES256`. Login verifier: Discoverable (#2).
- **`attacker-view`**: the victim is pre-created with a passkey and signed in on `/settings`; the attacker account is pre-created and logged out. The browsers share nothing but the CTF instance (each has its own **local** passkeys.tools store). Login verifier: Non-Discoverable (#4, username-first). The attacker:
  1. types `victim` at login, so the interceptor's request shows `allowCredentials` with the victim's credential ID, and copies it;
  2. pastes it in the passkeys.tools Keys tab → *Update Credential ID* onto their own `profile2 | ES256`, then dismisses the login;
  3. logs in to their own account (no passkey → password fallback);
  4. registers a passkey: the interceptor's defaults now carry the victim's ID with the attacker's key → overwrite + flag;
  5. logs in as `victim`: the interceptor maps `allowCredentials` to the forged key automatically, but fills in the attacker's own **user handle** (stored for the profile), which the CTF rejects ("User handle does not match identified user", checked only if present). The attacker deletes that line from the response;
  6. the victim's own login then fails (lockout).

## Tech Stack

- **app**: Node.js 22 (ESM, no build step for server code), Express 5, `ws`, `playwright-core` (CDP client only, no bundled browsers), noVNC 1.4 client bundled with esbuild (1.5+/1.6 npm builds contain a top-level `await` and cannot be bundled), vanilla JS/CSS frontend.
- **browser**: Debian bookworm, Chromium (called directly at `/usr/lib/chromium/chromium` to bypass the Debian wrapper, which injects its own `--load-extension=`), TigerVNC `Xvnc`, `socat`.

## Project Structure

```
.
├── app/                         # Demo website + orchestrator (one container for all demos)
│   ├── Dockerfile
│   ├── client/rfb.js            # esbuild entry: re-exports noVNC's CommonJS RFB as ESM → dist/rfb.js
│   ├── public/                  # Static UI
│   │   ├── index.html, home.js  # Landing page (/): demo cards with live status from /api/demos
│   │   ├── demo.html, demo.js   # Demo page (/<demo-id>): browsers, guide, database view
│   │   └── style.css
│   └── src/
│       ├── server.js            # HTTP server, demo instances, /api/demos, /ws/<demo>, /vnc/<demo>/<role>, basic auth
│       ├── config.js            # Env-var configuration (demo list, browser host pattern, verifier IDs, …)
│       ├── auth.js              # Basic auth + derived cookie (for WebSocket upgrades)
│       ├── vnc-proxy.js         # WebSocket ↔ TCP bridge (websockify equivalent)
│       ├── browser-controller.js# CDP control of one browser: connect/restart, pages, events, snapshots, highlights
│       ├── page-scripts.js      # Functions evaluated inside the browsers (snapshots, highlights, user-action reports)
│       ├── setup.js             # Setup building blocks composed by the scenarios' prepare()
│       ├── passkeys-tools-store.js # Minimal db.passkeys.tools client (secret generation, key listing)
│       ├── demo.js              # DemoController: one demo instance (state machine, facts, DB model, tick, autopilot)
│       ├── scenarios/
│       │   ├── index.js         # Registry of scenarios by ID
│       │   ├── common.js        # Shared selectors, state helpers, task factories, completion facts
│       │   ├── full-story.js    # Scenario: steps + setup stages + prepare()
│       │   └── attacker-view.js # Scenario: steps + setup + observe() for recon facts
│       └── log.js
├── browser/                     # One image, run once per role per demo
│   ├── Dockerfile               # Bakes the passkeys.tools extension (git ref build arg)
│   └── entrypoint.sh            # Xvnc + socat + Chromium restart loop + managed policies
├── docker-compose.dev.yml       # Local builds, app src/public mounted, node --watch
├── docker-compose.prod.yml      # GHCR images
└── .github/workflows/docker.yml # Builds and pushes both images to GHCR
```

## Architecture

```
Viewer ──HTTP/WS──▶ app ─┬─ demo "full-story"    ──CDP/VNC──▶ full-story-victim, full-story-attacker
                         └─ demo "attacker-view" ──CDP/VNC──▶ attacker-view-victim, attacker-view-attacker
```

- **Demo instances**: `DEMOS` lists scenario IDs; for each, `server.js` creates a `DemoController` with two `BrowserController`s at hosts from `BROWSER_HOST_PATTERN` (`{demo}-{role}`, matching the compose service names). Instances are fully independent (own CTF instance, own reset, own WebSocket clients).
- **Routes**: `/` landing page; `/<demo-id>` serves `demo.html`, which reads its demo ID from the path; `/api/demos` summaries; WebSockets `/ws/<demo-id>` (JSON state push, UI actions back) and `/vnc/<demo-id>/<role>`.
- **Browsers**: each browser container runs `Xvnc` (display + VNC server), `socat` to expose Chromium's localhost-only DevTools port 9222 as 9223, and Chromium in a loop. When Chromium exits, the loop wipes the profile and starts it again. **Reset** relies on this: the app sends `Browser.close` over CDP and reconnects to the fresh instance, so the extension is effectively reinstalled. The VNC stream survives resets. The entrypoint removes stale X locks, because a restarted container keeps `/tmp/.X0-lock` and Xvnc would refuse to start.
- **CDP addressing**: Chromium rejects DevTools HTTP requests whose `Host` header is a hostname, so the app resolves the service name to an IPv4 address and connects by IP.
- **Skins and lockdown**: `entrypoint.sh` writes `/etc/chromium/policies/managed/demo.json` from env: `BrowserThemeColor` (no theme-install infobar, unlike a theme extension), no password manager or translate prompts, popups allowed (the extension opens its interceptor via `window.open` after an async fetch), and `URLBlocklist ["*"]` + `URLAllowlist` (navigations only; subresources such as flag images still load).
- **Extension**: Chromium writes the extension's indexed declarativeNetRequest ruleset into the unpacked extension directory (`_metadata/`). If that directory is not writable for the browser user, loading fails ("rules.json: Internal error while parsing rules"), and Chromium then never opens its DevTools port. The Dockerfile therefore chowns the extension directory to the browser user. The extension ID is derived from its path (`sha256(path)` → first 32 hex chars mapped to a–p); `setup.js` computes it to open `popup.html` and write `chrome.storage.local`.

### Scenarios (`scenarios/*.js`)

A scenario exports `{ id, title, summary, presetNames, setupStages, prepare, observe?, steps, notices }`:

- **`prepare({ browsers, config, onStage })`** composes `setup.js` building blocks and reports progress per stage. Every run uses a fresh CTF instance UUID (and, for remote storage, a fresh secret).
- **`presetNames`**: usernames created behind the scenes (`null` → learned from the browsers).
- **`observe(state)`** (optional) latches scenario-specific facts into `facts.scenario` on every tick (`attacker-view`: leaked credential ID, copy detected, Keys tab seen, forged key, recon closed, attacker logged in).
- **Steps** have `id`, `short`, `marker`, `focus` (acting browser), texts (`kicker`, `title`, `lead`, `points`, `why`, `callout`, `doneMessage`), `tasks`, `complete(state)`, and optionally `quietLoginFailures` (no "login failed" notice, e.g. when cancelling the recon login).

Setup details worth knowing:

- Extension storage: `interceptorMode` = `profile1` (victim) / `profile2` (attacker), `popupMode` = `inline` (interceptor opens as a tab, which reads best over VNC), `frontendUrl`.
- Remote key store (`full-story`): **sequential on purpose**. The frontend generates missing profile keys on load, so the victim browser generates them first (waits for `.tab-content.loaded`) and the attacker browser then finds them. Running both at once races and can replace keys.
- CTF cookies `fwf_instance_id` (shared UUID, same effect as "Switch Instance"), `fwf_verifier_reg`, `fwf_verifier_auth`.

### Guide engine (`scenarios/common.js`, `demo.js`)

- A **tick** (500 ms) snapshots both browsers. On the CTF page: path, logged-in user, form/modal state, username-first form. On the interceptor tab: op, selected options, active passkeys.tools tab, `allowCredentials`, whether the response has a `userHandle`, the Keys form, and the local store's profile credential IDs. The tick then runs `observe`, draws the current task's highlight in the focused browser, and publishes state if it changed.
- **Task `done` predicates are evaluated live and never latched**, and each one also accepts all later states of the flow. The first unfinished task is therefore always the correct next action, including after detours (closed interceptor, wrong selection sent). Completion of a step depends only on **facts**.
- **Facts** come from events:
  - `passkey-result`: CTF `/api/passkey/{registration,authentication}/verify` responses, captured via Playwright network events. The credential ID comes from the request body (`credential.id`). These events are also processed while preparing, so pre-registered passkeys appear in the database view; notices and celebrations are only shown when ready.
  - `report`: an init script reports user actions via `exposeBinding`, namely the interceptor selection at the exact moment Send is clicked (`send`) and copied text (`copy`).
- **Highlights** (`applyHighlights`) outline an element and show a tip. On listbox selects they mark an option. In textareas they select text (`select.text` / `select.pattern`) and re-apply it whenever focus or selection was lost, so one keypress (Ctrl+C, Delete) acts on it. Tips for elements taller than the viewport are pinned to the visible part.
- The **database view** is a model built from the facts. A registration with a known credential ID that carries a reward means the stored key was overwritten. Key owner = `profile1` → victim, `profile2` → attacker.
- **Autopilot** runs the remaining tasks' `run()` functions with Playwright in the real browsers, waiting for each task's predicate before the next one; per-task durations are logged. The live highlights make each action visible.
- Texts are HTML authored in the scenario files; `{victim}`, `{attacker}`, `{flag}` and `{leaked}` are replaced server-side, with user-typed names escaped.

### UI (`public/`)

- The client renders each section only when its inputs change, so CSS animations don't restart. The top bar links the versions.
- noVNC uses `scaleViewport`. Both panels have equal width, because the 16:10 screens are height-bound at 1080p and a wider active panel would only add letterboxing. The active browser gets a glow and a "Your turn" chip; the other one is dimmed.
- Celebration overlays cover the *non-acting* browser, so the real result (e.g. the CTF's flag modal) stays visible.

## Conventions

- All configuration via env vars (see `.env.example`). Steps and texts live only in the scenario files.
- **Adding a scenario**: create `scenarios/<id>.js`, register it in `scenarios/index.js`, add `<id>-victim` / `<id>-attacker` browser services to both compose files, and add the ID to `DEMOS`.
- Code in `page-scripts.js` runs inside the browsers and must be self-contained.
- After changing selectors of the CTF or passkeys.tools UIs, re-run every scenario's full flow (all steps with "Do it for me").
- Public instances shuffle reward flags (`REWARD_FLAG_ORDER`), so never hardcode the flag country; it is read from the reward response.
- The browsers are 1152 px wide, so the passkeys.tools navigation is collapsed (`navbar-expand-xl`); use `BrowserController.openPasskeysToolsTab()` / `passkeysToolsTabHighlight()`, which open the menu first.
