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

const browserCdpPort = readInt('BROWSER_CDP_PORT', 9223);
const browserVncPort = readInt('BROWSER_VNC_PORT', 5900);

export const config = Object.freeze({
  port: readInt('PORT', 8080),
  auth: Object.freeze({
    username: readString('DEMO_USERNAME', 'demo'),
    password: readString('DEMO_PASSWORD', ''),
  }),
  learningUrl: readUrl('LEARNING_URL', 'https://learning.passkeys.tools'),
  passkeysToolsUrl: readUrl('PASSKEYS_TOOLS_URL', 'https://passkeys.tools'),
  passkeysToolsDbUrl: readUrl('PASSKEYS_TOOLS_DB_URL', 'https://db.passkeys.tools'),
  extensionPath: readString('EXTENSION_PATH', '/opt/passkeys-tools-extension'),
  verifiers: Object.freeze({
    registration: readInt('REGISTRATION_VERIFIER_ID', 60),
    authentication: readInt('AUTHENTICATION_VERIFIER_ID', 2),
  }),
  browsers: Object.freeze({
    victim: Object.freeze({
      host: readString('VICTIM_HOST', 'victim'),
      cdpPort: browserCdpPort,
      vncPort: browserVncPort,
    }),
    attacker: Object.freeze({
      host: readString('ATTACKER_HOST', 'attacker'),
      cdpPort: browserCdpPort,
      vncPort: browserVncPort,
    }),
  }),
});
