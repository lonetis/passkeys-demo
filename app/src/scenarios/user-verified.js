import { randomUUID } from 'node:crypto';
import { generateSecret, listKeyNames } from '../passkeys-tools-store.js';
import {
  PROFILE_BY_ROLE, restartBrowsers, configureExtension, connectRemoteKeyStore, openCtfInstance,
  createCtfAccount, registerDefaultPasskey,
} from '../setup.js';
import {
  VICTIM_KEY, CTF_PASSWORD, sleep, BEAT_MS,
  interceptor, interceptorOpen,
  passkeyLoginTask, selectTask, passkeysToolsTabHighlight, openAssertionTabTask, assertionSendTask,
} from './common.js';

/**
 * Test: does the website check the user verified (UV) flag? It requires user verification
 * (PIN or biometrics) at every passkey login, and the authenticator reports it in the UV flag
 * of the signed authenticator data. The victim signs in with a passkey; the attacker has
 * stolen the victim's security key but not its PIN. Both browsers share one passkeys.tools
 * key store, which stands for that security key. The attacker logs in as the victim with the
 * UV flag set to false in passkeys.tools' Assertion tab (it re-signs the response), and the
 * CTF's "No UV Flag" login accepts it (WebAuthn §7.2.17, CWE-287 in the paper).
 */

const VICTIM_NAME = 'victim';
const ATTACKER_NAME = 'attacker';
/** The UV flag of the decoded authenticator data form in passkeys.tools' Assertion tab. */
const ASSERTION_UV_FLAG = '#assertionAuthenticatorDataDecCard select[name$="[flags][uv]"]';

const SETUP_STAGES = [
  { id: 'browsers', label: 'Restart both browsers with fresh, empty profiles' },
  { id: 'extension', label: 'Install PASSKEYS-ATTACKER in both browsers, with keys labeled “victim” and “attacker”' },
  { id: 'storage', label: 'Connect both to one shared, end-to-end encrypted key store: the victim’s security key' },
  { id: 'ctf', label: 'Open a fresh CTF instance shared by both browsers, with the vulnerable passkey login' },
  { id: 'account', label: 'Victim: an account with a passkey, signed in' },
];

async function prepare({ browsers: { victim, attacker }, config, onStage }) {
  const secret = generateSecret();
  const instanceId = randomUUID();

  onStage('browsers');
  await restartBrowsers([victim, attacker]);

  onStage('extension');
  await Promise.all([configureExtension(victim, config), configureExtension(attacker, config)]);

  onStage('storage');
  // Sequential on purpose: the victim's browser generates the profile keys first.
  await connectRemoteKeyStore(victim, config, secret);
  await connectRemoteKeyStore(attacker, config, secret);
  const keyNames = await listKeyNames(config.passkeysToolsDbUrl, secret);
  for (const required of Object.values(PROFILE_BY_ROLE).map((profile) => `${profile} | ES256`)) {
    if (!keyNames.includes(required)) throw new Error(`passkeys.tools key store is missing "${required}"`);
  }

  onStage('ctf');
  const verifiers = {
    registrationVerifier: config.verifiers.standardRegistration,
    authenticationVerifier: config.verifiers.userVerifiedLogin,
  };
  await Promise.all([
    openCtfInstance(victim, config, instanceId, verifiers),
    openCtfInstance(attacker, config, instanceId, verifiers),
  ]);

  onStage('account');
  await createCtfAccount(victim, config, VICTIM_NAME, CTF_PASSWORD);
  await registerDefaultPasskey(victim, config);
  return { instanceId };
}

// ─── Facts ──────────────────────────────────────────────────────────────────

const accepted = (s) => Boolean(s.facts.loginFlag);
/** The attacker's login response would come from the victim's passkey. */
const victimPasskeyPicked = (s) => {
  const view = interceptor(s, 'attacker');
  return interceptorOpen(s, 'attacker', 'get')
    && view.userHandle === VICTIM_NAME && view.credentialId === VICTIM_KEY && view.key === VICTIM_KEY;
};
/** The attacker's login response says the user was not verified (UV flag false). */
const uvCleared = (s) => interceptorOpen(s, 'attacker', 'get') && interceptor(s, 'attacker').responseUserVerified === false;
const uvRequested = (s) => s.facts.sessions.attacker?.userVerification === 'required';

// ─── Tasks ──────────────────────────────────────────────────────────────────

const clearUvTask = {
  role: 'attacker',
  id: 'clear-uv',
  text: '<b>authenticatorData</b> → <b>flags</b> → <b>uv</b>: <code>false</code>',
  done: (s) => uvCleared(s) || accepted(s),
  highlight: (s) => {
    if (!interceptorOpen(s, 'attacker', 'get')) return null;
    if (interceptor(s, 'attacker').tab !== '/assertion') return passkeysToolsTabHighlight(s, 'attacker', 'assertion', 'Click “Assertion”');
    return { page: 'interceptor', targets: [{ id: 'uv', selectors: [ASSERTION_UV_FLAG], label: 'uv → false: no PIN entered' }] };
  },
  run: async ({ browser }) => {
    const page = await browser.waitForInterceptorPage();
    await browser.focus(page);
    const field = page.locator(ASSERTION_UV_FLAG);
    await field.scrollIntoViewIfNeeded();
    await sleep(BEAT_MS);
    await field.selectOption({ label: 'false' });
  },
};

// ─── Steps ──────────────────────────────────────────────────────────────────

const steps = [
  {
    id: 'intro',
    short: 'Intro',
    marker: 'i',
    focus: null,
    kicker: 'Test · User Verified Flag',
    title: 'Does the website check that the user was verified?',
    lead: 'The website requires user verification (PIN, fingerprint or face) at every passkey login. The authenticator confirms it with the signed UV flag.',
    points: [
      '<span class="tag victim">Left</span> victim: signed in with a passkey on a security key.',
      '<span class="tag attacker">Right</span> attacker: has stolen that security key, but not its PIN. Both browsers use one key store: the security key.',
      'Target: our vulnerable CTF website (WebAuthn §7.2.17).',
    ],
    why: { title: 'How to follow', body: 'The diagram shows the whole test; the current step lights up.' },
    tasks: [],
    complete: () => true,
  },
  {
    id: 'stolen-key',
    short: 'Use stolen key',
    marker: '1',
    focus: 'attacker',
    kicker: 'Step 1 · Attacker',
    title: 'Log in with the victim’s security key',
    lead: 'Start a passkey login and pick the victim’s passkey on the stolen key.',
    why: {
      title: 'User verification required',
      body: 'The login request asks for <code>userVerification: "required"</code>: the security key must check its PIN before it signs.',
    },
    tasks: [
      passkeyLoginTask('attacker', (s) => victimPasskeyPicked(s) || accepted(s)),
      selectTask('attacker', 'get', 'userHandle', VICTIM_NAME, `<b>User Handle</b>: <code>${VICTIM_NAME}</code>`, accepted),
      selectTask('attacker', 'get', 'credentialId', VICTIM_KEY, `<b>Credential ID</b>: <code>${VICTIM_KEY}</code>`, accepted),
      selectTask('attacker', 'get', 'key', VICTIM_KEY, `<b>Key</b>: <code>${VICTIM_KEY}</code>`, accepted),
    ],
    complete: (s) => victimPasskeyPicked(s) || accepted(s),
    doneMessage: '✓ The victim’s passkey is ready to sign',
  },
  {
    id: 'skip-pin',
    short: 'Skip the PIN',
    marker: '2',
    focus: 'attacker',
    kicker: 'Step 2 · Attacker',
    title: 'Sign without user verification',
    lead: 'Without the PIN, the security key can only sign with the UV flag off. Set it to false: PASSKEYS-ATTACKER re-signs the response.',
    why: {
      title: 'The test',
      body: 'A correct website rejects this login: it required user verification, but the UV flag says it did not happen (WebAuthn §7.2.17).',
    },
    tasks: [
      openAssertionTabTask('attacker', (s) => uvCleared(s) || accepted(s)),
      clearUvTask,
      assertionSendTask('attacker', accepted),
    ],
    complete: accepted,
    doneMessage: '🚩 Accepted without PIN! Flag captured: {flag}',
  },
  {
    id: 'summary',
    short: 'Takeaways',
    marker: '★',
    focus: null,
    kicker: 'Takeaways',
    title: 'A login without user verification was accepted',
    points: [
      '<b>Bug:</b> the website requires user verification, but does not check the UV flag.',
      '<b>Risk:</b> a lost or stolen security key logs in without its PIN or fingerprint, even over NFC from a phone held next to the victim’s pocket.',
      '<b>Fix:</b> when user verification is required, reject responses without the UV flag (WebAuthn §7.2.17).',
      '<b>In the wild:</b> 10 of 103 sites did not check the flag: 6 at login, 8 at registration.',
    ],
    why: {
      title: 'Try it yourself',
      body: '<b>passkeys.tools</b> — PASSKEYS-ATTACKER<br><b>learning.passkeys.tools</b> — the CTF<br><b>Paper:</b> The State of Passkeys, USENIX Security ’26',
    },
    tasks: [],
    complete: () => true,
  },
];

/** The test at a glance: one row per message, each belonging to the step that sends it. */
const diagram = [
  { step: 'stolen-key', from: 'victim', to: 'attacker', text: '🔐 Stolen: victim’s security key, PIN unknown', kind: 'leak' },
  { step: 'stolen-key', from: 'attacker', to: 'website', text: 'Start passkey login' },
  { step: 'stolen-key', from: 'website', to: 'attacker', text: '🎲 Challenge, user verification required', reached: uvRequested },
  { step: 'skip-pin', from: 'attacker', to: 'attacker', text: 'Victim’s key signs: UV flag false (no PIN)' },
  { step: 'skip-pin', from: 'attacker', to: 'website', text: 'Log in as victim, user not verified' },
  { step: 'skip-pin', from: 'website', to: 'attacker', text: '✓ Accepted without user verification', kind: 'bad', reached: accepted },
];

export default {
  id: 'user-verified',
  title: 'Test: User Verified Flag',
  headline: 'Stolen Key <span class="arrow">→</span> Login Without PIN',
  summary: 'The victim is signed in with a passkey on a security key. The attacker steals the key, logs in as the victim with the user verified flag off, and the website accepts the login without PIN.',
  presetNames: { victim: VICTIM_NAME, attacker: ATTACKER_NAME },
  loginCheck: 'uv',
  flagDetail: 'the website accepted a login without user verification.',
  setupStages: SETUP_STAGES,
  prepare,
  steps,
  diagram,
  notices: {},
};
