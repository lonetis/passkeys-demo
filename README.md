# Passkeys Demo: Credential Overwrite → Account Takeover

A live, guided demo of a passkey attack from our paper *The State of Passkeys* (USENIX Security 2026). Two real Chromium browsers, a yellow-skinned **victim** and a red-skinned **attacker**, both run [PASSKEYS-ATTACKER](https://passkeys.tools) and open the [Fun with Flags and Passkeys](https://learning.passkeys.tools) CTF. A step-by-step guide walks the audience through the attack: the attacker registers a passkey with the victim's credential ID, captures the flag, and logs in as the victim. It is built for poster sessions and talks.

## Features

- Two real, interactive Chromium browsers streamed into the page (noVNC), each with its own skin color
- One-click setup and reset: fresh browser profiles, the PASSKEYS-ATTACKER extension installed and configured (`profile1` / `profile2`), a shared end-to-end encrypted passkeys.tools key store, and a fresh CTF instance shared by both browsers with the vulnerable verifier preselected
- Step-by-step guide that follows what happens in the browsers live and checks off each action
- "Click here" highlights inside the real browsers, including which credential ID and key to pick in the interceptor
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

- Open the site in fullscreen (`F`) on a large screen. It is designed for 1920×1080 and works on laptop screens.
- The intro step starts while the browsers are being prepared; **Start the demo** becomes available once setup is done (about 15 seconds).
- Click directly into the browsers to perform each step yourself, or press **▶ Do it for me**. Highlights in the browsers show where to click next.
- **Bonus** shows that the real victim is locked out afterwards. **Takeaways** summarizes the root cause, the fix, and our measurement results.
- Press **⟲ Reset demo** (twice, to confirm) between audiences. Everything starts from scratch.
- The demo uses the public services `learning.passkeys.tools`, `passkeys.tools` and `db.passkeys.tools`, so it needs internet access.
