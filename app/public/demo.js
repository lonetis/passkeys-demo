import RFB from '/vendor/rfb.js';

const ROLES = ['victim', 'attacker'];
const CELEBRATION_MS = 8000;
/** The demo instance this page shows, from its URL (e.g. /attacker-view). */
const DEMO_ID = location.pathname.split('/').filter(Boolean)[0];

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let state = null;
let socket = null;
let seenCelebrationAt = undefined;
let celebrationTimer = null;
const rendered = new Map();

// ─── Server connection ──────────────────────────────────────────────────

function connectState() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}/ws/${DEMO_ID}`);
  socket.addEventListener('message', (event) => {
    state = JSON.parse(event.data);
    render();
  });
  socket.addEventListener('close', () => setTimeout(connectState, 1500));
}

function send(action, extra = {}) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ action, ...extra }));
}

// ─── Remote browser screens (noVNC) ─────────────────────────────────────

function connectScreen(role) {
  const container = document.getElementById(`screen-${role}`);
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const connect = () => {
    const rfb = new RFB(container, `${protocol}://${location.host}/vnc/${DEMO_ID}/${role}`, { shared: true, wsProtocols: ['binary'] });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.background = 'transparent';
    rfb.qualityLevel = 7;
    rfb.compressionLevel = 2;
    rfb.addEventListener('disconnect', () => setTimeout(connect, 1500));
  };
  connect();
}

// ─── Rendering ──────────────────────────────────────────────────────────

/** Re-renders a section only when its inputs changed, so animations and focus survive. */
function renderOnce(key, inputs, draw) {
  const signature = JSON.stringify(inputs);
  if (rendered.get(key) === signature) return;
  rendered.set(key, signature);
  draw();
}

function render() {
  const ready = state.phase === 'ready';
  const step = state.steps[state.stepIndex];
  $('#stage').dataset.focus = ready && step.focus ? step.focus : 'none';

  renderOnce('versions', [state.demo, state.demos], renderVersions);
  renderOnce('stepper', [state.phase, state.stepIndex, state.steps.map((s) => [s.short, s.marker, s.focus, s.complete])], renderStepper);
  renderOnce('status', [state.phase, state.browsers], renderBrowserStatus);
  renderOnce('setup', [state.phase, state.setup], renderSetup);
  renderOnce('step', [state.phase, state.stepIndex, step, state.notice, state.autopilotRunning], () => renderStep(step));
  renderOnce('why', [step.why, step.callout], () => renderWhy(step));
  renderOnce('db', [state.passkeys, state.lastLogin, state.names, state.leakedCredentialId], renderDatabase);
  renderCelebration();
}

function renderVersions() {
  document.title = `${state.demo.title} · Passkey Takeover Demo`;
  $('#versions').innerHTML = state.demos.map((demo) => `
    <a class="version-link${demo.id === state.demo.id ? ' active' : ''}" href="/${encodeURIComponent(demo.id)}"
      ${demo.id === state.demo.id ? 'aria-current="page"' : ''}>${esc(demo.title)}</a>`).join('');
}

function renderStepper() {
  const ready = state.phase === 'ready';
  $('#stepper').innerHTML = state.steps.map((step, index) => `
    <button type="button" class="step-pill${index === state.stepIndex ? ' active' : ''}${step.complete && step.tasks.length ? ' complete' : ''}"
      data-goto="${index}" data-focus="${step.focus ?? 'none'}" ${ready ? '' : 'disabled'} title="${esc(step.kicker)}: ${esc(step.short)}">
      <span class="dot">${step.complete && step.tasks.length ? '✓' : esc(step.marker)}</span>
      <span class="label">${esc(step.short)}</span>
    </button>`).join('');
}

function renderBrowserStatus() {
  for (const role of ROLES) {
    const element = document.querySelector(`[data-status="${role}"]`);
    const info = state.browsers[role];
    if (state.phase === 'preparing') element.textContent = 'setting up…';
    else if (!info?.connected) element.textContent = 'disconnected';
    else if (info.user) element.innerHTML = `● logged in as <b>${esc(info.user)}</b>`;
    else element.textContent = '○ not logged in';
  }
}

function renderSetup() {
  const card = $('#setup-card');
  card.hidden = state.phase === 'ready';
  card.classList.toggle('failed', state.phase === 'failed');
  $('#setup-heading').textContent = state.phase === 'failed' ? 'Setup failed' : 'Preparing a fresh demo…';
  $('#setup-stages').innerHTML = state.setup.stages
    .map((stage) => `<li data-status="${esc(stage.status)}">${esc(stage.label)}</li>`).join('');
  const error = $('#setup-error');
  error.hidden = !state.setup.error;
  error.textContent = state.setup.error ?? '';
  $('#setup-retry').hidden = state.phase !== 'failed';
}

function renderStep(step) {
  const card = $('#step-card');
  const ready = state.phase === 'ready';
  const isFirst = state.stepIndex === 0;
  const isLast = state.stepIndex === state.steps.length - 1;
  const hasTasks = step.tasks.length > 0;
  card.dataset.focus = step.focus ?? 'none';

  const points = step.points.length ? `<ul class="step-points">${step.points.map((p) => `<li>${p}</li>`).join('')}</ul>` : '';
  const tasks = hasTasks ? `<ol class="tasks">${step.tasks.map((task) => `
      <li class="task${task.done ? ' done' : ''}${task.current ? ' current' : ''}"><span class="task-text">${task.html}</span></li>`).join('')}</ol>` : '';
  const done = step.complete && step.doneMessage ? `<div class="alert alert-ok done-pill">${step.doneMessage}</div>` : '';
  const notice = state.notice ? `<div class="alert alert-${esc(state.notice.level)}">${state.notice.html}</div>` : '';

  const autopilotButton = hasTasks && !step.complete
    ? `<button class="btn btn-outline" type="button" data-action="autopilot" ${ready && !state.autopilotRunning ? '' : 'disabled'}>
        ${state.autopilotRunning ? '<span class="spinner"></span> Running…' : '▶ Do it for me'}</button>`
    : '';
  const nextLabel = isFirst ? 'Start the demo →' : step.bonus ? (step.complete ? 'Takeaways →' : 'Skip to takeaways →') : 'Next →';
  const nextButton = isLast
    ? `<button class="btn btn-primary" type="button" data-action="reset" ${state.phase === 'preparing' ? 'disabled' : ''}>⟲ Run it again</button>`
    : `<button class="btn btn-primary${ready && (isFirst || step.complete) ? ' pulse' : ''}" type="button" data-action="next" ${ready ? '' : 'disabled'}>${nextLabel}</button>`;
  const backButton = isFirst ? '' : `<button class="btn btn-ghost" type="button" data-action="prev" ${ready ? '' : 'disabled'}>←</button>`;

  card.innerHTML = `
    <div class="step-scroll">
      <div class="kicker">${esc(step.kicker)}</div>
      <h2 class="step-title">${step.title}</h2>
      ${step.lead ? `<p class="step-lead">${step.lead}</p>` : ''}
      ${points}
      ${tasks}
      ${notice}
    </div>
    <div class="step-actions">
      ${backButton}
      ${autopilotButton}
      ${done || '<span class="spacer"></span>'}
      ${isFirst && !ready ? '<span class="hint">Browsers are being prepared…</span>' : ''}
      ${nextButton}
    </div>`;
  const scroller = card.querySelector('.step-scroll');
  const highlight = scroller.querySelector('.alert') ?? scroller.querySelector('.task.current');
  if (highlight) highlight.scrollIntoView({ block: 'nearest' });
  else scroller.scrollTop = 0;
}

function renderWhy(step) {
  const card = $('#why-card');
  if (!step.why) {
    card.innerHTML = '';
    return;
  }
  card.innerHTML = `
    <header class="card-head">
      <span class="card-icon" aria-hidden="true">💡</span>
      <h2>${esc(step.why.title)}</h2>
    </header>
    <p class="why-body">${step.why.body}</p>
    ${step.callout ? `<div class="callout">${step.callout}</div>` : ''}`;
}

function roleOfAccount(account) {
  if (account && account === state.names.victim) return 'victim';
  if (account && account === state.names.attacker) return 'attacker';
  return '';
}

const KEY_LABEL = { victim: 'victim’s key', attacker: 'attacker’s key' };
const shortId = (id) => (id && id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id ?? '');

function renderDatabase() {
  const rows = state.passkeys.map((row) => `
    <tr class="${row.overwritten ? 'overwritten' : ''}">
      <td>
        <span class="cred-name">${esc(row.credentialName ?? 'unknown')}</span><span class="cred-id">${esc(shortId(row.credentialId))}</span>
        ${state.leakedCredentialId && row.credentialId === state.leakedCredentialId ? '<span class="leak-tag">🔎 known to attacker</span>' : ''}
      </td>
      <td><span class="account ${roleOfAccount(row.account)}">${esc(row.account)}</span></td>
      <td>
        <span class="key-chip ${esc(row.keyOwner ?? '')}">🔑 ${esc(KEY_LABEL[row.keyOwner] ?? 'unknown key')}</span>
        <span class="cred-id">${esc(row.keyName ?? '')}</span>
        ${row.overwritten ? '<span class="overwrite-tag">OVERWRITTEN</span>' : ''}
      </td>
    </tr>`).join('');
  $('#db-rows').innerHTML = rows || '<tr class="db-empty"><td colspan="3">No passkeys registered yet.</td></tr>';

  $('#leaked-id').innerHTML = state.leakedCredentialId ? `
    <div class="card-sub" style="margin-bottom:4px">Leaked to the attacker at login (allowCredentials)</div>
    <code>${esc(shortId(state.leakedCredentialId))}</code>` : '';

  const login = state.lastLogin;
  $('#last-login').innerHTML = login ? `
    <div class="card-sub" style="margin-bottom:4px">Last passkey login</div>
    <div class="login-line">
      <span class="account ${login.role}">${login.role === 'victim' ? 'Victim’s browser' : 'Attacker’s browser'}</span>
      used credential <code>${esc(shortId(login.credentialId ?? '?'))}</code>
      signed with <span class="key-chip ${esc(login.keyOwner ?? '')}">🔑 ${esc(KEY_LABEL[login.keyOwner] ?? 'unknown key')}</span>
      →
      ${login.ok
        ? `<span class="login-result ok">✓ logged in as ${esc(login.user)}</span>`
        : `<span class="login-result fail">✗ ${esc(login.error ?? 'failed')}</span>`}
    </div>` : '';
}

function celebrationMarkup(celebration) {
  const victim = esc(state.names.victim ?? 'victim');
  switch (celebration.kind) {
    case 'flag':
      return `<div class="celebration-card attacker">
        <div class="celebration-title">🚩 Flag captured!</div>
        ${celebration.imageUrl ? `<img class="celebration-flag" src="${esc(celebration.imageUrl)}" alt="${esc(celebration.title)}">` : ''}
        <div class="celebration-text"><b>${esc(celebration.country)}</b> — the CTF detected the exploit: the victim’s passkey now holds the attacker’s key.</div>
        <div class="celebration-hint">click to close</div></div>`;
    case 'takeover':
      return `<div class="celebration-card attacker">
        <div class="celebration-emoji">😈</div>
        <div class="celebration-title">Account takeover!</div>
        <div class="celebration-text">The attacker is logged in as <b>${victim}</b> — using the attacker’s own key.</div>
        <div class="celebration-hint">click to close</div></div>`;
    case 'lockout':
      return `<div class="celebration-card victim">
        <div class="celebration-emoji">🔒</div>
        <div class="celebration-title">Victim locked out</div>
        <div class="celebration-text"><b>${victim}</b> can no longer log in with their own passkey.</div>
        <div class="celebration-hint">click to close</div></div>`;
    default:
      return '';
  }
}

function renderCelebration() {
  const celebration = state.celebration;
  const at = celebration?.at ?? null;
  // Do not replay a celebration that happened before this page was opened.
  if (seenCelebrationAt === undefined) {
    seenCelebrationAt = at;
    return;
  }
  if (at === seenCelebrationAt) return;
  seenCelebrationAt = at;
  const overlay = $('#celebration');
  if (!celebration) {
    overlay.hidden = true;
    return;
  }
  overlay.innerHTML = celebrationMarkup(celebration);
  // Cover the browser that is not acting, so the real result stays visible in the other one.
  overlay.dataset.side = celebration.kind === 'lockout' ? 'right' : 'left';
  overlay.hidden = false;
  clearTimeout(celebrationTimer);
  celebrationTimer = setTimeout(() => { overlay.hidden = true; }, CELEBRATION_MS);
}

// ─── Controls ───────────────────────────────────────────────────────────

let resetArmedTimer = null;

function armOrReset(button) {
  if (button.dataset.armed === 'true') {
    clearTimeout(resetArmedTimer);
    button.dataset.armed = 'false';
    button.textContent = '⟲ Reset demo';
    send('reset');
    return;
  }
  button.dataset.armed = 'true';
  button.textContent = 'Click again to reset';
  resetArmedTimer = setTimeout(() => {
    button.dataset.armed = 'false';
    button.textContent = '⟲ Reset demo';
  }, 3000);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const goto = target.closest('[data-goto]');
  if (goto) send('goto', { index: Number(goto.dataset.goto) });
  const action = target.closest('[data-action]')?.dataset.action;
  if (action) send(action);
  if (target.closest('#celebration')) $('#celebration').hidden = true;
});

$('#reset-btn').addEventListener('click', (event) => armOrReset(event.currentTarget));
$('#setup-retry').addEventListener('click', () => send('reset'));
$('#fullscreen-btn').addEventListener('click', toggleFullscreen);

// Presenter remotes send PageUp/PageDown; ignore keys while a remote browser has focus.
document.addEventListener('keydown', (event) => {
  if (event.target instanceof Element && event.target.closest('.screen')) return;
  if (['PageDown', 'ArrowRight'].includes(event.key)) send('next');
  else if (['PageUp', 'ArrowLeft'].includes(event.key)) send('prev');
  else if (event.key === 'f' || event.key === 'F') toggleFullscreen();
  else return;
  event.preventDefault();
});

connectState();
ROLES.forEach(connectScreen);
