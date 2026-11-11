import { createHash } from 'node:crypto';

/**
 * Building blocks for the behind-the-scenes setup that each scenario composes in its
 * prepare() function. All of them act on a BrowserController.
 */

/** PASSKEYS-ATTACKER operation mode per browser (see the artifact appendix, §A.3.1). */
export const PROFILE_BY_ROLE = Object.freeze({ victim: 'profile1', attacker: 'profile2' });

/** Chromium derives the ID of an unpacked extension from its absolute path. */
function unpackedExtensionId(path) {
  return createHash('sha256').update(path).digest('hex').slice(0, 32)
    .split('').map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16))).join('');
}

/** Closes every tab but one and returns it. */
async function singlePage(browser) {
  const [first, ...rest] = browser.pages();
  await Promise.all(rest.map((page) => page.close().catch(() => {})));
  return first ?? browser.context.newPage();
}

/** Fresh profiles (and with them a fresh extension install) for all given browsers. */
export async function restartBrowsers(browsers) {
  await Promise.all(browsers.map((browser) => browser.restart()));
}

export async function configureExtension(browser, config) {
  const page = await singlePage(browser);
  await page.goto(`chrome-extension://${unpackedExtensionId(config.extensionPath)}/popup.html`);
  await page.evaluate((settings) => chrome.storage.local.set(settings), {
    extensionEnabled: true,
    interceptorMode: PROFILE_BY_ROLE[browser.role],
    // "inline" opens the interceptor as a tab in the same window, which reads best over VNC.
    popupMode: 'inline',
    frontendUrl: config.passkeysToolsUrl,
  });
}

async function waitForPasskeysToolsKeys(page) {
  // The frontend generates any missing profile keys on load and only then marks the tabs loaded.
  await page.waitForSelector('.tab-content.loaded', { timeout: 60_000 });
}

/** Keeps the browser's own key store in its local storage (nothing shared). */
export async function initLocalKeyStore(browser, config) {
  const page = await singlePage(browser);
  await page.goto(`${config.passkeysToolsUrl}/keys`);
  await waitForPasskeysToolsKeys(page);
}

/**
 * Points the browser at a shared, end-to-end encrypted remote key store. Run this for one
 * browser after the other: the first generates the profile keys in the empty store, the
 * second must find them instead of racing to generate its own.
 */
export async function connectRemoteKeyStore(browser, config, secret) {
  const page = await singlePage(browser);
  await page.goto(`${config.passkeysToolsUrl}/settings`);
  await page.evaluate((storageConfig) => {
    localStorage.setItem('storageConfig', JSON.stringify(storageConfig));
  }, { mode: 'remote', url: config.passkeysToolsDbUrl, secret, e2ee: true });
  await page.reload();
  await waitForPasskeysToolsKeys(page);
}

/** Joins the shared CTF instance with the given registration/authentication verifiers. */
export async function openCtfInstance(browser, config, instanceId, { registrationVerifier, authenticationVerifier }) {
  const secure = config.learningUrl.startsWith('https:');
  await browser.context.addCookies([
    { name: 'fwf_instance_id', value: instanceId, url: config.learningUrl, httpOnly: true, secure, sameSite: 'Lax' },
    { name: 'fwf_verifier_reg', value: String(registrationVerifier), url: config.learningUrl, secure, sameSite: 'Lax' },
    { name: 'fwf_verifier_auth', value: String(authenticationVerifier), url: config.learningUrl, secure, sameSite: 'Lax' },
  ]);
  const page = await singlePage(browser);
  await page.goto(`${config.learningUrl}/`);
}

export async function createCtfAccount(browser, config, username, password) {
  const page = await singlePage(browser);
  await page.goto(`${config.learningUrl}/register`);
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.fill('#confirmPassword', password);
  await page.click('form[action="/register"] button[type="submit"]');
  await page.waitForSelector('ul.navbar-nav.align-items-center .dropdown-toggle');
}

/** Registers a passkey with the interceptor's defaults and stays on the passkey management page. */
export async function registerDefaultPasskey(browser, config) {
  const page = await singlePage(browser);
  await page.goto(`${config.learningUrl}/settings`);
  await page.click('#add-passkey-btn');
  await page.waitForSelector('#confirm-add-passkey:visible');
  await page.click('#confirm-add-passkey');
  const interceptor = await browser.waitForInterceptorPage();
  await interceptor.click('#interceptorSendButton');
  await page.bringToFront();
  await page.waitForSelector('.delete-passkey-btn', { timeout: 20_000 });
}

export async function logOutOfCtf(browser, config) {
  const page = await singlePage(browser);
  await page.goto(`${config.learningUrl}/logout`);
  await page.goto(`${config.learningUrl}/`);
}
