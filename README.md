# Passkeys Demo: Credential Overwrite → Account Takeover

Live, guided demos of a passkey attack from our paper *The State of Passkeys* (USENIX Security 2026). Real Chromium browsers, a yellow-skinned **victim** and a red-skinned **attacker**, both run [PASSKEYS-ATTACKER](https://passkeys.tools) and open the [Fun with Flags and Passkeys](https://learning.passkeys.tools) CTF. A step-by-step guide walks the audience through the attack: the attacker gets the victim's credential ID onto a passkey of their own, captures the flag, logs in as the victim, and the victim is locked out. It is built for poster sessions and talks.

## Features

- Two versions, each on its own pair of browsers, so both can run at the same time:
  - **Full story**: both people start from scratch. The victim signs up and registers a passkey, then the attacker signs up and overwrites it.
  - **Attacker's view**: the victim is already signed in with a passkey. Knowing only the username, the attacker learns the victim's credential ID from the login page (`allowCredentials`), puts it on their own key, and takes over the account.
- Real, interactive Chromium browsers streamed into the page (noVNC), each with its own skin color
- One-click setup and reset per version: fresh browser profiles, the PASSKEYS-ATTACKER extension installed and configured (`profile1` / `profile2`), key stores, and a fresh CTF instance with the vulnerable verifier preselected
- Step-by-step guide that follows what happens in the browsers live and checks off each action
- "Click here" highlights inside the real browsers, including which option to pick and which text to copy or delete
- "Do it for me" button per step that performs the actions visibly in the browsers
- Live view of the website's passkey database that shows the victim's public key being overwritten
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

- Open the site and pick a version on the start page: `/full-story` or `/attacker-view`. The switch in the top bar changes versions; each keeps its own state.
- Open the page in fullscreen (`F`) on a large screen. It is designed for 1920×1080 and works on laptop screens.
- The intro step is shown while the browsers are being prepared; **Start the demo** becomes available once setup is done (about 10 seconds).
- Click directly into the browsers to perform each step yourself, or press **▶ Do it for me**. Highlights in the browsers show where to click next.
- In the attacker's view, the guide selects the text to act on inside the browser: press **Ctrl+C** to copy the victim's credential ID, **Ctrl+V** to paste it in the Keys tab, and **Delete** to remove the attacker's user handle. If you clicked somewhere else first, the selection comes back automatically.
- The last action step shows that the real victim is locked out afterwards. **Takeaways** summarizes the root cause, the fix, and our measurement results.
- Press **⟲ Reset demo** (twice, to confirm) between audiences. That version starts from scratch; the other version is not affected.
- The demos use the public services `learning.passkeys.tools`, `passkeys.tools` and `db.passkeys.tools`, so they need internet access.
