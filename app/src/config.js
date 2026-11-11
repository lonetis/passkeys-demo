/**
 * Runtime configuration. Every value comes from an environment variable;
 * see .env.example for documentation and defaults.
 */

function readString(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function readInt(name, fallback) {
  const raw = readString(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return value;
}

function readUrl(name, fallback) {
  const raw = readString(name, fallback);
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`Environment variable ${name} must be a URL, got "${raw}"`);
  }
}

function readList(name, fallback) {
  return readString(name, fallback).split(',').map((item) => item.trim()).filter(Boolean);
}

const browserHostPattern = readString('BROWSER_HOST_PATTERN', '{demo}-{role}');
const browserCdpPort = readInt('BROWSER_CDP_PORT', 9223);
const browserVncPort = readInt('BROWSER_VNC_PORT', 5900);

export const config = Object.freeze({
  port: readInt('PORT', 8080),
  auth: Object.freeze({
    username: readString('DEMO_USERNAME', 'demo'),
    password: readString('DEMO_PASSWORD', ''),
  }),
  /** Scenario IDs to run, each on its own pair of browsers. */
  demos: Object.freeze(readList('DEMOS', 'full-story,attacker-view')),
  learningUrl: readUrl('LEARNING_URL', 'https://learning.passkeys.tools'),
  passkeysToolsUrl: readUrl('PASSKEYS_TOOLS_URL', 'https://passkeys.tools'),
  passkeysToolsDbUrl: readUrl('PASSKEYS_TOOLS_DB_URL', 'https://db.passkeys.tools'),
  extensionPath: readString('EXTENSION_PATH', '/opt/passkeys-tools-extension'),
  verifiers: Object.freeze({
    registration: readInt('REGISTRATION_VERIFIER_ID', 60),
    discoverableLogin: readInt('DISCOVERABLE_LOGIN_VERIFIER_ID', 2),
    usernameFirstLogin: readInt('USERNAME_FIRST_LOGIN_VERIFIER_ID', 4),
  }),
  /** "Do it for me": pause before each action, while the highlight shows where it happens. */
  autopilotPauseMs: readInt('AUTOPILOT_PAUSE_MS', 2000),
  /** Where the browser containers of a demo are reachable. */
  browserTarget(demo, role) {
    return {
      host: browserHostPattern.replaceAll('{demo}', demo).replaceAll('{role}', role),
      cdpPort: browserCdpPort,
      vncPort: browserVncPort,
    };
  },
});
