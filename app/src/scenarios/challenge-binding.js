import { randomUUID } from 'node:crypto';
import { generateSecret, listKeyNames } from '../passkeys-tools-store.js';
import {
  PROFILE_BY_ROLE, restartBrowsers, configureExtension, connectRemoteKeyStore, openCtfInstance,
  createCtfAccount, registerDefaultPasskey,
} from '../setup.js';
import {
  ATTACKER_KEY, CTF_PASSWORD, SELECTORS, sleep, BEAT_MS,
  learning, interceptor, interceptorOpen, usernameOf,
  logoutTask, passkeyLoginTask, keepSelectionTask, sendTask,
} from './common.js';

/**
 * Test: is the login challenge bound to the session? Both people are signed in with their
 * own passkeys. They log out; the victim starts a passkey login and cancels it, so the
 * website's challenge for the victim's session stays unused. The attacker then logs in to
 * the attacker's own account but signs the victim's challenge instead of the one issued to
 * the attacker's session. The CTF's "Cross-Session Challenge" login accepts it.
 *
 * The challenge travels through PASSKEYS-ATTACKER's shared history: its "Challenge |
 * Session Binding" attack takes the other profile's newest dismissed challenge, but only
 * within one minute.
 */

const VICTIM_NAME = 'victim';
const ATTACKER_NAME = 'attacker';
const SESSION_BINDING_ATTACK = 'Challenge | Session Binding';
/** PASSKEYS-ATTACKER only offers dismissed challenges younger than a minute; keep a margin. */
const CHALLENGE_USABLE_MS = 55_000;

const SETUP_STAGES = [
  { id: 'browsers', label: 'Restart both browsers with fresh, empty profiles' },
  { id: 'extension', label: 'Install PASSKEYS-ATTACKER in both browsers, with keys labeled “victim” and “attacker”' },
  { id: 'storage', label: 'Connect both to one shared, end-to-end encrypted passkeys.tools store (keys and history)' },
  { id: 'ctf', label: 'Open a fresh CTF instance shared by both browsers, with the vulnerable passkey login' },
  { id: 'accounts', label: 'Victim and attacker: each an account with a passkey, signed in' },
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
    authenticationVerifier: config.verifiers.crossSessionLogin,
  };
  await Promise.all([
    openCtfInstance(victim, config, instanceId, verifiers),
    openCtfInstance(attacker, config, instanceId, verifiers),
  ]);

  onStage('accounts');
  // One after the other, so the two registrations do not race on the shared store.
  for (const [browser, name] of [[victim, VICTIM_NAME], [attacker, ATTACKER_NAME]]) {
    await createCtfAccount(browser, config, name, CTF_PASSWORD);
    await registerDefaultPasskey(browser, config);
  }
  return { instanceId };
}

// ─── Facts ──────────────────────────────────────────────────────────────────

const latched = (s) => s.facts.scenario;
/** The victim's newest cancelled passkey login: { challenge, at }. */
const victimDismissal = (s) => {
  const dismissal = s.facts.lastDismiss.victim;
  return dismissal?.op === 'get' && dismissal.challenge ? dismissal : null;
};
const challengeAccepted = (s) => Boolean(s.facts.loginFlag);
/**
 * The victim's challenge is ready for the attacker: a cancelled login that has not gone
 * stale since (PASSKEYS-ATTACKER offers it for a minute only).
 */
const victimChallengeReady = (s) => {
  const dismissal = victimDismissal(s);
  const staleAt = latched(s).staleAt ?? 0;
  return Boolean(dismissal && dismissal.at > staleAt) || challengeAccepted(s);
};
const victimChallengeUsable = (s) => {
  const dismissal = victimDismissal(s);
  return Boolean(dismissal && Date.now() - dismissal.at < CHALLENGE_USABLE_MS);
};
const loggedOut = (role) => (s) => Boolean(latched(s).loggedOut?.[role]);
const bothLoggedOut = (s) => loggedOut('victim')(s) && loggedOut('attacker')(s);
/** The attacker's interceptor answers with the victim's challenge. */
const challengeSwapped = (s) => {
  const view = interceptor(s, 'attacker');
  return Boolean(view?.responseChallenge) && view.responseChallenge === victimDismissal(s)?.challenge;
};

function observe(s) {
  const facts = latched(s);
  facts.loggedOut ??= {};
  for (const role of ['victim', 'attacker']) {
    if (!facts.loggedOut[role] && learning(s, role) && !learning(s, role).user) facts.loggedOut[role] = true;
  }
  // Too late for the victim's challenge: the victim has to cancel a fresh login first.
  const attackerWaiting = interceptorOpen(s, 'attacker', 'get') && !challengeSwapped(s) && !challengeAccepted(s);
  const tooLate = interceptor(s, 'attacker')?.attackError || !victimChallengeUsable(s);
  if (attackerWaiting && tooLate && victimChallengeReady(s)) facts.staleAt = Date.now();
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

const dismissTask = {
  role: 'victim',
  id: 'dismiss',
  text: 'Click <b>Dismiss</b>: the login is cancelled',
  done: victimChallengeReady,
  highlight: (s) => (interceptorOpen(s, 'victim', 'get') ? {
    page: 'interceptor',
    targets: [{ id: 'dismiss', selectors: [SELECTORS.dismiss], label: 'Click “Dismiss”' }],
  } : null),
  run: async ({ browser }) => {
    const page = await browser.waitForInterceptorPage();
    await browser.focus(page);
    await page.click(SELECTORS.dismiss);
    const learningTab = browser.learningPage();
    if (learningTab) await browser.focus(learningTab);
  },
};

const sessionBindingTask = {
  role: 'attacker',
  id: 'session-binding',
  text: `<b>Attacks</b> → <code>${SESSION_BINDING_ATTACK}</code>: the victim’s challenge`,
  done: (s) => challengeSwapped(s) || challengeAccepted(s),
  highlight: (s) => {
    if (!interceptorOpen(s, 'attacker', 'get')) return null;
    if (!victimChallengeReady(s)) {
      return {
        page: 'interceptor',
        targets: [{ id: 'dismiss', selectors: [SELECTORS.dismiss], label: 'Over a minute since the victim’s login: Dismiss, then repeat step 2' }],
      };
    }
    return {
      page: 'interceptor',
      targets: [{ id: 'session-binding', selectors: [`input[name="modification"][value="${SESSION_BINDING_ATTACK}"]`], label: `Click “${SESSION_BINDING_ATTACK}”` }],
    };
  },
  run: async ({ browser, state }) => {
    if (!victimChallengeUsable(state())) {
      throw new Error('More than a minute passed since the victim’s login. Dismiss, go back to step 2 and repeat it.');
    }
    const page = await browser.waitForInterceptorPage();
    await browser.focus(page);
    const radio = page.locator(`input[name="modification"][value="${SESSION_BINDING_ATTACK}"]`);
    await radio.scrollIntoViewIfNeeded();
    await sleep(BEAT_MS / 2);
    await radio.check();
  },
};

// ─── Steps ──────────────────────────────────────────────────────────────────

const steps = [
  {
    id: 'intro',
    short: 'Intro',
    marker: 'i',
    focus: null,
    kicker: 'Test · Challenge Binding',
    title: 'Is the login challenge bound to the session?',
    lead: 'Each passkey login signs a fresh challenge from the website. It may only count in the session that asked for it.',
    points: [
      '<span class="tag victim">Left</span> victim, <span class="tag attacker">right</span> attacker: both signed in with their own passkeys.',
      'PASSKEYS-ATTACKER in both browsers shares one history, so the attacker can reuse the victim’s challenge.',
      'Target: our vulnerable CTF website (WebAuthn §7.2.11).',
    ],
    why: { title: 'How to follow', body: 'The diagram shows the whole test; the current step lights up.' },
    tasks: [],
    complete: () => true,
  },
  {
    id: 'logout',
    short: 'Both log out',
    marker: '1',
    focus: 'both',
    kicker: 'Step 1 · Victim and attacker',
    title: 'Both log out',
    lead: 'Each browser keeps its own session on the website.',
    why: { title: 'Two sessions', body: 'The website tells the browsers apart by their session cookies. Each login challenge belongs to one session.' },
    tasks: [
      logoutTask('victim', 'Victim: <b>{victim}</b> → <b>Logout</b>', loggedOut('victim')),
      logoutTask('attacker', 'Attacker: <b>{attacker}</b> → <b>Logout</b>', loggedOut('attacker')),
    ],
    complete: bothLoggedOut,
    doneMessage: '✓ Both logged out',
  },
  {
    id: 'victim-login',
    short: 'Victim’s challenge',
    marker: '2',
    focus: 'victim',
    kicker: 'Step 2 · Victim',
    title: 'The victim starts a passkey login',
    lead: 'The website sends a challenge for the victim’s session. The victim cancels, so it stays unused.',
    why: { title: 'The challenge', body: 'A random value the passkey signs to prove the login is fresh. See “Login challenges” on the right.' },
    tasks: [
      passkeyLoginTask('victim', victimChallengeReady),
      dismissTask,
    ],
    complete: victimChallengeReady,
    doneMessage: '🎲 The victim’s challenge is still unused',
  },
  {
    id: 'attacker-login',
    short: 'Reuse challenge',
    marker: '3',
    focus: 'attacker',
    kicker: 'Step 3 · Attacker',
    title: 'Log in with the victim’s challenge',
    lead: 'The attacker’s own passkey, but it signs the victim’s challenge instead of the attacker’s.',
    why: {
      title: 'The test',
      body: 'A correct website rejects this: the challenge belongs to the victim’s session (WebAuthn §7.2.11).',
    },
    tasks: [
      passkeyLoginTask('attacker', challengeAccepted),
      keepSelectionTask('attacker', 'get', (s) => ({ userHandle: usernameOf(s, 'attacker'), credentialId: ATTACKER_KEY, key: ATTACKER_KEY }),
        `Keep the attacker’s passkey <code>${ATTACKER_KEY}</code>`, challengeAccepted),
      sessionBindingTask,
      sendTask('attacker', 'get', challengeAccepted),
    ],
    complete: challengeAccepted,
    doneMessage: '🚩 Accepted! Flag captured: {flag}',
  },
  {
    id: 'summary',
    short: 'Takeaways',
    marker: '★',
    focus: null,
    kicker: 'Takeaways',
    title: 'A challenge from another session was accepted',
    points: [
      '<b>Bug:</b> the website accepts any challenge it issued, from any session.',
      '<b>Risk:</b> a victim’s signed login stolen via XSS logs the attacker in as the victim.',
      '<b>Fix:</b> keep the challenge in the session that requested it; accept it only there, once (WebAuthn §7.2.11).',
      '<b>In the wild:</b> 14 of 103 sites accepted login challenges from other sessions; 9 did so for registrations.',
    ],
    why: {
      title: 'Try it yourself',
      body: '<b>passkeys.tools</b> — PASSKEYS-ATTACKER<br><b>learning.passkeys.tools</b> — the CTF<br><b>Paper:</b> The State of Passkeys, USENIX Security ’26',
    },
    tasks: [],
    complete: () => true,
  },
];

const challengeIssued = (role) => (s) => Boolean(s.facts.sessions[role]);

/** The test at a glance: one row per message, each belonging to the step that sends it. */
const diagram = [
  { step: 'logout', from: 'victim', to: 'website', text: 'Log out' },
  { step: 'logout', from: 'attacker', to: 'website', text: 'Log out' },
  { step: 'victim-login', from: 'victim', to: 'website', text: 'Start passkey login' },
  { step: 'victim-login', from: 'website', to: 'victim', text: '🎲 Challenge for victim’s session', reached: challengeIssued('victim') },
  { step: 'victim-login', from: 'victim', to: 'victim', text: 'Cancels: challenge stays unused' },
  { step: 'attacker-login', from: 'attacker', to: 'website', text: 'Start passkey login' },
  { step: 'attacker-login', from: 'website', to: 'attacker', text: '🎲 Challenge for attacker’s session', reached: challengeIssued('attacker') },
  { step: 'attacker-login', from: 'attacker', to: 'attacker', text: 'Takes victim’s challenge instead' },
  { step: 'attacker-login', from: 'attacker', to: 'website', text: 'Log in as attacker, signed victim’s challenge' },
  { step: 'attacker-login', from: 'website', to: 'attacker', text: '✓ Accepted: challenge of another session', kind: 'bad', reached: challengeAccepted },
];

export default {
  id: 'challenge-binding',
  title: 'Test: Challenge Binding',
  headline: 'Challenge <span class="arrow">↔</span> Session Binding',
  summary: 'Both people are signed in with passkeys. They log out, the victim starts a login and cancels it, and the attacker logs in with the victim’s unused challenge, which the website accepts.',
  presetNames: { victim: VICTIM_NAME, attacker: ATTACKER_NAME },
  loginCheck: 'challenge',
  flagDetail: 'the website accepted the victim’s challenge in the attacker’s session.',
  setupStages: SETUP_STAGES,
  prepare,
  observe,
  steps,
  diagram,
  notices: {},
};
