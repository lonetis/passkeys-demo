import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { chromium } from 'playwright-core';
import { createLogger } from './log.js';
import { snapshotLearningPage, snapshotInterceptorPage, applyHighlights, reportUserActions } from './page-scripts.js';

const CONNECT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Remote-controls one demo browser (a browser container) over the Chrome DevTools Protocol.
 *
 * Events:
 *  - "report" ({ type: 'send', op, credentialId, key, userHandle }) when "Send" is clicked in
 *    the PASSKEYS-ATTACKER interceptor, captured synchronously so the selection is exact;
 *    ({ type: 'copy', text }) when text is copied in any page.
 *  - "passkey-result" ({ op, ok, status, credentialId, body }) for every registration /
 *    authentication verification answered by the CTF website.
 *  - "disconnected" when the CDP connection drops unexpectedly.
 */
export class BrowserController extends EventEmitter {
  constructor(role, { host, cdpPort }, { learningUrl, passkeysToolsUrl }) {
    super();
    this.role = role;
    this.host = host;
    this.cdpPort = cdpPort;
    this.learningUrl = learningUrl;
    this.passkeysToolsUrl = passkeysToolsUrl;
    this.log = createLogger(`browser:${host}`);
    this.browser = null;
    this.context = null;
    this.expectingDisconnect = false;
  }

  get connected() {
    return this.browser?.isConnected() ?? false;
  }

  async endpoint() {
    // Chromium rejects DevTools HTTP requests whose Host header is a hostname, so use the IP.
    const { address } = await lookup(this.host, { family: 4 });
    return `http://${address}:${this.cdpPort}`;
  }

  async fetchVersion() {
    const endpoint = await this.endpoint();
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`DevTools answered ${response.status}`);
    return response.json();
  }

  /** Waits until Chromium answers on its DevTools port and returns its browser websocket URL. */
  async waitForDevTools({ notUrl = null } = {}) {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const { webSocketDebuggerUrl } = await this.fetchVersion();
        if (webSocketDebuggerUrl && webSocketDebuggerUrl !== notUrl) return webSocketDebuggerUrl;
      } catch (error) {
        lastError = error;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Browser "${this.role}" did not come up within ${CONNECT_TIMEOUT_MS / 1000}s (${lastError?.message ?? 'no response'})`);
  }

  async connect() {
    this.currentDebuggerUrl = await this.waitForDevTools();
    this.browser = await chromium.connectOverCDP(await this.endpoint());
    this.context = this.browser.contexts()[0];
    this.browser.on('disconnected', () => {
      if (this.expectingDisconnect) return;
      this.log.warn('CDP connection lost');
      this.emit('disconnected');
    });
    await this.context.exposeBinding('__pkdemoReport', (_source, payload) => {
      this.emit('report', payload);
    });
    await this.context.addInitScript(reportUserActions);
    this.context.on('page', (page) => this.watchPage(page));
    this.context.pages().forEach((page) => this.watchPage(page));
    this.log.info('connected');
  }

  /**
   * Closes Chromium; the container restarts it with a wiped profile and the extension
   * freshly installed. Resolves once the new instance is connected.
   */
  async restart() {
    this.expectingDisconnect = true;
    try {
      // Attach first (also after a lost connection) so the running instance can be closed.
      if (!this.connected) await this.connect();
      const previousUrl = this.currentDebuggerUrl;
      const session = await this.browser.newBrowserCDPSession();
      await session.send('Browser.close').catch(() => {});
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
      await this.waitForDevTools({ notUrl: previousUrl });
      await this.connect();
    } finally {
      this.expectingDisconnect = false;
    }
  }

  watchPage(page) {
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (url.origin !== this.learningUrl) return;
      const op = url.pathname === '/api/passkey/registration/verify' ? 'create'
        : url.pathname === '/api/passkey/authentication/verify' ? 'get'
          : null;
      if (!op) return;
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      let credentialId = null;
      try {
        // The CTF posts { credential: <WebAuthn response JSON>, ... }.
        credentialId = response.request().postDataJSON()?.credential?.id ?? null;
      } catch {
        credentialId = null;
      }
      this.emit('passkey-result', { op, ok: response.ok() && body?.verified === true, status: response.status(), credentialId, body });
    });
  }

  pages() {
    return this.context?.pages().filter((page) => !page.isClosed()) ?? [];
  }

  learningPage() {
    return this.pages().find((page) => page.url().startsWith(this.learningUrl)) ?? null;
  }

  interceptorPage() {
    return this.pages().find((page) => {
      const url = page.url();
      return url.startsWith(this.passkeysToolsUrl) && /[#&](pkcco|pkcro)=/.test(url);
    }) ?? null;
  }

  async waitForInterceptorPage(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const page = this.interceptorPage();
      if (page) {
        // "attached": the Send button is hidden while another passkeys.tools tab (e.g. Keys) is shown.
        await page.waitForSelector('#interceptorSendButton', { state: 'attached', timeout: Math.max(1, deadline - Date.now()) });
        return page;
      }
      await sleep(200);
    }
    throw new Error('The PASSKEYS-ATTACKER interceptor tab did not open');
  }

  /**
   * Switches the passkeys.tools page to one of its tabs (e.g. "keys", "interceptor"),
   * opening the collapsed navigation menu first on narrow screens.
   */
  async openPasskeysToolsTab(page, tab) {
    const button = page.locator(`button[data-bs-target="#${tab}-tab-pane"]`);
    if (!(await button.isVisible())) {
      await page.locator('.navbar-toggler').click();
      await button.waitFor({ state: 'visible' });
      await sleep(400);
    }
    await button.click();
  }

  /** Brings a tab to the front so the audience sees what is being automated. */
  async focus(page) {
    await page.bringToFront().catch(() => {});
  }

  async snapshot() {
    if (!this.connected) return { connected: false, learning: null, interceptor: null };
    const learningPage = this.learningPage();
    const interceptorPage = this.interceptorPage();
    const [learning, interceptor] = await Promise.all([
      learningPage ? learningPage.evaluate(snapshotLearningPage).catch(() => null) : null,
      interceptorPage ? interceptorPage.evaluate(snapshotInterceptorPage).catch(() => null) : null,
    ]);
    return { connected: true, learning, interceptor };
  }

  /**
   * Shows guide highlights inside the browser. `spec` is { page: 'learning'|'interceptor',
   * targets: [...] } or null to clear. Pages other than the target page are cleared.
   */
  async highlight(spec) {
    const pages = { learning: this.learningPage(), interceptor: this.interceptorPage() };
    await Promise.all(Object.entries(pages).map(([kind, page]) => {
      if (!page) return null;
      const targets = spec && spec.page === kind ? spec.targets : [];
      return page.evaluate(applyHighlights, targets).catch(() => null);
    }));
  }
}
