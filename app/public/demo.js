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
  $('#stage').dataset.focus = ready && step.acting ? step.acting : 'none';

  renderOnce('versions', [state.demo, state.demos], renderVersions);
  renderOnce('stepper', [state.phase, state.stepIndex, state.steps.map((s) => [s.short, s.marker, s.focus, s.complete])], renderStepper);
  renderOnce('status', [state.phase, state.browsers], renderBrowserStatus);
  renderOnce('setup', [state.phase, state.setup], renderSetup);
  renderOnce('step', [state.phase, state.stepIndex, step, state.notice, state.autopilotRunning], () => renderStep(step));
  renderOnce('diagram', [state.diagram, state.stepIndex, state.steps.map((s) => [s.id, s.marker, s.complete, s.tasks.length])], renderDiagram);
  renderOnce('db', [state.demo.loginCheck, state.passkeys, state.sessions, state.lastLogin], renderDatabase);
  renderCelebration();
}

function renderVersions() {
  document.title = `${state.demo.title} · State of Passkeys – Live Demos`;
  $('#headline').innerHTML = state.demo.headline;
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
  card.dataset.focus = step.acting ?? step.focus ?? 'none';

  const points = step.points.length ? `<ul class="step-points">${step.points.map((p) => `<li>${p}</li>`).join('')}</ul>` : '';
  const tasks = hasTasks ? `<ol class="tasks">${step.tasks.map((task) => `
      <li class="task${task.done ? ' done' : ''}${task.current ? ' current' : ''}"><span class="task-text">${task.html}</span></li>`).join('')}</ol>` : '';
  const done = step.complete && step.doneMessage ? `<div class="alert alert-ok">${step.doneMessage}</div>` : '';
  const notice = state.notice ? `<div class="alert alert-${esc(state.notice.level)}">${state.notice.html}</div>` : '';
  const explainer = step.why
    ? `<div class="explainer"><b class="explainer-title"><span aria-hidden="true">💡</span> ${esc(step.why.title)}:</b> ${step.why.body}</div>`
    : '<span class="spacer"></span>';

  const autopilotButton = hasTasks && !step.complete
    ? `<button class="btn btn-outline btn-small" type="button" data-action="autopilot" ${ready && !state.autopilotRunning ? '' : 'disabled'}>
        ${state.autopilotRunning ? '<span class="spinner"></span> Running…' : '▶ Do it for me'}</button>`
    : '';
  const nextLabel = isFirst ? 'Start the demo →' : step.bonus ? (step.complete ? 'Takeaways →' : 'Skip to takeaways →') : 'Next →';
  const nextButton = isLast
    ? `<button class="btn btn-primary" type="button" data-action="reset" ${state.phase === 'preparing' ? 'disabled' : ''}>⟲ Run it again</button>`
    : `<button class="btn btn-primary${ready && (isFirst || step.complete) ? ' pulse' : ''}" type="button" data-action="next" ${ready ? '' : 'disabled'}>${nextLabel}</button>`;
  const backButton = isFirst ? '' : `<button class="btn btn-ghost" type="button" data-action="prev" ${ready ? '' : 'disabled'}>←</button>`;

  card.innerHTML = `
    <div class="step-head">
      <div class="kicker">${esc(step.kicker)}</div>
      ${autopilotButton}
    </div>
    <div class="step-scroll">
      <h2 class="step-title">${step.title}</h2>
      ${step.lead && !(hasTasks && step.complete) ? `<p class="step-lead">${step.lead}</p>` : ''}
      ${points}
      ${tasks}
      ${done}
      ${notice}
    </div>
    <div class="step-actions">
      ${backButton}
      ${explainer}
      ${nextButton}
    </div>`;
  const scroller = card.querySelector('.step-scroll');
  const highlight = scroller.querySelector('.alert:last-child') ?? scroller.querySelector('.task.current');
  if (highlight) highlight.scrollIntoView({ block: 'nearest' });
  else scroller.scrollTop = 0;
}

const DIAGRAM = Object.freeze({
  width: 560,
  lanes: { victim: 100, website: 290, attacker: 480 },
  laneTitles: { victim: '😇 Victim', website: '🌐 Website', attacker: '😈 Attacker' },
  /** y of the first message row, distance between rows, x of the step markers. */
  top: 62,
  row: 29,
  markerX: 16,
  /** Rough label width per character, to keep labels and notes inside the diagram. */
  charWidth: 6.7,
});

/**
 * How a diagram row looks on the current step: the whole diagram on the intro and the
 * takeaways; otherwise past rows, the current step's rows (outcomes only once they
 * happened), and dimmed upcoming rows.
 */
function rowStatus(message, stepOrder, overview) {
  if (overview) return 'all';
  const index = stepOrder.get(message.step);
  if (index > state.stepIndex) return 'future';
  if (message.reached === false) return index === state.stepIndex ? 'waiting' : 'future';
  return index === state.stepIndex ? 'active' : 'past';
}

/** Centers a box of the given width near x without leaving the diagram (or covering the step markers). */
function clampCenter(x, boxWidth) {
  const min = DIAGRAM.markerX + 16 + boxWidth / 2;
  const max = DIAGRAM.width - 4 - boxWidth / 2;
  return Math.max(min, Math.min(max, x));
}

/** Sequence diagram of the whole attack (victim · website · attacker), current step highlighted. */
function renderDiagram() {
  const { width, lanes, laneTitles, top, row, markerX, charWidth } = DIAGRAM;
  const messages = state.diagram;
  const card = $('#diagram-card');
  if (!messages.length) {
    card.innerHTML = '';
    return;
  }
  const height = top + (messages.length - 1) * row + 14;
  const stepOrder = new Map(state.steps.map((step, index) => [step.id, index]));
  const overview = state.steps[state.stepIndex].tasks.length === 0;

  const groups = [];
  messages.forEach((message, index) => {
    const last = groups.at(-1);
    if (last?.step === message.step) last.end = index;
    else groups.push({ step: message.step, start: index, end: index });
  });
  const steps = groups.map((group) => {
    const index = stepOrder.get(group.step);
    const step = state.steps[index];
    const current = !overview && index === state.stepIndex;
    const y1 = top + group.start * row - 22;
    const y2 = top + group.end * row + 9;
    const cy = (y1 + y2) / 2;
    const done = step.complete && index < state.stepIndex;
    return `
      ${current ? `<rect class="dg-band" x="2" y="${y1}" width="${width - 4}" height="${y2 - y1}" rx="9"/>` : ''}
      <g class="dg-marker${current ? ' is-current' : ''}${done ? ' is-done' : ''}">
        <circle cx="${markerX}" cy="${cy}" r="10"/>
        <text x="${markerX}" y="${cy + 4}" text-anchor="middle">${done ? '✓' : esc(step.marker)}</text>
      </g>`;
  }).join('');

  const tones = ['victim', 'website', 'attacker', 'bad', 'leak'];
  const markers = tones.map((tone) => `
    <marker id="dg-arrow-${tone}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="dg-fill-${tone}"/>
    </marker>`).join('');
  const heads = Object.entries(lanes).map(([lane, x]) => `
    <rect x="${x - 58}" y="4" width="116" height="26" rx="13" class="dg-head dg-head-${lane}"/>
    <text x="${x}" y="21.5" text-anchor="middle" class="dg-head-text">${esc(laneTitles[lane])}</text>
    <line x1="${x}" y1="34" x2="${x}" y2="${height}" class="dg-lifeline"/>`).join('');

  const rows = messages.map((message, index) => {
    const y = top + index * row;
    const tone = message.kind ?? message.from;
    const status = rowStatus(message, stepOrder, overview);
    const labelWidth = message.text.length * charWidth;
    if (message.from === message.to) {
      const boxWidth = labelWidth + 22;
      const x = clampCenter(lanes[message.from], boxWidth);
      return `<g class="dg-row is-${status}">
        <rect x="${x - boxWidth / 2}" y="${y - 16}" width="${boxWidth}" height="22" rx="6" class="dg-note dg-note-${tone}"/>
        <text x="${x}" y="${y - 1}" text-anchor="middle" class="dg-label dg-fill-${tone}">${esc(message.text)}</text></g>`;
    }
    const x1 = lanes[message.from];
    const x2 = lanes[message.to];
    const end = x2 + (x2 > x1 ? -4 : 4);
    return `<g class="dg-row is-${status}">
      <line x1="${x1}" y1="${y}" x2="${end}" y2="${y}" class="dg-arrow dg-stroke-${tone}" marker-end="url(#dg-arrow-${tone})"/>
      <text x="${clampCenter((x1 + x2) / 2, labelWidth)}" y="${y - 6}" text-anchor="middle" class="dg-label dg-fill-${tone}">${esc(message.text)}</text></g>`;
  }).join('');

  card.innerHTML = `<svg class="diagram" viewBox="0 0 ${width} ${height}" role="img" aria-label="The attack at a glance">
    <defs>${markers}</defs>${steps}${heads}${rows}</svg>`;
}

const PARTY = Object.freeze({
  victim: { icon: '😇', name: 'victim’s' },
  attacker: { icon: '😈', name: 'attacker’s' },
});

/** "😇 victim’s key" chip in the party's color. */
function partyChip(owner, thing, extraClass = '') {
  const party = PARTY[owner];
  const label = party ? `${party.icon} ${party.name}<span class="chip-thing"> ${thing}</span>` : `unknown ${thing}`;
  return `<span class="party-chip ${party ? owner : ''} ${extraClass}">${label}</span>`;
}

/** Start of a challenge, enough to recognize it again. */
const shortChallenge = (challenge) => `${challenge.slice(0, 6)}…`;

function renderDatabase() {
  const challengeCheck = state.demo.loginCheck === 'challenge';
  $('#passkey-table').hidden = challengeCheck;
  $('#passkey-summary').hidden = !challengeCheck;
  $('#sessions').hidden = !challengeCheck;
  if (challengeCheck) {
    renderPasskeySummary();
    renderSessions();
    renderChallengeCheck();
  } else if (state.demo.loginCheck === 'uv') {
    renderPasskeys();
    renderUserVerificationCheck();
  } else {
    renderPasskeys();
    renderSignatureCheck();
  }
}

/** One line instead of the table, when the passkeys are only the backdrop (challenge test). */
function renderPasskeySummary() {
  const chips = ROLES.flatMap((role) => state.passkeys.filter((row) => row.accountRole === role))
    .map((row) => partyChip(row.accountRole, 'passkey')).join(' ');
  $('#passkey-summary').innerHTML = `<span class="summary-label">🔑 Passkeys</span> ${chips || '<span class="unused">none yet</span>'}`;
}

function renderPasskeys() {
  $('#db-rows').innerHTML = state.passkeys.map((row) => `
    <tr class="${row.overwritten ? 'overwritten' : ''}">
      <td><span class="account-name">${PARTY[row.accountRole]?.icon ?? ''} ${esc(row.account)}</span></td>
      <td>${partyChip(row.idOwner, 'ID')}</td>
      <td><span class="key-cell">${row.overwritten
        ? `${partyChip(row.previousKeyOwner, 'key', 'replaced')}<span class="replacement"><span class="replaced-arrow" aria-label="replaced by">→</span>${partyChip(row.keyOwner, 'key')}</span>`
        : partyChip(row.keyOwner, 'key')}</span></td>
    </tr>`).join('') || '<tr class="db-empty"><td colspan="3">No passkeys registered yet.</td></tr>';
}

function renderSignatureCheck() {
  $('#login-check-title').innerHTML = '<span aria-hidden="true">🔏</span> Login: signature check';
  const login = state.lastLogin;
  if (!login) {
    $('#login-check').innerHTML = '<p class="login-empty">At login, the website checks the browser’s signature with the stored public key.</p>';
    return;
  }
  const match = Boolean(login.signedWith) && login.signedWith === login.storedKey;
  let result = `<span class="sig-result fail">✗ Login failed: ${esc(login.error)}</span>`;
  if (login.ok) result = `<span class="sig-result ok">✓ Signature valid → logged in as <b>${esc(login.user)}</b></span>`;
  else if (!match) result = '<span class="sig-result fail">✗ Signature invalid → login failed</span>';
  $('#login-check').innerHTML = `
    <div class="sig-flow">
      <div class="sig-col"><span class="sig-caption">Browser signed with</span>${partyChip(login.signedWith, 'key')}</div>
      <span class="sig-op ${match ? 'ok' : 'fail'}" title="${match ? 'matches' : 'does not match'}">${match ? '=' : '≠'}</span>
      <div class="sig-col"><span class="sig-caption">Website checks with</span>${partyChip(login.storedKey, 'key')}</div>
    </div>
    ${result}`;
}

/** The website's view of the login sessions: which challenge it issued to whom, and who used it. */
function renderSessions() {
  const rows = ROLES.filter((role) => state.sessions[role]).map((role) => {
    const { challenge, usedBy } = state.sessions[role];
    const used = usedBy
      ? `<span class="used-by${usedBy === role ? '' : ' foreign'}">${PARTY[usedBy].icon} ${usedBy === role ? 'own login' : `${PARTY[usedBy].name}<span class="chip-thing"> login</span>`}</span>`
      : '<span class="unused">— unused</span>';
    return `<tr>
      <td>${partyChip(role, 'session')}</td>
      <td><code class="challenge" title="${esc(challenge)}">${esc(shortChallenge(challenge))}</code></td>
      <td>${used}</td>
    </tr>`;
  });
  $('#session-rows').innerHTML = rows.join('') || '<tr class="db-empty"><td colspan="3">No passkey login started yet.</td></tr>';
}

function renderChallengeCheck() {
  $('#login-check-title').innerHTML = '<span aria-hidden="true">🎲</span> Login: challenge check';
  const login = state.lastLogin;
  if (!login) {
    $('#login-check').innerHTML = '<p class="login-empty">At login, the website should only accept the challenge it issued to this session.</p>';
    return;
  }
  const match = login.challengeSession === login.role;
  let result = `<span class="sig-result fail">✗ Login failed: ${esc(login.error)}</span>`;
  if (login.ok && match) result = `<span class="sig-result ok">✓ Own challenge → logged in as <b>${esc(login.user)}</b></span>`;
  else if (login.ok) result = `<span class="sig-result bad">⚠ Accepted anyway → logged in as <b>${esc(login.user)}</b></span>`;
  else if (!match) result = '<span class="sig-result ok">✓ Rejected: challenge of another session</span>';
  $('#login-check').innerHTML = `
    <div class="sig-flow">
      <div class="sig-col"><span class="sig-caption">Browser signed</span>${partyChip(login.challengeSession, 'challenge')}</div>
      <span class="sig-op ${match ? 'ok' : 'fail'}" title="${match ? 'matches' : 'does not match'}">${match ? '=' : '≠'}</span>
      <div class="sig-col"><span class="sig-caption">Session expects</span>${partyChip(login.role, 'challenge')}</div>
    </div>
    ${result}`;
}

/** Required user verification against the UV flag the login response reports. */
function renderUserVerificationCheck() {
  $('#login-check-title').innerHTML = '<span aria-hidden="true">🔐</span> Login: user verification check';
  const login = state.lastLogin;
  if (!login) {
    $('#login-check').innerHTML = '<p class="login-empty">At login, the website requires user verification: the response’s UV flag must say the PIN or fingerprint was checked.</p>';
    return;
  }
  const required = login.uvRequired !== false;
  const verified = login.userVerified === true;
  const match = verified || !required;
  let result = `<span class="sig-result fail">✗ Login failed: ${esc(login.error)}</span>`;
  if (login.ok && match) result = `<span class="sig-result ok">✓ User verified → logged in as <b>${esc(login.user)}</b></span>`;
  else if (login.ok) result = `<span class="sig-result bad">⚠ Accepted anyway → logged in as <b>${esc(login.user)}</b></span>`;
  else if (!match) result = '<span class="sig-result ok">✓ Rejected: user not verified</span>';
  const flag = verified
    ? '<span class="party-chip ok">UV = true<span class="chip-thing">(PIN checked)</span></span>'
    : '<span class="party-chip fail">UV = false<span class="chip-thing">(no PIN)</span></span>';
  $('#login-check').innerHTML = `
    <div class="sig-flow">
      <div class="sig-col"><span class="sig-caption">Website requires</span><span class="party-chip">${required ? '🔐 user verification' : 'no user verification'}</span></div>
      <span class="sig-op ${match ? 'ok' : 'fail'}" title="${match ? 'matches' : 'does not match'}">${match ? '=' : '≠'}</span>
      <div class="sig-col"><span class="sig-caption">Response reports</span>${flag}</div>
    </div>
    ${result}`;
}

function celebrationMarkup(celebration) {
  const victim = esc(state.names.victim ?? 'victim');
  switch (celebration.kind) {
    case 'flag':
      return `<div class="celebration-card ${celebration.role === 'victim' ? 'victim' : 'attacker'}">
        <div class="celebration-title">🚩 Flag captured!</div>
        ${celebration.imageUrl ? `<img class="celebration-flag" src="${esc(celebration.imageUrl)}" alt="${esc(celebration.title)}">` : ''}
        <div class="celebration-text"><b>${esc(celebration.country)}</b> — the CTF detected the exploit: ${esc(celebration.detail ?? '')}</div>
        <div class="celebration-hint">click to close</div></div>`;
    case 'takeover':
      return `<div class="celebration-card attacker">
        <div class="celebration-emoji">😈</div>
        <div class="celebration-title">Account takeover!</div>
        <div class="celebration-text">The attacker is logged in as <b>${victim}</b> — with the attacker’s key.</div>
        <div class="celebration-hint">click to close</div></div>`;
    case 'lockout':
      return `<div class="celebration-card victim">
        <div class="celebration-emoji">🔒</div>
        <div class="celebration-title">Victim locked out</div>
        <div class="celebration-text"><b>${victim}</b> can no longer log in with the victim’s passkey.</div>
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
  // Over the browser where it happened: the victim's browser is on the left, the attacker's on the right.
  overlay.dataset.side = celebration.role === 'victim' ? 'left' : 'right';
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
