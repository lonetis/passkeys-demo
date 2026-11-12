import { randomUUID } from 'node:crypto';
import {
  restartBrowsers, configureExtension, initLocalKeyStore, openCtfInstance,
  createCtfAccount, registerDefaultPasskey,
} from '../setup.js';
import {
  VICTIM_KEY, CTF_PASSWORD, SELECTORS, sleep, BEAT_MS, SHOW_SELECTION_MS,
  learning, interceptor, interceptorOpen,
  logoutTask, passkeyLoginTask, selectTask, passkeysToolsTabHighlight,
  openAssertionTabTask, assertionSendTask,
} from './common.js';

/**
 * Test: is the login challenge bound to the session? Both people are signed in with their
 * own passkeys. They log out; the attacker starts a passkey login, copies the website's
 * challenge from the interceptor and cancels the login, so the challenge stays unused. The
 * victim then logs in but pastes the attacker's challenge into the response's
 * clientDataJSON (passkeys.tools re-signs it). The CTF's "Cross-Session Challenge" login
 * accepts the attacker's challenge in the victim's session: the session fixation the paper
 * describes (an attacker's challenge replayed in the victim's session, CWE-384).
 *
 * Both browsers stand for one tester's computer: they share the clipboard (via VNC, see
 * DemoController.shareClipboard), but each keeps its own local passkeys.tools key store.
 */

const VICTIM_NAME = 'victim';
const ATTACKER_NAME = 'attacker';
/** The challenge field of the decoded clientDataJSON form in passkeys.tools' Assertion tab. */
const ASSERTION_CHALLENGE = '#assertionClientDataJSONDecCard input[name$="[challenge]"]';

const SETUP_STAGES = [
  { id: 'browsers', label: 'Restart both browsers with fresh, empty profiles, sharing one clipboard' },
  { id: 'extension', label: 'Install PASSKEYS-ATTACKER in both browsers, each with its own local key store' },
  { id: 'ctf', label: 'Open a fresh CTF instance shared by both browsers, with the vulnerable passkey login' },
  { id: 'accounts', label: 'Victim and attacker: each an account with a passkey, signed in' },
];

async function prepare({ browsers: { victim, attacker }, config, onStage }) {
  const instanceId = randomUUID();

  onStage('browsers');
  await restartBrowsers([victim, attacker]);

  onStage('extension');
  await Promise.all([victim, attacker].map(async (browser) => {
    await configureExtension(browser, config);
    await initLocalKeyStore(browser, config);
  }));

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
  await Promise.all([[victim, VICTIM_NAME], [attacker, ATTACKER_NAME]].map(async ([browser, name]) => {
    await createCtfAccount(browser, config, name, CTF_PASSWORD);
    await registerDefaultPasskey(browser, config);
  }));
  return { instanceId };
}

// ─── Facts ──────────────────────────────────────────────────────────────────

const latched = (s) => s.facts.scenario;
/** The challenge in the attacker's open login request. */
const attackerRequestChallenge = (s) => (interceptorOpen(s, 'attacker', 'get') ? interceptor(s, 'attacker').challenge : null);
/** The attacker's challenge the tester copied (and thereby put on the victim's clipboard). */
const copiedChallenge = (s) => latched(s).copiedChallenge ?? null;
const challengeAccepted = (s) => Boolean(s.facts.loginFlag);
/** The attacker cancelled the login whose challenge was copied, so it is still unused. */
const attackerChallengeReady = (s) => {
  const dismissal = s.facts.lastDismiss.attacker;
  return Boolean(dismissal?.op === 'get' && dismissal.challenge && dismissal.challenge === copiedChallenge(s)) || challengeAccepted(s);
};
const loggedOut = (role) => (s) => Boolean(latched(s).loggedOut?.[role]);
const bothLoggedOut = (s) => loggedOut('victim')(s) && loggedOut('attacker')(s);
/** The victim's response now signs the attacker's challenge. */
const challengeSwapped = (s) => {
  const view = interceptor(s, 'victim');
  return Boolean(view?.responseChallenge) && view.responseChallenge === copiedChallenge(s);
};

function observe(s) {
  const facts = latched(s);
  facts.loggedOut ??= {};
  for (const role of ['victim', 'attacker']) {
    if (!facts.loggedOut[role] && learning(s, role) && !learning(s, role).user) facts.loggedOut[role] = true;
  }
  const challenge = attackerRequestChallenge(s);
  if (challenge && (s.facts.lastCopy.attacker ?? '').includes(challenge)) facts.copiedChallenge = challenge;
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

const copyChallengeTask = {
  role: 'attacker',
  id: 'copy-challenge',
  text: 'Copy the <code>challenge</code> from the request (<b>Ctrl+C</b>)',
  done: (s) => Boolean(copiedChallenge(s) && copiedChallenge(s) === attackerRequestChallenge(s)) || attackerChallengeReady(s),
  highlight: (s) => (attackerRequestChallenge(s) ? {
    page: 'interceptor',
    targets: [{
      id: 'challenge',
      selectors: [SELECTORS.requestTextarea],
      label: 'Selected: the attacker’s challenge → press Ctrl+C',
      select: { text: attackerRequestChallenge(s) },
    }],
  } : null),
  run: async ({ browser, state }) => {
    const page = await browser.waitForInterceptorPage();
    await browser.focus(page);
    await page.evaluate((challenge) => {
      const textarea = document.getElementById('interceptorRequestTextarea');
      const start = textarea.value.indexOf(challenge);
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(start, start + challenge.length);
    }, attackerRequestChallenge(state()));
    await sleep(SHOW_SELECTION_MS);
    await page.keyboard.press('Control+C');
  },
};

const dismissTask = {
  role: 'attacker',
  id: 'dismiss',
  text: 'Click <b>Dismiss</b>: the challenge stays unused',
  done: attackerChallengeReady,
  highlight: (s) => (interceptorOpen(s, 'attacker', 'get') ? {
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

const pasteChallengeTask = {
  role: 'victim',
  id: 'paste-challenge',
  text: '<b>clientDataJSON</b> → <b>challenge</b>: paste the attacker’s (<b>Ctrl+V</b>), then <b>Enter</b>',
  done: (s) => challengeSwapped(s) || challengeAccepted(s),
  highlight: (s) => {
    const view = interceptor(s, 'victim');
    if (!interceptorOpen(s, 'victim', 'get')) return null;
    if (view.tab !== '/assertion') return passkeysToolsTabHighlight(s, 'victim', 'assertion', 'Click “Assertion”');
    if (view.assertionChallenge === copiedChallenge(s)) {
      return { page: 'interceptor', targets: [{ id: 'apply', selectors: [ASSERTION_CHALLENGE], label: 'Press Enter to apply it' }] };
    }
    return {
      page: 'interceptor',
      targets: [{
        id: 'paste',
        selectors: [ASSERTION_CHALLENGE],
        label: 'Selected: the victim’s challenge → press Ctrl+V',
        select: { pattern: '^.+$' },
      }],
    };
  },
  run: async ({ browser, state }) => {
    const page = await browser.waitForInterceptorPage();
    await browser.focus(page);
    const field = page.locator(ASSERTION_CHALLENGE);
    await field.scrollIntoViewIfNeeded();
    await field.click();
    await field.selectText();
    await sleep(SHOW_SELECTION_MS);
    await page.keyboard.press('Control+V');
    await sleep(BEAT_MS);
    // Fall back to typing if the shared clipboard did not reach this browser.
    if ((await field.inputValue()).trim() !== copiedChallenge(state())) await field.fill(copiedChallenge(state()));
    await page.keyboard.press('Enter');
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
      'Both browsers run on the tester’s computer, so they share the clipboard.',
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
    id: 'attacker-challenge',
    short: 'Copy challenge',
    marker: '2',
    focus: 'attacker',
    kicker: 'Step 2 · Attacker',
    title: 'Copy the attacker’s challenge',
    lead: 'Start a passkey login: the website sends a challenge for the attacker’s session. Copy it, then cancel, so it stays unused.',
    why: { title: 'The challenge', body: 'A random value the passkey signs to prove the login is fresh. See “Login challenges” on the right.' },
    tasks: [
      passkeyLoginTask('attacker', attackerChallengeReady),
      copyChallengeTask,
      dismissTask,
    ],
    complete: attackerChallengeReady,
    doneMessage: '📋 The attacker’s challenge is copied and still unused',
  },
  {
    id: 'victim-login',
    short: 'Paste challenge',
    marker: '3',
    focus: 'victim',
    kicker: 'Step 3 · Victim',
    title: 'Log in with the attacker’s challenge',
    lead: 'The victim’s own passkey, but it signs the attacker’s challenge instead of the victim’s.',
    why: {
      title: 'The test',
      body: 'A correct website rejects this: the challenge belongs to the attacker’s session (WebAuthn §7.2.11).',
    },
    tasks: [
      passkeyLoginTask('victim', challengeAccepted),
      selectTask('victim', 'get', 'credentialId', VICTIM_KEY, `<b>Credential ID</b>: <code>${VICTIM_KEY}</code>`, challengeAccepted),
      selectTask('victim', 'get', 'key', VICTIM_KEY, `<b>Key</b>: <code>${VICTIM_KEY}</code>`, challengeAccepted),
      openAssertionTabTask('victim', (s) => challengeSwapped(s) || challengeAccepted(s)),
      pasteChallengeTask,
      assertionSendTask('victim', challengeAccepted),
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
      '<b>Risk:</b> logins prepared or stolen by the attacker work in another session (CSRF, XSS), e.g. logging the victim into the attacker’s account (session fixation).',
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
  { step: 'attacker-challenge', from: 'attacker', to: 'website', text: 'Start passkey login' },
  { step: 'attacker-challenge', from: 'website', to: 'attacker', text: '🎲 Challenge for attacker’s session', reached: challengeIssued('attacker') },
  { step: 'attacker-challenge', from: 'attacker', to: 'victim', text: '📋 Copied: attacker’s challenge', kind: 'leak', reached: (s) => Boolean(copiedChallenge(s)) },
  { step: 'attacker-challenge', from: 'attacker', to: 'attacker', text: 'Cancels: challenge stays unused' },
  { step: 'victim-login', from: 'victim', to: 'website', text: 'Start passkey login' },
  { step: 'victim-login', from: 'website', to: 'victim', text: '🎲 Challenge for victim’s session', reached: challengeIssued('victim') },
  { step: 'victim-login', from: 'victim', to: 'website', text: 'Log in as victim, signed attacker’s challenge' },
  { step: 'victim-login', from: 'website', to: 'victim', text: '✓ Accepted: challenge of another session', kind: 'bad', reached: challengeAccepted },
];

export default {
  id: 'challenge-binding',
  title: 'Test: Challenge Binding',
  headline: 'Challenge <span class="arrow">↔</span> Session Binding',
  summary: 'Both people are signed in with passkeys. They log out, the attacker starts a login, copies its challenge and cancels, and the victim logs in with the attacker’s unused challenge pasted in, which the website accepts.',
  presetNames: { victim: VICTIM_NAME, attacker: ATTACKER_NAME },
  separateKeyStores: true,
  sharedClipboard: true,
  loginCheck: 'challenge',
  flagDetail: 'the website accepted the attacker’s challenge in the victim’s session.',
  setupStages: SETUP_STAGES,
  prepare,
  observe,
  steps,
  diagram,
  notices: {},
};
