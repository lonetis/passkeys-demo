/**
 * The guided attack: "Credentials overwritten with new keys → Account Takeover"
 * (verifier "Cred Overwrite", WebAuthn §7.1.26) on the Fun with Flags and Passkeys CTF.
 *
 * A step has tasks. Each task knows
 *  - text:      what to do (HTML; {victim}/{attacker} are replaced with the chosen usernames),
 *  - done(s):   whether it is done, derived from live browser state and recorded facts,
 *  - highlight: where to point in the real browser,
 *  - run(a):    how to do it automatically ("Do it for me").
 *
 * done() is evaluated live and never latched, and each predicate also accepts every later
 * state of the flow. So the first unfinished task is always the right next action, even
 * after a detour (e.g. the interceptor tab was closed, or a wrong option was sent).
 */

const VICTIM_KEY = 'profile1 | ES256';
const ATTACKER_KEY = 'profile2 | ES256';
const DEMO_PASSWORD = 'passkeys';

const SELECTORS = Object.freeze({
  registerButton: 'a.btn[href="/register"]',
  loginButton: 'a.btn[href="/login"]',
  userMenu: 'ul.navbar-nav.align-items-center .dropdown-toggle',
  settingsLink: 'a.dropdown-item[href="/settings"]',
  logoutButton: 'form[action="/logout"] button',
  registerSubmit: 'form[action="/register"] button[type="submit"]',
  addPasskey: '#add-passkey-btn',
  confirmAddPasskey: '#confirm-add-passkey',
  rewardDismiss: '#reward-dismiss-btn',
  passkeyLogin: '#passkey-login-btn',
  send: '#interceptorSendButton',
});

const SELECT_IDS = Object.freeze({
  create: { credentialId: '#createCredentialIdSelect', key: '#createKeySelect' },
  get: { userHandle: '#getUserHandleSelect', credentialId: '#getCredentialIdSelect', key: '#getKeySelect' },
});

const FIELD_LABELS = Object.freeze({ userHandle: 'User Handle', credentialId: 'Credential ID', key: 'Key' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── State helpers ──────────────────────────────────────────────────────────

const learning = (s, role) => s[role]?.learning ?? null;
const interceptor = (s, role) => s[role]?.interceptor ?? null;
const interceptorOpen = (s, role, op) => interceptor(s, role)?.op === op && interceptor(s, role)?.ready === true;
const usernameOf = (s, role) => s.facts.names[role] ?? role;

// ─── Automation helpers ─────────────────────────────────────────────────────

async function clickVisible(page, selector) {
  const target = page.locator(selector).filter({ visible: true }).first();
  await target.scrollIntoViewIfNeeded();
  await target.click();
}

async function openUserMenuItem(page, itemSelector) {
  const item = page.locator(itemSelector).filter({ visible: true });
  if (await item.count() === 0) await clickVisible(page, SELECTORS.userMenu);
  await sleep(500);
  await clickVisible(page, itemSelector);
}

async function learningPageOf(browser) {
  const page = browser.learningPage();
  if (!page) throw new Error(`No CTF tab open in the ${browser.role} browser`);
  await browser.focus(page);
  return page;
}

// ─── Task factories ─────────────────────────────────────────────────────────

function signUpTasks(role, suggestedName) {
  const loggedIn = (s) => Boolean(learning(s, role)?.user);
  const form = (s) => learning(s, role)?.register;
  const formFilled = (s) => {
    const f = form(s);
    return Boolean(f && f.username.trim() && f.password.length >= 4 && f.confirm === f.password);
  };
  return [
    {
      id: 'open-register',
      text: 'Click <b>Register</b> (top right)',
      done: (s) => learning(s, role)?.path === '/register' || loggedIn(s),
      highlight: () => ({ page: 'learning', targets: [{ id: 'register', selectors: [SELECTORS.registerButton], label: 'Click “Register”' }] }),
      run: async ({ browser }) => clickVisible(await learningPageOf(browser), SELECTORS.registerButton),
    },
    {
      id: 'fill-form',
      text: `Enter username <code>${suggestedName}</code> and a password (twice)`,
      done: (s) => formFilled(s) || loggedIn(s),
      highlight: (s) => {
        const f = form(s);
        if (!f) return null;
        const field = !f.username.trim() ? { id: 'username', label: `Type “${suggestedName}”` }
          : f.password.length < 4 ? { id: 'password', label: 'Type a password, e.g. “passkeys”' }
            : { id: 'confirmPassword', label: 'Repeat the password' };
        return { page: 'learning', targets: [{ id: field.id, selectors: [`#${field.id}`], label: field.label }] };
      },
      run: async ({ browser }) => {
        const page = await learningPageOf(browser);
        for (const [selector, value] of [['#username', suggestedName], ['#password', DEMO_PASSWORD], ['#confirmPassword', DEMO_PASSWORD]]) {
          await page.fill(selector, '');
          await page.locator(selector).pressSequentially(value, { delay: 70 });
          await sleep(250);
        }
      },
    },
    {
      id: 'submit',
      text: 'Click <b>Create Account</b>',
      done: loggedIn,
      highlight: () => ({ page: 'learning', targets: [{ id: 'create-account', selectors: [SELECTORS.registerSubmit], label: 'Click “Create Account”' }] }),
      run: async ({ browser }) => clickVisible(await learningPageOf(browser), SELECTORS.registerSubmit),
    },
  ];
}

function openSettingsTask(role, finished) {
  return {
    id: 'open-settings',
    text: `Open <b>Settings</b>: click <b>{${role}}</b> (top right) → <b>Settings</b>`,
    done: (s) => learning(s, role)?.path === '/settings' || interceptorOpen(s, role, 'create') || finished(s),
    highlight: (s) => ({
      page: 'learning',
      targets: [{
        id: 'settings',
        selectors: [SELECTORS.settingsLink, SELECTORS.userMenu],
        label: learning(s, role)?.userMenuOpen ? 'Click “Settings”' : `Click “${usernameOf(s, role)}”`,
      }],
    }),
    run: async ({ browser }) => openUserMenuItem(await learningPageOf(browser), SELECTORS.settingsLink),
  };
}

function addPasskeyTasks(role, finished) {
  return [
    {
      id: 'add-passkey',
      text: 'Click <b>+ Add Passkey</b>',
      done: (s) => learning(s, role)?.addPasskeyModalOpen || interceptorOpen(s, role, 'create') || finished(s),
      highlight: () => ({ page: 'learning', targets: [{ id: 'add-passkey', selectors: [SELECTORS.addPasskey], label: 'Click “+ Add Passkey”' }] }),
      run: async ({ browser }) => {
        const page = await learningPageOf(browser);
        await clickVisible(page, SELECTORS.addPasskey);
        await page.waitForSelector(`${SELECTORS.confirmAddPasskey}:visible`);
      },
    },
    {
      id: 'register-passkey',
      text: 'Click <b>Register Passkey</b> → PASSKEYS-ATTACKER opens its interceptor in a new tab',
      done: (s) => interceptorOpen(s, role, 'create') || finished(s),
      highlight: () => ({ page: 'learning', targets: [{ id: 'register-passkey', selectors: [SELECTORS.confirmAddPasskey], label: 'Click “Register Passkey”' }] }),
      run: async ({ browser }) => {
        await clickVisible(await learningPageOf(browser), SELECTORS.confirmAddPasskey);
        await browser.focus(await browser.waitForInterceptorPage());
      },
    },
  ];
}

function selectTask(role, op, field, expected, text, finished) {
  const selector = SELECT_IDS[op][field];
  const value = (s) => (typeof expected === 'function' ? expected(s) : expected);
  return {
    id: `select-${field}`,
    text,
    done: (s) => (interceptorOpen(s, role, op) && interceptor(s, role)[field] === value(s)) || finished(s),
    highlight: (s) => (interceptorOpen(s, role, op) ? {
      page: 'interceptor',
      targets: [{ id: `select-${field}`, selectors: [selector], label: `${FIELD_LABELS[field]} → ${value(s)}`, option: value(s) }],
    } : null),
    run: async ({ browser, state }) => {
      const page = await browser.waitForInterceptorPage();
      await browser.focus(page);
      await page.locator(selector).scrollIntoViewIfNeeded();
      await sleep(400);
      await page.selectOption(selector, { label: value(state()) });
    },
  };
}

function sendTask(role, op, finished) {
  return {
    id: 'send',
    text: 'Click <b>Send</b> to answer the website',
    done: finished,
    highlight: (s) => (interceptorOpen(s, role, op) ? {
      page: 'interceptor',
      targets: [{ id: 'send', selectors: [SELECTORS.send], label: 'Click “Send”' }],
    } : null),
    run: async ({ browser }) => {
      const page = await browser.waitForInterceptorPage();
      await browser.focus(page);
      await clickVisible(page, SELECTORS.send);
      const learningTab = browser.learningPage();
      if (learningTab) await browser.focus(learningTab);
    },
  };
}

function logoutTask(role, text, finished) {
  return {
    id: 'logout',
    text,
    done: (s) => !learning(s, role)?.user || interceptorOpen(s, role, 'get') || finished(s),
    highlight: (s) => {
      const l = learning(s, role);
      if (l?.rewardModalOpen) {
        return { page: 'learning', targets: [{ id: 'dismiss', selectors: [SELECTORS.rewardDismiss], label: 'Close the pop-up' }] };
      }
      return {
        page: 'learning',
        targets: [{ id: 'logout', selectors: [SELECTORS.logoutButton, SELECTORS.userMenu], label: l?.userMenuOpen ? 'Click “Logout”' : `Click “${usernameOf(s, role)}”` }],
      };
    },
    run: async ({ browser }) => {
      const page = await learningPageOf(browser);
      if (await page.locator(`${SELECTORS.rewardDismiss}:visible`).count() > 0) {
        await clickVisible(page, SELECTORS.rewardDismiss);
        await page.waitForSelector('#rewardModal', { state: 'hidden' });
      }
      await openUserMenuItem(page, SELECTORS.logoutButton);
    },
  };
}

function passkeyLoginTask(role, finished) {
  return {
    id: 'passkey-login',
    text: 'Click <b>Login</b>, then <b>Login with Passkey</b>',
    done: (s) => interceptorOpen(s, role, 'get') || finished(s),
    highlight: (s) => (learning(s, role)?.path === '/login'
      ? { page: 'learning', targets: [{ id: 'passkey-login', selectors: [SELECTORS.passkeyLogin], label: 'Click “Login with Passkey”' }] }
      : { page: 'learning', targets: [{ id: 'login', selectors: [SELECTORS.loginButton], label: 'Click “Login”' }] }),
    run: async ({ browser }) => {
      const page = await learningPageOf(browser);
      if (new URL(page.url()).pathname !== '/login') {
        await clickVisible(page, SELECTORS.loginButton);
        await page.waitForURL('**/login');
      }
      await sleep(600);
      await clickVisible(page, SELECTORS.passkeyLogin);
      await browser.focus(await browser.waitForInterceptorPage());
    },
  };
}

// ─── Facts that complete steps ──────────────────────────────────────────────

const victimHasPasskey = (s) => Boolean(s.facts.victimPasskey);
const keyOverwritten = (s) => Boolean(s.facts.overwrite);
const attackerIsVictim = (s) => Boolean(s.facts.takeover);
const victimLockedOut = (s) => Boolean(s.facts.lockout);

// ─── Steps ──────────────────────────────────────────────────────────────────

export const steps = [
  {
    id: 'intro',
    short: 'Intro',
    marker: 'i',
    focus: null,
    kicker: 'Live demo · PASSKEYS-ATTACKER',
    title: 'Credential Overwrite → Account Takeover',
    lead: 'An attacker takes over a victim’s account by tricking a website into replacing the victim’s passkey key — without ever touching the victim’s device.',
    points: [
      '<span class="tag victim">Left</span> the victim’s browser, <span class="tag attacker">right</span> the attacker’s browser. Both are real Chromium browsers you can click in.',
      'Both run <b>PASSKEYS-ATTACKER</b>, our extension that stands in for the passkey authenticator, so every WebAuthn message can be inspected and changed.',
      'Both open <b>Fun with Flags and Passkeys</b>, our deliberately vulnerable CTF website. Exploit its bug and you win a flag.',
    ],
    why: {
      title: 'Passkeys in 20 seconds',
      body: 'A passkey is a key pair. The <b>private key</b> never leaves the user’s device. The website stores the <b>public key</b> together with a <b>credential ID</b> that names the passkey. To log in, the device signs a challenge, and the website checks the signature with the stored public key.',
    },
    callout: 'Already done behind the scenes: fresh browser profiles, the extension installed in both, one shared passkeys.tools key store, and a fresh CTF instance whose passkey registration has the bug (verifier “Cred Overwrite”, WebAuthn §7.1.26).',
    tasks: [],
    complete: () => true,
  },
  {
    id: 'victim-signup',
    short: 'Victim signs up',
    marker: '1',
    focus: 'victim',
    kicker: 'Step 1 · Victim',
    title: 'The victim creates an account',
    lead: 'A normal sign-up with username and password.',
    why: {
      title: 'Nothing unusual yet',
      body: 'This is an ordinary account. Next, the victim protects it with a passkey — just like on many real websites.',
    },
    tasks: signUpTasks('victim', 'victim'),
    complete: (s) => Boolean(s.facts.names.victim),
    doneMessage: '✓ Account “{victim}” created',
  },
  {
    id: 'victim-passkey',
    short: 'Victim’s passkey',
    marker: '2',
    focus: 'victim',
    kicker: 'Step 2 · Victim',
    title: 'The victim registers a passkey',
    lead: 'PASSKEYS-ATTACKER plays the victim’s authenticator (think: phone or security key).',
    why: {
      title: 'What the website stores',
      body: 'For each passkey, the website saves its <b>credential ID</b> (a random name), the <b>account</b> it belongs to, and its <b>public key</b>. Watch the database on the right fill in.',
    },
    tasks: [
      openSettingsTask('victim', victimHasPasskey),
      ...addPasskeyTasks('victim', victimHasPasskey),
      selectTask('victim', 'create', 'credentialId', VICTIM_KEY, `Keep <b>Credential ID</b> = <code>${VICTIM_KEY}</code>`, victimHasPasskey),
      selectTask('victim', 'create', 'key', VICTIM_KEY, `Keep <b>Key</b> = <code>${VICTIM_KEY}</code> — the victim’s own key pair`, victimHasPasskey),
      sendTask('victim', 'create', victimHasPasskey),
    ],
    complete: victimHasPasskey,
    doneMessage: '✓ “{victim}” now has a passkey',
  },
  {
    id: 'attacker-signup',
    short: 'Attacker signs up',
    marker: '3',
    focus: 'attacker',
    kicker: 'Step 3 · Attacker',
    title: 'The attacker creates an account',
    lead: 'The attacker only needs an ordinary account on the same website.',
    why: {
      title: 'No access to the victim needed',
      body: 'The attacker never touches the victim’s device or password. Everything happens in the attacker’s own browser and account.',
    },
    tasks: signUpTasks('attacker', 'attacker'),
    complete: (s) => Boolean(s.facts.names.attacker),
    doneMessage: '✓ Account “{attacker}” created',
  },
  {
    id: 'overwrite',
    short: 'Overwrite key',
    marker: '4',
    focus: 'attacker',
    kicker: 'Step 4 · Attacker',
    title: 'Register a passkey with the victim’s credential ID',
    lead: 'The attacker adds a passkey to their <em>own</em> account, but gives it the <em>victim’s</em> credential ID — paired with the attacker’s own key.',
    why: {
      title: 'The bug',
      body: 'A secure website must reject a credential ID that is already registered (WebAuthn §7.1.26). This one instead <b>overwrites the public key</b> of the victim’s passkey with the attacker’s key. The passkey still belongs to the victim’s account, but now the attacker holds the matching private key.',
    },
    callout: '<b>How does the attacker know the victim’s credential ID?</b> It is not a secret: many websites reveal it to anyone who enters the victim’s username at login (<code>allowCredentials</code>). Here, both browsers share one passkeys.tools key store, so it is listed as <code>profile1 | ES256</code>.',
    tasks: [
      openSettingsTask('attacker', keyOverwritten),
      ...addPasskeyTasks('attacker', keyOverwritten),
      selectTask('attacker', 'create', 'credentialId', VICTIM_KEY, `Set <b>Credential ID</b> to <code>${VICTIM_KEY}</code> — the <span class="victim-text">victim’s</span> credential ID!`, keyOverwritten),
      selectTask('attacker', 'create', 'key', ATTACKER_KEY, `Keep <b>Key</b> = <code>${ATTACKER_KEY}</code> — the <span class="attacker-text">attacker’s</span> own key`, keyOverwritten),
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
    lead: 'The attacker logs in with the victim’s credential ID, signing with the attacker’s own private key.',
    why: {
      title: 'Why the login works',
      body: 'The website looks up the credential ID, finds the victim’s passkey, and checks the signature against its stored public key — which is now the attacker’s. The signature is valid, so the attacker is logged in <b>as the victim</b>.',
    },
    tasks: [
      logoutTask('attacker', 'Close the flag pop-up and log out: <b>{attacker}</b> → <b>Logout</b>', attackerIsVictim),
      passkeyLoginTask('attacker', attackerIsVictim),
      selectTask('attacker', 'get', 'userHandle', (s) => usernameOf(s, 'victim'), 'Set <b>User Handle</b> to <code>{victim}</code>', attackerIsVictim),
      selectTask('attacker', 'get', 'credentialId', VICTIM_KEY, `Set <b>Credential ID</b> to <code>${VICTIM_KEY}</code> — the <span class="victim-text">victim’s</span>`, attackerIsVictim),
      selectTask('attacker', 'get', 'key', ATTACKER_KEY, `Set <b>Key</b> to <code>${ATTACKER_KEY}</code> — the <span class="attacker-text">attacker’s</span>`, attackerIsVictim),
      sendTask('attacker', 'get', attackerIsVictim),
    ],
    complete: attackerIsVictim,
    doneMessage: '😈 Logged in as “{victim}” — account takeover!',
  },
  {
    id: 'lockout',
    short: 'Lockout',
    marker: '+',
    focus: 'victim',
    bonus: true,
    kicker: 'Bonus · Victim',
    title: 'The real victim is locked out',
    lead: 'The victim tries to log in with their own, genuine passkey.',
    why: {
      title: 'Locked out',
      body: 'The website now checks the victim’s signature against the attacker’s public key. It does not match, so the victim can no longer log in to their own account.',
    },
    tasks: [
      logoutTask('victim', 'Log out: <b>{victim}</b> → <b>Logout</b>', victimLockedOut),
      passkeyLoginTask('victim', victimLockedOut),
      selectTask('victim', 'get', 'userHandle', (s) => usernameOf(s, 'victim'), 'Set <b>User Handle</b> to <code>{victim}</code>', victimLockedOut),
      selectTask('victim', 'get', 'credentialId', VICTIM_KEY, `Set <b>Credential ID</b> to <code>${VICTIM_KEY}</code>`, victimLockedOut),
      selectTask('victim', 'get', 'key', VICTIM_KEY, `Set <b>Key</b> to <code>${VICTIM_KEY}</code> — the victim’s genuine key`, victimLockedOut),
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
    title: 'One missing check, full account takeover',
    points: [
      '<b>Root cause:</b> at registration, the website accepted a credential ID that already belonged to another account — and replaced its public key.',
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

export { sleep };
