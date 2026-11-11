/**
 * Functions that are serialized by Playwright and executed inside the demo browsers.
 * They must be self-contained: no imports, no closures over module scope.
 */

/** Reads what the guide needs to know from the CTF website (learning platform). */
export function snapshotLearningPage() {
  const isVisible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const valueOf = (id) => document.getElementById(id)?.value ?? '';
  const userToggle = document.querySelector('ul.navbar-nav.align-items-center .dropdown-toggle');
  const statusBox = document.getElementById('passkey-status');
  return {
    path: location.pathname,
    user: userToggle ? userToggle.textContent.trim() : null,
    register: location.pathname === '/register'
      ? { username: valueOf('username'), password: valueOf('password'), confirm: valueOf('confirmPassword') }
      : null,
    addPasskeyModalOpen: document.getElementById('addPasskeyModal')?.classList.contains('show') ?? false,
    rewardModalOpen: document.getElementById('rewardModal')?.classList.contains('show') ?? false,
    userMenuOpen: isVisible(document.querySelector('a.dropdown-item[href="/settings"]')),
    passkeyMessage: isVisible(statusBox) ? statusBox.textContent.trim() : null,
  };
}

/** Reads the current selection of the PASSKEYS-ATTACKER interceptor tab. */
export function snapshotInterceptorPage() {
  const op = document.getElementById('getCredentialIdSelect') ? 'get'
    : document.getElementById('createCredentialIdSelect') ? 'create'
      : null;
  const selectedText = (id) => document.getElementById(id)?.selectedOptions?.[0]?.text ?? null;
  return {
    op,
    ready: Boolean(document.getElementById('interceptorSendButton')),
    credentialId: op ? selectedText(`${op}CredentialIdSelect`) : null,
    key: op ? selectedText(`${op}KeySelect`) : null,
    userHandle: op === 'get' ? selectedText('getUserHandleSelect') : null,
  };
}

/**
 * Init script: reports the interceptor selection at the exact moment "Send" is clicked.
 * Polling alone could miss a change made just before clicking.
 */
export function reportInterceptorSends() {
  if (window.top !== window) return;
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('#interceptorSendButton') : null;
    if (!button || typeof window.__pkdemoReport !== 'function') return;
    const selectedText = (id) => document.getElementById(id)?.selectedOptions?.[0]?.text ?? null;
    const op = document.getElementById('getCredentialIdSelect') ? 'get' : 'create';
    window.__pkdemoReport({
      op,
      credentialId: selectedText(`${op}CredentialIdSelect`),
      key: selectedText(`${op}KeySelect`),
      userHandle: op === 'get' ? selectedText('getUserHandleSelect') : null,
    });
  }, true);
}

/**
 * Draws the guide's "click here" highlights. Idempotent: called on every guide tick,
 * it adds, moves or removes highlights so they survive navigation and DOM changes.
 *
 * targets: [{ id, selectors: string[], label, option?: string }]
 * The first visible element matching any selector is highlighted; `option` additionally
 * marks (and scrolls to) the option with that text inside a listbox <select>.
 */
export function applyHighlights(targets) {
  const STYLE_ID = 'pkdemo-style';
  const ACCENT = '#22d3ee';
  const ACCENT_DARK = '#0e7490';

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [data-pkdemo-hl] {
        outline: 4px solid ${ACCENT} !important;
        outline-offset: 3px !important;
        animation: pkdemo-pulse 1.3s ease-in-out infinite !important;
      }
      @keyframes pkdemo-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(34, 211, 238, 0.8); }
        50% { box-shadow: 0 0 0 12px rgba(34, 211, 238, 0); }
      }
      option[data-pkdemo-option] {
        background: ${ACCENT} !important;
        color: #000 !important;
        font-weight: 700 !important;
      }
      .pkdemo-tip {
        position: absolute;
        z-index: 2147483647;
        max-width: 420px;
        background: ${ACCENT_DARK};
        color: #fff;
        font: 600 15px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
        padding: 7px 12px;
        border-radius: 8px;
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.35);
        pointer-events: none;
        transform: translate(-50%, calc(-100% - 14px));
      }
      .pkdemo-tip::after {
        content: "";
        position: absolute;
        left: var(--arrow-x, 50%);
        bottom: -7px;
        margin-left: -7px;
        border: 7px solid transparent;
        border-bottom: 0;
        border-top-color: ${ACCENT_DARK};
      }
      .pkdemo-tip.pkdemo-below { transform: translate(-50%, 14px); }
      .pkdemo-tip.pkdemo-below::after {
        top: -7px;
        bottom: auto;
        border-top: 0;
        border-bottom: 7px solid ${ACCENT_DARK};
      }
    `;
    document.documentElement.appendChild(style);
  }

  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  };

  const wanted = new Map();
  for (const target of targets) {
    for (const selector of target.selectors) {
      const element = [...document.querySelectorAll(selector)].find(isVisible);
      if (element) {
        wanted.set(element, target);
        break;
      }
    }
  }

  document.querySelectorAll('[data-pkdemo-hl]').forEach((element) => {
    if (!wanted.has(element)) element.removeAttribute('data-pkdemo-hl');
  });
  document.querySelectorAll('option[data-pkdemo-option]').forEach((option) => option.removeAttribute('data-pkdemo-option'));

  const existingTips = new Map([...document.querySelectorAll('.pkdemo-tip')].map((tip) => [tip.dataset.key, tip]));
  const usedTips = new Set();
  let scrolledThisTick = false;

  for (const [element, target] of wanted) {
    element.setAttribute('data-pkdemo-hl', '');

    if (target.option && element.tagName === 'SELECT') {
      const option = [...element.options].find((candidate) => candidate.text === target.option);
      if (option) {
        option.setAttribute('data-pkdemo-option', '');
        if (element.dataset.pkdemoScrolledTo !== target.option) {
          element.scrollTop = option.offsetTop - element.clientHeight / 2 + option.offsetHeight / 2;
          element.dataset.pkdemoScrolledTo = target.option;
        }
      }
    }

    const key = String(target.id);
    let tip = existingTips.get(key);
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'pkdemo-tip';
      tip.dataset.key = key;
      document.documentElement.appendChild(tip);
    }
    if (tip.textContent !== target.label) tip.textContent = target.label;
    usedTips.add(key);

    const rect = element.getBoundingClientRect();
    const below = rect.top < 70;
    tip.classList.toggle('pkdemo-below', below);
    const halfWidth = tip.offsetWidth / 2;
    const anchorX = rect.left + rect.width / 2;
    const clampedX = Math.min(Math.max(anchorX, halfWidth + 8), document.documentElement.clientWidth - halfWidth - 8);
    tip.style.left = `${clampedX + window.scrollX}px`;
    tip.style.top = `${(below ? rect.bottom : rect.top) + window.scrollY}px`;
    tip.style.setProperty('--arrow-x', `${halfWidth + (anchorX - clampedX)}px`);

    if (!scrolledThisTick && document.documentElement.dataset.pkdemoScrolledTo !== key) {
      const outOfView = rect.top < 0 || rect.bottom > window.innerHeight;
      if (outOfView) element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      document.documentElement.dataset.pkdemoScrolledTo = key;
      scrolledThisTick = true;
    }
  }

  existingTips.forEach((tip, key) => {
    if (!usedTips.has(key)) tip.remove();
  });
}
