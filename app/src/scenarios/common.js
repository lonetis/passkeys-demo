/**
 * Shared building blocks for guided scenarios on the Fun with Flags and Passkeys CTF.
 *
 * A scenario step has tasks. Each task knows
 *  - role:      the browser it happens in (defaults to the step's focus),
 *  - text:      what to do (HTML; {victim}/{attacker} are replaced with the usernames),
 *  - done(s):   whether it is done, derived from live browser state and recorded facts,
 *  - highlight: where to point in the real browser,
 *  - run(a):    how to do it automatically ("Do it for me").
 *
 * done() is evaluated live and never latched, and each predicate also accepts every later
 * state of the flow. So the first unfinished task is always the right next action, even
 * after a detour (e.g. the interceptor tab was closed, or a wrong option was sent).
 */

/** Key names as shown in the demo browsers' passkeys.tools UI (see relabelPasskeysTools). */
export const VICTIM_KEY = 'victim | ES256';
export const ATTACKER_KEY = 'attacker | ES256';
/** Password of every account the demo creates in the CTF (public, throwaway instances). */
export const CTF_PASSWORD = 'passkeys';

export const SELECTORS = Object.freeze({
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
  usernameFirstUsername: '#username-check-form #username',
  usernameFirstContinue: '#username-check-form button[type="submit"]',
  passwordFallbackPassword: '#password-form #password',
  passwordFallbackSubmit: '#password-form button[type="submit"]',
  send: '#interceptorSendButton',
  dismiss: '#interceptorDismissButton',
  requestTextarea: '#interceptorRequestTextarea',
  responseTextarea: '#interceptorResponseTextarea',
  navToggler: '.navbar-toggler',
  keysUpdateB64url: '#keysUpdateCredentialIdB64urlInput',
  keysUpdateKey: '#keysUpdateCredentialIdSelect',
  keysUpdateButton: '#keysUpdateCredentialIdBtn',
});

/** Navigation button of a passkeys.tools tab ("keys", "interceptor", ...). */
export const passkeysToolsTabButton = (tab) => `button[data-bs-target="#${tab}-tab-pane"]`;

/** The response line the interceptor fills with the stored user handle. */
export const USER_HANDLE_LINE_PATTERN = '^[ \\t]*"userHandle":[^\\n]*\\n';

export const SELECT_IDS = Object.freeze({
  create: { credentialId: '#createCredentialIdSelect', key: '#createKeySelect' },
  get: { userHandle: '#getUserHandleSelect', credentialId: '#getCredentialIdSelect', key: '#getKeySelect' },
});

export const FIELD_LABELS = Object.freeze({ userHandle: 'User Handle', credentialId: 'Credential ID', key: 'Key' });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Autopilot pacing inside a task (the pause before each task is AUTOPILOT_PAUSE_MS):
 * between two actions of one task, and per typed character.
 */
export const BEAT_MS = 1000;
export const TYPING_DELAY_MS = 120;
/** Time for a text selection made by the highlight to be seen before acting on it. */
export const SHOW_SELECTION_MS = 1500;

// ─── State helpers ──────────────────────────────────────────────────────────

export const learning = (s, role) => s[role]?.learning ?? null;
export const interceptor = (s, role) => s[role]?.interceptor ?? null;
export const interceptorOpen = (s, role, op) => interceptor(s, role)?.op === op && interceptor(s, role)?.ready === true;
export const usernameOf = (s, role) => s.facts.names[role] ?? role;

// ─── Automation helpers ─────────────────────────────────────────────────────

export async function clickVisible(page, selector) {
  const target = page.locator(selector).filter({ visible: true }).first();
  await target.scrollIntoViewIfNeeded();
  await target.click();
}

export async function openUserMenuItem(page, itemSelector) {
  const item = page.locator(itemSelector).filter({ visible: true });
  if (await item.count() === 0) await clickVisible(page, SELECTORS.userMenu);
  await sleep(BEAT_MS);
  await clickVisible(page, itemSelector);
}

export async function learningPageOf(browser) {
  const page = browser.learningPage();
  if (!page) throw new Error(`No CTF tab open in the ${browser.role} browser`);
  await browser.focus(page);
  return page;
}

// ─── Task factories ─────────────────────────────────────────────────────────

export function signUpTasks(role, suggestedName) {
  const loggedIn = (s) => Boolean(learning(s, role)?.user);
  const form = (s) => learning(s, role)?.register;
  const formFilled = (s) => {
    const f = form(s);
    return Boolean(f && f.username.trim() && f.password.length >= 4 && f.confirm === f.password);
  };
  return [
    {
      role,
      id: 'open-register',
      text: 'Click <b>Register</b> (top right)',
      done: (s) => learning(s, role)?.path === '/register' || loggedIn(s),
      highlight: () => ({ page: 'learning', targets: [{ id: 'register', selectors: [SELECTORS.registerButton], label: 'Click “Register”' }] }),
      run: async ({ browser }) => clickVisible(await learningPageOf(browser), SELECTORS.registerButton),
    },
    {
      role,
      id: 'fill-form',
      text: `Username <code>${suggestedName}</code>, any password (twice)`,
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
        for (const [selector, value] of [['#username', suggestedName], ['#password', CTF_PASSWORD], ['#confirmPassword', CTF_PASSWORD]]) {
          await page.fill(selector, '');
          await page.locator(selector).pressSequentially(value, { delay: TYPING_DELAY_MS });
          await sleep(BEAT_MS / 2);
        }
      },
    },
    {
      role,
      id: 'submit',
      text: 'Click <b>Create Account</b>',
      done: loggedIn,
      highlight: () => ({ page: 'learning', targets: [{ id: 'create-account', selectors: [SELECTORS.registerSubmit], label: 'Click “Create Account”' }] }),
      run: async ({ browser }) => clickVisible(await learningPageOf(browser), SELECTORS.registerSubmit),
    },
  ];
}

export function openSettingsTask(role, finished) {
  return {
    role,
    id: 'open-settings',
    text: `Open <b>{${role}}</b> → <b>Settings</b>`,
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

export function addPasskeyTasks(role, finished) {
  return [
    {
      role,
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
      role,
      id: 'register-passkey',
      text: 'Click <b>Register Passkey</b> — the interceptor opens',
      done: (s) => interceptorOpen(s, role, 'create') || finished(s),
      highlight: () => ({ page: 'learning', targets: [{ id: 'register-passkey', selectors: [SELECTORS.confirmAddPasskey], label: 'Click “Register Passkey”' }] }),
      run: async ({ browser }) => {
        await clickVisible(await learningPageOf(browser), SELECTORS.confirmAddPasskey);
        await browser.focus(await browser.waitForInterceptorPage());
      },
    },
  ];
}

export function selectTask(role, op, field, expected, text, finished) {
  const selector = SELECT_IDS[op][field];
  const value = (s) => (typeof expected === 'function' ? expected(s) : expected);
  return {
    role,
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
      await sleep(BEAT_MS / 2);
      await page.selectOption(selector, { label: value(state()) });
    },
  };
}

export function sendTask(role, op, finished) {
  return {
    role,
    id: 'send',
    text: 'Click <b>Send</b>',
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

export function logoutTask(role, text, finished) {
  return {
    role,
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

export function passkeyLoginTask(role, finished) {
  return {
    role,
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
      await sleep(BEAT_MS);
      await clickVisible(page, SELECTORS.passkeyLogin);
      await browser.focus(await browser.waitForInterceptorPage());
    },
  };
}

/**
 * Several interceptor selections at once (e.g. Credential ID and Key), typically defaults to
 * confirm. `expected` is { field: optionText } or a function of the guide state returning it.
 */
export function keepSelectionTask(role, op, expected, text, finished) {
  const expectations = (s) => (typeof expected === 'function' ? expected(s) : expected);
  const mismatches = (s) => Object.entries(expectations(s)).filter(([field, value]) => interceptor(s, role)?.[field] !== value);
  return {
    role,
    id: `keep-selection-${op}`,
    text,
    done: (s) => (interceptorOpen(s, role, op) && mismatches(s).length === 0) || finished(s),
    highlight: (s) => {
      if (!interceptorOpen(s, role, op)) return null;
      const [field, value] = mismatches(s)[0] ?? Object.entries(expectations(s))[0];
      return {
        page: 'interceptor',
        targets: [{ id: `select-${field}`, selectors: [SELECT_IDS[op][field]], label: `${FIELD_LABELS[field]} → ${value}`, option: value }],
      };
    },
    run: async ({ browser, state }) => {
      const page = await browser.waitForInterceptorPage();
      await browser.focus(page);
      for (const [field, value] of mismatches(state())) {
        await page.locator(SELECT_IDS[op][field]).scrollIntoViewIfNeeded();
        await sleep(BEAT_MS);
        await page.selectOption(SELECT_IDS[op][field], { label: value });
      }
    },
  };
}

/** Highlights for the username step of the username-first login ("Non-Discoverable" verifier). */
function usernameFirstHighlight(s, role, username) {
  const l = learning(s, role);
  if (l?.path !== '/login') {
    return { page: 'learning', targets: [{ id: 'login', selectors: [SELECTORS.loginButton], label: 'Click “Login”' }] };
  }
  if (l.usernameFirst?.username.trim() !== username) {
    return { page: 'learning', targets: [{ id: 'username', selectors: [SELECTORS.usernameFirstUsername], label: `Type “${username}”` }] };
  }
  return { page: 'learning', targets: [{ id: 'continue', selectors: [SELECTORS.usernameFirstContinue], label: 'Click “Continue”' }] };
}

async function submitUsernameFirst(browser, username) {
  const page = await learningPageOf(browser);
  if (new URL(page.url()).pathname !== '/login') {
    await clickVisible(page, SELECTORS.loginButton);
    await page.waitForURL('**/login');
    await sleep(BEAT_MS);
  }
  const field = page.locator(SELECTORS.usernameFirstUsername);
  if ((await field.inputValue()).trim() !== username) {
    await field.fill('');
    await field.pressSequentially(username, { delay: TYPING_DELAY_MS });
    await sleep(BEAT_MS / 2);
  }
  await clickVisible(page, SELECTORS.usernameFirstContinue);
}

/**
 * Username-first login of a user who has a passkey: the website answers with the user's
 * credential IDs (allowCredentials) and calls WebAuthn, so the interceptor opens.
 */
export function usernameFirstPasskeyLoginTask(role, username, text, finished) {
  return {
    role,
    id: 'username-first-login',
    text,
    done: (s) => interceptorOpen(s, role, 'get') || finished(s),
    highlight: (s) => usernameFirstHighlight(s, role, typeof username === 'function' ? username(s) : username),
    run: async ({ browser, state }) => {
      await submitUsernameFirst(browser, typeof username === 'function' ? username(state()) : username);
      await browser.focus(await browser.waitForInterceptorPage());
    },
  };
}

/** Username-first login of a user without passkeys: the website falls back to the password. */
export function passwordFallbackLoginTasks(role, username, finished) {
  const loggedIn = (s) => learning(s, role)?.user === username || finished(s);
  return [
    {
      role,
      id: 'username',
      text: `Username <code>${username}</code> → <b>Continue</b>`,
      done: (s) => Boolean(learning(s, role)?.usernameFirst?.passwordVisible) || loggedIn(s),
      highlight: (s) => usernameFirstHighlight(s, role, username),
      run: async ({ browser }) => {
        await submitUsernameFirst(browser, username);
        const page = await learningPageOf(browser);
        await page.waitForSelector(`${SELECTORS.passwordFallbackPassword}:visible`);
      },
    },
    {
      role,
      id: 'password',
      text: `Password <code>${CTF_PASSWORD}</code> → <b>Login</b>`,
      done: loggedIn,
      highlight: (s) => (learning(s, role)?.usernameFirst?.password
        ? { page: 'learning', targets: [{ id: 'password-login', selectors: [SELECTORS.passwordFallbackSubmit], label: 'Click “Login”' }] }
        : { page: 'learning', targets: [{ id: 'password', selectors: [SELECTORS.passwordFallbackPassword], label: `Type “${CTF_PASSWORD}”` }] }),
      run: async ({ browser }) => {
        const page = await learningPageOf(browser);
        await page.locator(SELECTORS.passwordFallbackPassword).pressSequentially(CTF_PASSWORD, { delay: TYPING_DELAY_MS });
        await sleep(BEAT_MS / 2);
        await clickVisible(page, SELECTORS.passwordFallbackSubmit);
      },
    },
  ];
}

/**
 * The interceptor answers with the user handle stored for this browser's own account. A
 * username-first login does not need one, so the attacker deletes it (one keypress, since
 * the guide pre-selects the line).
 */
export function removeUserHandleTask(role, text, finished) {
  return {
    role,
    id: 'remove-user-handle',
    text,
    done: (s) => (interceptorOpen(s, role, 'get') && interceptor(s, role).responseHasUserHandle === false) || finished(s),
    highlight: (s) => (interceptorOpen(s, role, 'get') ? {
      page: 'interceptor',
      targets: [{
        id: 'user-handle',
        selectors: [SELECTORS.responseTextarea],
        label: 'Selected: the attacker’s own user handle → press Delete',
        select: { pattern: USER_HANDLE_LINE_PATTERN },
      }],
    } : null),
    run: async ({ browser }) => {
      const page = await browser.waitForInterceptorPage();
      await browser.focus(page);
      await page.evaluate((pattern) => {
        const textarea = document.getElementById('interceptorResponseTextarea');
        const match = new RegExp(pattern, 'm').exec(textarea.value);
        if (!match) return;
        textarea.focus();
        textarea.setSelectionRange(match.index, match.index + match[0].length);
      }, USER_HANDLE_LINE_PATTERN);
      await sleep(SHOW_SELECTION_MS);
      await page.keyboard.press('Delete');
    },
  };
}

/** Highlight for a passkeys.tools tab button, pointing at the menu toggle first if collapsed. */
export function passkeysToolsTabHighlight(s, role, tab, label) {
  const navVisible = interceptor(s, role)?.navVisible;
  return {
    page: 'interceptor',
    targets: [{
      id: `tab-${tab}`,
      selectors: [passkeysToolsTabButton(tab), SELECTORS.navToggler],
      label: navVisible ? label : 'Open the menu',
    }],
  };
}

// ─── Facts that complete steps ──────────────────────────────────────────────

export const victimHasPasskey = (s) => Boolean(s.facts.victimPasskey);
export const keyOverwritten = (s) => Boolean(s.facts.overwrite);
export const attackerIsVictim = (s) => Boolean(s.facts.takeover);
export const victimLockedOut = (s) => Boolean(s.facts.lockout);
