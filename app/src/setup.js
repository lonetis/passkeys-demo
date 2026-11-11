import { createHash, randomUUID } from 'node:crypto';
import { generateSecret, listKeyNames } from './passkeys-tools-store.js';

/** PASSKEYS-ATTACKER operation mode per browser (see the artifact appendix, §A.3.1). */
export const PROFILE_BY_ROLE = Object.freeze({ victim: 'profile1', attacker: 'profile2' });

export const SETUP_STAGES = Object.freeze([
  { id: 'browsers', label: 'Restart both browsers with fresh, empty profiles' },
  { id: 'extension', label: 'Install PASSKEYS-ATTACKER: victim → profile1, attacker → profile2' },
  { id: 'storage', label: 'Connect both to one shared, end-to-end encrypted passkeys.tools key store' },
  { id: 'ctf', label: 'Open a fresh CTF instance shared by both browsers, with the vulnerable registration' },
]);

/** Chromium derives the ID of an unpacked extension from its absolute path. */
function unpackedExtensionId(path) {
  return createHash('sha256').update(path).digest('hex').slice(0, 32)
    .split('').map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16))).join('');
}

async function singlePage(browser) {
  const [first, ...rest] = browser.pages();
  await Promise.all(rest.map((page) => page.close().catch(() => {})));
  return first ?? browser.context.newPage();
}

async function configureExtension(browser, config) {
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

async function configureRemoteStorage(browser, config, secret) {
  const page = await singlePage(browser);
  await page.goto(`${config.passkeysToolsUrl}/settings`);
  await page.evaluate((storageConfig) => {
    localStorage.setItem('storageConfig', JSON.stringify(storageConfig));
  }, { mode: 'remote', url: config.passkeysToolsDbUrl, secret, e2ee: true });
  await page.reload();
  // The frontend generates any missing profile keys on load and only then marks the tabs loaded.
  await page.waitForSelector('.tab-content.loaded', { timeout: 60_000 });
}

async function openCtfInstance(browser, config, instanceId) {
  const secure = config.learningUrl.startsWith('https:');
  await browser.context.addCookies([
    { name: 'fwf_instance_id', value: instanceId, url: config.learningUrl, httpOnly: true, secure, sameSite: 'Lax' },
    { name: 'fwf_verifier_reg', value: String(config.verifiers.registration), url: config.learningUrl, secure, sameSite: 'Lax' },
    { name: 'fwf_verifier_auth', value: String(config.verifiers.authentication), url: config.learningUrl, secure, sameSite: 'Lax' },
  ]);
  const page = await singlePage(browser);
  await page.goto(`${config.learningUrl}/`);
}

/**
 * Brings both browsers into the demo's starting state. Everything is new on every run:
 * browser profiles (and with them the extension install), the passkeys.tools store secret,
 * and the CTF instance.
 */
export async function prepareBrowsers({ victim, attacker }, config, onStage) {
  const secret = generateSecret();
  const instanceId = randomUUID();

  onStage('browsers');
  await Promise.all([victim.restart(), attacker.restart()]);

  onStage('extension');
  await Promise.all([configureExtension(victim, config), configureExtension(attacker, config)]);

  onStage('storage');
  // Sequential on purpose: the first browser generates the profile keys in the empty store,
  // the second must find them instead of racing to generate its own.
  await configureRemoteStorage(victim, config, secret);
  await configureRemoteStorage(attacker, config, secret);
  const keyNames = await listKeyNames(config.passkeysToolsDbUrl, secret);
  for (const required of ['profile1 | ES256', 'profile2 | ES256']) {
    if (!keyNames.includes(required)) throw new Error(`passkeys.tools key store is missing "${required}"`);
  }

  onStage('ctf');
  await Promise.all([openCtfInstance(victim, config, instanceId), openCtfInstance(attacker, config, instanceId)]);

  return { instanceId };
}
