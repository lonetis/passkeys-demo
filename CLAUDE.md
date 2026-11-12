# CLAUDE.md

Internal documentation for *State of Passkeys – Live Demos* (the passkeys demo). User-facing docs live in `README.md`; environment variables are documented only in `.env.example`.

## Purpose

Guided, live demos of passkey attacks from the paper *The State of Passkeys* (USENIX Security 2026) on the Fun with Flags and Passkeys CTF (`learning.passkeys.tools`), using PASSKEYS-ATTACKER (`passkeys.tools` frontend + Chrome extension + `db.passkeys.tools` remote storage):

- **Credential Overwrite → Account Takeover** (§6.2.2 "Swap credid", §6.2.7 credential ID leak via `allowCredentials`; WebAuthn §7.1.26; CTF verifier #60 "Cred Overwrite").
- **Challenge session binding** (§6.2.4, CWE-384; WebAuthn §7.2.11; CTF verifier #17 "Cross-Session Challenge").

Three scenarios ("versions"), each run as an independent **demo instance** on its own pair of browsers. Display titles (`title`, Title Case) are listed in `DEMOS` order:

- **`full-story`** ("Demo: Account Takeover"): both people start from scratch (sign-ups, the victim's passkey, overwrite, takeover, lockout). Both browsers share one remote passkeys.tools key store, so the victim's credential ID shows up in the attacker's interceptor as `victim | ES256`. Login verifier: Discoverable (#2).
- **`attacker-view`** ("Test: Session Overwrite"): the victim is pre-created with a passkey and signed in on `/settings`; the attacker account is pre-created and logged out. The browsers share nothing but the CTF instance (each has its own **local** passkeys.tools store). Login verifier: Non-Discoverable (#4, username-first). The attacker:
  1. types `victim` at login, so the interceptor's request shows `allowCredentials` with the victim's credential ID, and copies it;
  2. pastes it in the passkeys.tools Keys tab → *Update Credential ID* onto their own `attacker | ES256` (stored as `profile2 | ES256`), then dismisses the login;
  3. logs in to their own account (no passkey → password fallback);
  4. registers a passkey: the interceptor's defaults now carry the victim's ID with the attacker's key → overwrite + flag;
  5. logs in as `victim`: the interceptor maps `allowCredentials` to the forged key automatically, but fills in the attacker's own **user handle** (stored for the profile), which the CTF rejects ("User handle does not match identified user", checked only if present). The attacker deletes that line from the response;
  6. the victim's own login then fails (lockout).
- **`challenge-binding`** ("Test: Challenge Binding"): both accounts are pre-created with a passkey each (registration verifier #29 "All Algorithms", so the website has no other bug) and signed in on `/settings`. Shared remote store like `full-story`, because the challenge travels through PASSKEYS-ATTACKER's shared **history**. Login verifier: Cross-Session Challenge (#17, discoverable). Steps:
  1. both log out (one step with tasks in both browsers, `focus: 'both'`);
  2. the victim starts a passkey login and clicks **Dismiss**: the website's challenge for the victim's session stays unused (the CTF keeps unused challenges in a global store for 10 minutes);
  3. the attacker starts a passkey login, keeps the attacker's own passkey and picks *Attacks → Challenge | Session Binding*, which puts the other profile's newest **dismissed** `get` challenge from the history into `clientDataJSON` and re-signs. The CTF accepts it and returns a reward. PASSKEYS-ATTACKER only takes history entries **younger than one minute**; the scenario treats a challenge as usable for 55 s, and when it went stale it latches `staleAt`, which un-completes step 2 so the presenter repeats it (the attack's error replaces the whole Attacks list, so the attacker has to Dismiss first).

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
│       ├── qr.js                # QR code (SVG) of PROJECT_URL for the landing page
│       ├── demo.js              # DemoController: one demo instance (state machine, facts, DB model, tick, autopilot)
│       ├── scenarios/
│       │   ├── index.js         # Registry of scenarios by ID
│       │   ├── common.js        # Shared selectors, state helpers, task factories, completion facts
│       │   ├── full-story.js    # Scenario: steps + setup stages + prepare()
│       │   ├── attacker-view.js # Scenario: steps + setup + observe() for recon facts
│       │   └── challenge-binding.js # Scenario: challenge session binding test
│       └── log.js
├── browser/                     # One image, run once per role per demo
│   ├── Dockerfile               # Bakes the passkeys.tools extension (git ref build arg)
│   └── entrypoint.sh            # Xvnc + socat + Chromium restart loop + managed policies
├── docker-compose.dev.yml       # Local builds, app src/public mounted, node --watch
├── docker-compose.prod.yml      # GHCR images
├── install.sh                   # One-line installer: prod compose + minimal .env in ~/passkeys-demo
└── .github/workflows/docker.yml # Builds and pushes both images (amd64 + arm64) to GHCR
```

## Architecture

```
Viewer ──HTTP/WS──▶ app ─┬─ demo "full-story"        ──CDP/VNC──▶ full-story-victim, full-story-attacker
                         ├─ demo "attacker-view"     ──CDP/VNC──▶ attacker-view-victim, attacker-view-attacker
                         └─ demo "challenge-binding" ──CDP/VNC──▶ challenge-binding-victim, challenge-binding-attacker
```

- **Demo instances**: `DEMOS` lists scenario IDs; for each, `server.js` creates a `DemoController` with two `BrowserController`s at hosts from `BROWSER_HOST_PATTERN` (`{demo}-{role}`, matching the compose service names). Instances are fully independent (own CTF instance, own reset, own WebSocket clients).
- **Routes**: `/` landing page; `/<demo-id>` serves `demo.html`, which reads its demo ID from the path; `/api/demos` summaries; `/api/project` (`PROJECT_URL` and its display label) and `/project-qr.svg` (generated once at startup with `qrcode-generator`) for the landing page's "Try It on Your Own Machine" card; WebSockets `/ws/<demo-id>` (JSON state push, UI actions back) and `/vnc/<demo-id>/<role>`. `/healthz` is the only route without basic auth.
- **Browsers**: each browser container runs `Xvnc` (display + VNC server), `socat` to expose Chromium's localhost-only DevTools port 9222 as 9223, and Chromium in a loop. When Chromium exits, the loop wipes the profile and starts it again. **Reset** relies on this: the app sends `Browser.close` over CDP and reconnects to the fresh instance, so the extension is effectively reinstalled. The VNC stream survives resets. The entrypoint removes stale X locks, because a restarted container keeps `/tmp/.X0-lock` and Xvnc would refuse to start.
- **CDP addressing**: Chromium rejects DevTools HTTP requests whose `Host` header is a hostname, so the app resolves the service name to an IPv4 address and connects by IP.
- **Skins and lockdown**: `entrypoint.sh` writes `/etc/chromium/policies/managed/demo.json` from env: `BrowserThemeColor` (no theme-install infobar, unlike a theme extension), no password manager or translate prompts, popups allowed (the extension opens its interceptor via `window.open` after an async fetch), and `URLBlocklist ["*"]` + `URLAllowlist` (navigations only; subresources such as flag images still load).
- **Profile labels (demo-only UI patch)**: PASSKEYS-ATTACKER names keys after its operation modes (`profile1 | ES256`). The `relabelPasskeysTools` init script runs on every passkeys.tools page in the demo browsers and rewrites *displayed* text to roles (`profile1` → `victim`, `profile2` → `attacker`; mapping `LABEL_BY_PROFILE` in `setup.js`). Stored names and option values stay intact. The interceptor's Mode cell is relabeled via CSS only (`data-pkdemo-label`), because the tool reads its text back into history entries. Scenarios with `separateKeyStores` also hide the other profile's keys (options and table rows) in each browser, since those local keys belong to no one in the story. Consequences: snapshots, Send reports and autopilot `selectOption({ label })` see the shown names (`VICTIM_KEY` = `victim | ES256`), whereas storage-level code (remote key listing, local `keys` in `localStorage`) sees stored names; convert with `shownKeyName()`. passkeys.tools' own keyboard shortcuts match on option text and no longer work in the demo browsers.
- **Extension**: Chromium writes the extension's indexed declarativeNetRequest ruleset into the unpacked extension directory (`_metadata/`). If that directory is not writable for the browser user, loading fails ("rules.json: Internal error while parsing rules"), and Chromium then never opens its DevTools port. The Dockerfile therefore chowns the extension directory to the browser user. The extension ID is derived from its path (`sha256(path)` → first 32 hex chars mapped to a–p); `setup.js` computes it to open `popup.html` and write `chrome.storage.local`.

### Scenarios (`scenarios/*.js`)

A scenario exports `{ id, title, headline, summary, presetNames, separateKeyStores?, loginCheck, flagDetail, setupStages, prepare, observe?, steps, diagram, notices }`:

- **`title`** names the version (top bar switch, landing page); **`headline`** (HTML) is the demo page's heading; **`flagDetail`** completes the flag celebration's sentence ("the CTF detected the exploit: …").
- **`loginCheck`**: what the database pane checks at each passkey login: `signature` (signed-with key vs. stored key) or `challenge` (whose session's challenge was signed vs. the session logging in; the pane then shows a "Login challenges" table and the passkeys as one summary line).

- **`prepare({ browsers, config, onStage })`** composes `setup.js` building blocks and reports progress per stage. Every run uses a fresh CTF instance UUID (and, for remote storage, a fresh secret).
- **`presetNames`**: usernames created behind the scenes (`null` → learned from the browsers).
- **`observe(state)`** (optional) latches scenario-specific facts into `facts.scenario` on every tick (`attacker-view`: leaked credential ID, copy detected, Keys tab seen, forged key, recon closed, attacker logged in).
- **Steps** have `id`, `short`, `marker`, `focus` (acting browser, or `both` when its tasks act in both browsers), texts (`kicker`, `title`, `lead`, `points`, `why` = the explainer shown next to the Next button, `doneMessage`), `tasks`, `complete(state)`, and optionally `quietLoginFailures` (no "login failed" notice, e.g. when cancelling the recon login).
- **`diagram`**: the attack as a sequence diagram, one message per row `{ step, from, to, text, kind?, reached? }` (`from`/`to`: `victim`, `website`, `attacker`; `from === to` draws a note; `kind` `bad`/`leak` overrides the sender's color). Every message belongs to the step that sends it (validated at startup); `reached(state)` marks outcome rows that light up only once they actually happened. Labels name the parties ("victim’s credential ID", "attacker’s key"), never "own".

Setup details worth knowing:

- Extension storage: `interceptorMode` = `profile1` (victim) / `profile2` (attacker), `popupMode` = `inline` (interceptor opens as a tab, which reads best over VNC), `frontendUrl`.
- Remote key store (`full-story`, `challenge-binding`): **sequential on purpose**. The frontend generates missing profile keys on load, so the victim browser generates them first (waits for `.tab-content.loaded`) and the attacker browser then finds them. Running both at once races and can replace keys.
- CTF cookies `fwf_instance_id` (shared UUID, same effect as "Switch Instance"), `fwf_verifier_reg`, `fwf_verifier_auth`.
- Accounts in a shared remote store (`challenge-binding`) are created and get their passkeys one after the other, so the two registrations do not race on the store.

### Guide engine (`scenarios/common.js`, `demo.js`)

- A **tick** (500 ms) snapshots both browsers. On the CTF page: path, logged-in user, form/modal state, username-first form. On the interceptor tab: op, selected options, active passkeys.tools tab, `allowCredentials`, whether the response has a `userHandle`, the request's challenge and the challenge the response signs (decoded `clientDataJSON`), the selected *Attacks* entry and its error, the Keys form, and the local store's profile credential IDs. The tick then runs `observe`, draws the current task's highlight in the focused browser, and publishes state if it changed.
- Each task carries the `role` of the browser it acts in (the task factories set it; otherwise the step's `focus`). Highlights and "Do it for me" use that browser, and the published step's `acting` role (current task's) drives the "Your turn" glow, so a `both` step hands the turn from one browser to the other.
- **Task `done` predicates are evaluated live and never latched**, and each one also accepts all later states of the flow. The first unfinished task is therefore always the correct next action, including after detours (closed interceptor, wrong selection sent). Completion of a step depends only on **facts**.
- Key ownership comes from the key name prefix of the interceptor selection at Send (`victim`/`attacker`, or `profile1`/`profile2`), falling back to the acting browser's role.
- **Facts** come from events:
  - `challenge-issued`: CTF `/api/passkey/{registration,authentication}/options` responses (`options.challenge`). Login challenges feed the **sessions** model: per browser session the challenge the website issued, and whose login used it.
  - `passkey-result`: CTF `/api/passkey/{registration,authentication}/verify` responses, captured via Playwright network events. The credential ID comes from the request body (`credential.id`), the signed challenge from its `clientDataJSON`. A login with a reward (a login verifier's exploit) sets `loginFlag` and celebrates the flag. These events are also processed while preparing, so pre-registered passkeys appear in the database view; notices and celebrations are only shown when ready.
  - `report`: an init script reports user actions via `exposeBinding`, namely the interceptor selection at the exact moment Send is clicked (`send`), the request's challenge when Dismiss is clicked (`dismiss` → `lastDismiss`), and copied text (`copy`).
- **Highlights** (`applyHighlights`) outline an element and show a tip. On listbox selects they mark an option. In textareas they select text (`select.text` / `select.pattern`) and re-apply it whenever focus or selection was lost, so one keypress (Ctrl+C, Delete) acts on it. An element taller than the viewport is scrolled so its top shows below room for the tip (centering it would hide its first lines, e.g. the request's challenge), and its tip is pinned to the visible part. Autopilot runs focus textareas with `preventScroll`.
- The **database view** is a model built from the facts: per credential ID the account, whose credential ID it is (the registering browser's role) and whose public key is stored. A registration with a known credential ID that carries a reward means the stored key was overwritten (the previous owner is kept to show the swap). Each passkey login records whose key signed it and whose key was stored for that credential ID at that moment, for the signature check view, and whose session issued the challenge it signed, for the challenge check view.
- **Autopilot** runs the remaining tasks' `run()` functions with Playwright in the real browsers, waiting for each task's predicate before the next one; per-task durations are logged. It is paced for an audience: before each task it pauses (`AUTOPILOT_PAUSE_MS`) while the highlight shows where the action happens, and inside tasks it uses `BEAT_MS`, `TYPING_DELAY_MS` and `SHOW_SELECTION_MS` from `common.js`.
- Texts are HTML authored in the scenario files; `{victim}`, `{attacker}`, `{flag}` and `{leaked}` are replaced server-side, with user-typed names escaped.

### UI (`public/`)

- The client renders each section only when its inputs change, so CSS animations don't restart. The top bar links the versions.
- Guide row: step card (kicker with "Do it for me", title, lead, tasks; the step's `why` explainer next to the Next button), the attack diagram, and the website database with the last login's signature check.
- The **diagram** is visible on every step. The intro and takeaways show it whole; otherwise the current step's rows sit in a highlighted band with animated arrows, past rows are muted, upcoming rows and outcomes that have not happened yet are dimmed, and the left column repeats the stepper markers.
- The **database view** shows ownership with role icons and colors (😇 victim, 😈 attacker); an overwritten key is shown struck through with an arrow to the new one. The **signature check** shows signed-with key = / ≠ stored key → result. With `loginCheck: 'challenge'` it shows the passkeys as one line, the **login challenges** per session (start of the challenge, used by whom; another party's use in red), and the **challenge check** (signed challenge = / ≠ the session's → result; "accepted anyway" is the bug).
- The layout targets 1920×1080. Below 1500 px width or 950 px height the guide is denser, ownership chips drop the words "ID"/"key" (the column headers say it), the challenge test's passkey summary line is hidden, and the headline shrinks (ellipsis if it still does not fit next to the version switch).
- noVNC uses `scaleViewport`. Both panels have equal width, because the 16:10 screens are height-bound at 1080p and a wider active panel would only add letterboxing. The active browser gets a glow and a "Your turn" chip; the other one is dimmed.
- Celebration overlays cover the browser where it happened (flag and takeover: attacker, lockout: victim), below its header, so the "logged in as" status stays visible.
- The stepper and landing page mark a `both` step with both role colors.
- The landing page shows the demo cards (status refreshed every 3 s) and a "Try It on Your Own Machine" card (QR code + link to `PROJECT_URL`) in one grid. The demo cards sit in a `display: contents` wrapper, so re-rendering them leaves that card (and its image) alone.

### Distribution

- **Images**: the workflow builds `linux/amd64` and `linux/arm64` (QEMU), tagged `latest` on main plus the commit SHA, as public GHCR packages `passkeys-demo-app` and `passkeys-demo-browser` linked to the public repository.
- **One-line install** (`install.sh`, POSIX `sh`, piped from `raw.githubusercontent.com/.../main`): checks curl, Docker and the Compose plugin, downloads `docker-compose.prod.yml` as `docker-compose.yml` and `.env.example` into `PASSKEYS_DEMO_DIR` (default `/tmp/passkeys-demo`, so nothing lands in the user's home; an existing directory that is a symlink or owned by someone else is refused, since `/tmp` is shared), writes a **minimal** `.env` only on the first install (`APP_BIND=127.0.0.1`, `APP_PORT`), pulls, `up -d --remove-orphans`, waits for `/healthz` and prints stop/start/update/uninstall commands. The minimal `.env` is deliberate: every other variable falls back to the defaults in `config.js` and the compose file, so a re-run (update) picks up new defaults such as a new demo in `DEMOS`, while the user's own edits to `.env` survive. Bound to localhost, the stack needs no password (the app logs a warning). The installer always uses compose project **`passkeys-demo`**, and the printed commands (`docker compose -p passkeys-demo stop|start|down --rmi all`) work by project name without the compose file, because `/tmp` may have been cleared (e.g. after a reboot; the containers come back via `restart: unless-stopped` unless they were stopped). Do not run the installer on a host whose production checkout also runs as project `passkeys-demo` (a checkout directory of that name).

## Conventions

- All configuration via env vars (see `.env.example`). Steps and texts live only in the scenario files.
- **Adding a scenario**: create `scenarios/<id>.js`, register it in `scenarios/index.js`, add `<id>-victim` / `<id>-attacker` browser services to both compose files (and to the app's `depends_on`), and add the ID to `DEMOS`, whose order is the landing page's and the version switch's order.
- Code in `page-scripts.js` runs inside the browsers and must be self-contained.
- After changing selectors of the CTF or passkeys.tools UIs, re-run every scenario's full flow (all steps with "Do it for me").
- Public instances shuffle reward flags (`REWARD_FLAG_ORDER`), so never hardcode the flag country; it is read from the reward response.
- The browsers are 1152 px wide, so the passkeys.tools navigation is collapsed (`navbar-expand-xl`); use `BrowserController.openPasskeysToolsTab()` / `passkeysToolsTabHighlight()`, which open the menu first.
