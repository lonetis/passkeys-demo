# State of Passkeys – Live Demos

Live, guided demos of passkey attacks from our paper *The State of Passkeys* (USENIX Security 2026). Real Chromium browsers, a yellow-skinned **victim** and a red-skinned **attacker**, both run [PASSKEYS-ATTACKER](https://passkeys.tools) and open the [Fun with Flags and Passkeys](https://learning.passkeys.tools) CTF. A step-by-step guide walks the audience through each attack, from the first click to the captured flag. It is built for poster sessions and talks.

## Features

- Three versions, each on its own pair of browsers, so all can run at the same time:
  - **Demo: Account Takeover** (`/full-story`): both people start from scratch. The victim signs up and registers a passkey, then the attacker signs up, overwrites it with the attacker's key, logs in as the victim, and the victim is locked out.
  - **Test: Session Overwrite** (`/attacker-view`): the victim is already signed in with a passkey. Knowing only the username, the attacker learns the victim's credential ID from the login page (`allowCredentials`), puts it on their own key, and takes over the account.
  - **Test: Challenge Binding** (`/challenge-binding`): both people are signed in with their own passkeys and log out. The victim starts a passkey login and cancels it; the attacker logs in with the victim's unused challenge, and the website accepts a challenge it issued to another session.
- Real, interactive Chromium browsers streamed into the page (noVNC), each with its own skin color
- PASSKEYS-ATTACKER's profile keys are labeled by role in the demo browsers (`victim | ES256`, `attacker | ES256`) instead of `profile1`/`profile2`
- One-click setup and reset per version: fresh browser profiles, the PASSKEYS-ATTACKER extension installed and configured, key stores, accounts where a version needs them, and a fresh CTF instance with the vulnerable verifier preselected
- Step-by-step guide that follows what happens in the browsers live and checks off each action, with a short explanation of why next to the Next button
- A diagram of the whole attack, visible throughout the demo, that highlights the current step
- "Click here" highlights inside the real browsers, including which option to pick and which text to copy or delete
- "Do it for me" button per step that performs the actions visibly in the browsers, at a pace the audience can follow
- Live view of the website's passkey database that shows whose credential ID and whose public key each passkey holds, so the overwrite of the victim's key is visible, plus a signature check for every passkey login (signed with which key, checked against which stored key)
- In the challenge binding test: the login challenge the website issued to each browser's session and whose login used it, plus a challenge check for every passkey login (signed which session's challenge, expected which one)
- Flag-captured, account-takeover and victim-lockout moments, plus a takeaways slide
- Keyboard and presenter-remote navigation (PageUp/PageDown, arrow keys, `F` for fullscreen)
- Basic-auth protection; the browsers can only navigate to the demo sites

## Getting Started

### Configuration

Copy `.env.example` to `.env` and adjust it. All variables are documented there. Set `DEMO_PASSWORD` for any deployment that is reachable from the internet.

```bash
cp .env.example .env
```

### Development Setup

`docker-compose.dev.yml` builds the images locally and mounts the app's `src/` and `public/` directories, so code changes apply without rebuilding:

```bash
docker compose -f docker-compose.dev.yml up --build
```

Open http://localhost:8080 (or the port set in `APP_PORT`).

### Production Setup

`docker-compose.prod.yml` uses the pre-built images from GHCR. Pull them again to update:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Put the app behind a TLS-terminating reverse proxy; it serves plain HTTP and WebSockets on `APP_PORT`.

## Presenting

- Open the site and pick a version on the start page: `/full-story`, `/attacker-view` or `/challenge-binding`. The switch in the top bar changes versions; each keeps its own state.
- Open the page in fullscreen (`F`) on a large screen. It is designed for 1920×1080 and works on laptop screens.
- The intro step is shown while the browsers are being prepared; **Start the demo** becomes available once setup is done (about 10 seconds).
- Click directly into the browsers to perform each step yourself, or press **▶ Do it for me**. Highlights in the browsers show where to click next.
- In the attacker's view, the guide selects the text to act on inside the browser: press **Ctrl+C** to copy the victim's credential ID, **Ctrl+V** to paste it in the Keys tab, and **Delete** to remove the attacker's user handle. If you clicked somewhere else first, the selection comes back automatically.
- In the takeover versions, the last action step shows that the real victim is locked out afterwards. **Takeaways** summarizes the root cause, the fix, and our measurement results.
- In the challenge binding test, PASSKEYS-ATTACKER offers the victim's cancelled challenge to the attacker for one minute only, so do the attacker's step right after the victim's. If more than a minute passes, the guide asks you to cancel the attacker's login and repeat the victim's step.
- Press **⟲ Reset demo** (twice, to confirm) between audiences. That version starts from scratch; the other versions are not affected.
- The demos use the public services `learning.passkeys.tools`, `passkeys.tools` and `db.passkeys.tools`, so they need internet access.
