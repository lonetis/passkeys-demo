import { EventEmitter } from 'node:events';
import { createLogger } from './log.js';
import { prepareBrowsers, SETUP_STAGES, PROFILE_BY_ROLE } from './setup.js';
import { steps, sleep } from './scenario.js';

const TICK_INTERVAL_MS = 500;
const AUTOPILOT_PAUSE_MS = 900;
const AUTOPILOT_TASK_TIMEOUT_MS = 25_000;
const ROLES = ['victim', 'attacker'];
const OWNER_BY_PROFILE = Object.freeze(Object.fromEntries(Object.entries(PROFILE_BY_ROLE).map(([role, profile]) => [profile, role])));

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function emptyFacts() {
  return {
    names: { victim: null, attacker: null },
    /** Last "Send" click in each browser's interceptor: { op, credentialId, key, userHandle }. */
    lastSend: { victim: null, attacker: null },
    victimPasskey: null,
    overwrite: null,
    takeover: null,
    lockout: null,
    /** Model of the website's passkey table, keyed by credential ID (base64url). */
    passkeys: new Map(),
    lastLogin: null,
  };
}

/** Owner of a PASSKEYS-ATTACKER key name such as "profile2 | ES256". */
function keyOwner(keyName) {
  return OWNER_BY_PROFILE[String(keyName ?? '').split(' | ')[0]] ?? null;
}

/**
 * Orchestrates the demo: prepares the browsers, follows what happens in them, evaluates the
 * guide, draws highlights, and publishes one state object to all connected UIs.
 */
export class DemoController extends EventEmitter {
  constructor(browsers, config) {
    super();
    this.browsers = browsers;
    this.config = config;
    this.log = createLogger('demo');
    this.phase = 'preparing';
    this.setup = { stages: SETUP_STAGES.map((stage) => ({ ...stage, status: 'pending' })), error: null };
    this.stepIndex = 0;
    this.facts = emptyFacts();
    this.live = { victim: null, attacker: null };
    this.notice = null;
    this.celebration = null;
    this.autopilotRunning = false;
    this.ticking = false;
    this.lastPublished = '';
    this.generation = 0;

    for (const role of ROLES) {
      const browser = browsers[role];
      browser.on('interceptor-send', (payload) => {
        this.facts.lastSend[role] = payload;
      });
      browser.on('passkey-result', (result) => this.onPasskeyResult(role, result));
      browser.on('disconnected', () => {
        if (this.phase !== 'ready') return;
        this.setNotice('error', `The ${role} browser lost its connection. Press “Reset demo” to start over.`);
      });
    }
  }

  start() {
    setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.reset();
  }

  // ─── Setup / reset ──────────────────────────────────────────────────────

  async reset() {
    if (this.phase === 'preparing' && this.generation > 0) return;
    const generation = ++this.generation;
    this.phase = 'preparing';
    this.stepIndex = 0;
    this.facts = emptyFacts();
    this.live = { victim: null, attacker: null };
    this.notice = null;
    this.celebration = null;
    this.setup = { stages: SETUP_STAGES.map((stage) => ({ ...stage, status: 'pending' })), error: null };
    this.publish();

    const onStage = (id) => {
      for (const stage of this.setup.stages) {
        if (stage.status === 'running') stage.status = 'done';
        if (stage.id === id) stage.status = 'running';
      }
      this.log.info(`setup: ${id}`);
      this.publish();
    };

    try {
      const { instanceId } = await prepareBrowsers(this.browsers, this.config, onStage);
      if (generation !== this.generation) return;
      this.setup.stages.forEach((stage) => { stage.status = 'done'; });
      this.phase = 'ready';
      this.log.info(`ready (CTF instance ${instanceId})`);
    } catch (error) {
      if (generation !== this.generation) return;
      this.log.error('setup failed:', error);
      this.setup.stages.forEach((stage) => { if (stage.status === 'running') stage.status = 'failed'; });
      this.setup.error = error.message;
      this.phase = 'failed';
    }
    this.publish();
  }

  // ─── Facts from browser events ──────────────────────────────────────────

  onPasskeyResult(role, result) {
    if (this.phase !== 'ready') return;
    const facts = this.facts;
    const send = facts.lastSend[role];
    const account = facts.names[role];

    if (result.op === 'create') {
      if (!result.ok) {
        this.setNotice('warning', `Registration failed: ${result.body?.error ?? `HTTP ${result.status}`}`);
        return;
      }
      const existing = facts.passkeys.get(result.credentialId);
      const reward = result.body?.reward ?? null;
      if (existing && reward) {
        existing.keyName = send?.key ?? null;
        existing.overwritten = true;
      } else {
        facts.passkeys.set(result.credentialId, {
          credentialId: result.credentialId,
          credentialName: send?.credentialId ?? null,
          account: account ?? role,
          keyName: send?.key ?? null,
          overwritten: false,
        });
      }

      if (role === 'victim' && !facts.victimPasskey) {
        facts.victimPasskey = { credentialId: result.credentialId, keyName: send?.key ?? null };
        this.clearNotice();
      } else if (role === 'attacker' && reward && !facts.overwrite) {
        facts.overwrite = { reward, keyName: send?.key ?? null };
        this.celebrate({ kind: 'flag', country: reward.country, imageUrl: reward.imageUrl, title: reward.title });
        this.clearNotice();
      } else if (role === 'attacker' && !reward && this.currentStep().id === 'overwrite') {
        this.setNotice('warning', 'That created a brand-new passkey for the attacker — its credential ID was not the victim’s. Try again: <b>+ Add Passkey</b>, then pick <code>profile1 | ES256</code> as Credential ID.');
      }
      this.publish();
      return;
    }

    const loggedInAs = result.body?.user?.username ?? null;
    facts.lastLogin = {
      role,
      ok: result.ok,
      user: loggedInAs,
      error: result.ok ? null : (result.body?.error ?? `HTTP ${result.status}`),
      credentialName: send?.credentialId ?? null,
      keyName: send?.key ?? null,
    };
    if (role === 'attacker' && result.ok && loggedInAs && loggedInAs === facts.names.victim && !facts.takeover) {
      facts.takeover = { user: loggedInAs };
      this.celebrate({ kind: 'takeover', user: loggedInAs });
      this.clearNotice();
    } else if (role === 'victim' && !result.ok && facts.overwrite && !facts.lockout) {
      facts.lockout = { error: facts.lastLogin.error };
      this.celebrate({ kind: 'lockout', user: facts.names.victim });
      this.clearNotice();
    } else if (!result.ok) {
      this.setNotice('warning', `Login failed: ${escapeHtml(facts.lastLogin.error)}. Check the selections in the interceptor and try again.`);
    }
    this.publish();
  }

  celebrate(details) {
    this.celebration = { ...details, at: Date.now() };
  }

  setNotice(level, html) {
    this.notice = { level, html, at: Date.now() };
    this.publish();
  }

  clearNotice() {
    this.notice = null;
  }

  // ─── Guide evaluation ───────────────────────────────────────────────────

  currentStep() {
    return steps[this.stepIndex];
  }

  guideState() {
    return { victim: this.live.victim, attacker: this.live.attacker, facts: this.facts };
  }

  /** Evaluates a step's tasks; the first unfinished task is the current one. */
  evaluateStep(step, state) {
    let currentFound = false;
    return step.tasks.map((task) => {
      let done = false;
      try {
        done = Boolean(task.done(state));
      } catch {
        done = false;
      }
      const current = !done && !currentFound;
      if (current) currentFound = true;
      return { task, done, current };
    });
  }

  async tick() {
    if (this.ticking || this.phase !== 'ready') return;
    this.ticking = true;
    try {
      const [victim, attacker] = await Promise.all(ROLES.map((role) => this.browsers[role].snapshot().catch(() => null)));
      this.live = { victim, attacker };
      for (const role of ROLES) {
        const user = this.live[role]?.learning?.user;
        if (user && !this.facts.names[role]) this.facts.names[role] = user;
      }
      await this.applyHighlights();
      this.publish();
    } finally {
      this.ticking = false;
    }
  }

  async applyHighlights() {
    const step = this.currentStep();
    const state = this.guideState();
    const current = this.evaluateStep(step, state).find((entry) => entry.current);
    const role = current ? step.focus : null;
    let spec = null;
    if (current?.task.highlight) {
      try {
        spec = current.task.highlight(state);
      } catch {
        spec = null;
      }
    }
    await Promise.all(ROLES.map((r) => this.browsers[r].highlight(r === role ? spec : null)));
  }

  // ─── Actions from the UI ────────────────────────────────────────────────

  goTo(index) {
    if (this.phase !== 'ready') return;
    this.stepIndex = Math.max(0, Math.min(steps.length - 1, index));
    this.notice = null;
    this.publish();
  }

  async autopilot() {
    if (this.phase !== 'ready' || this.autopilotRunning) return;
    const step = this.currentStep();
    if (!step.focus || step.tasks.length === 0) return;
    const browser = this.browsers[step.focus];
    const generation = this.generation;
    this.autopilotRunning = true;
    this.publish();
    try {
      for (const task of step.tasks) {
        if (generation !== this.generation || this.currentStep() !== step) return;
        if (task.done(this.guideState())) continue;
        await sleep(AUTOPILOT_PAUSE_MS);
        await task.run({ browser, state: () => this.guideState() });
        await this.waitUntil(() => task.done(this.guideState()), AUTOPILOT_TASK_TIMEOUT_MS);
      }
    } catch (error) {
      this.log.warn('autopilot stopped:', error.message);
      this.setNotice('warning', `“Do it for me” stopped: ${escapeHtml(error.message.split('\n')[0])}`);
    } finally {
      this.autopilotRunning = false;
      this.publish();
    }
  }

  async waitUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(TICK_INTERVAL_MS);
      if (predicate()) return;
    }
    throw new Error('the browser did not reach the expected state in time');
  }

  handleAction(message) {
    switch (message?.action) {
      case 'goto':
        this.goTo(Number(message.index));
        break;
      case 'next':
        this.goTo(this.stepIndex + 1);
        break;
      case 'prev':
        this.goTo(this.stepIndex - 1);
        break;
      case 'autopilot':
        this.autopilot();
        break;
      case 'reset':
        this.reset();
        break;
      default:
        break;
    }
  }

  // ─── Published state ────────────────────────────────────────────────────

  render(html) {
    const names = this.facts.names;
    return html
      .replaceAll('{victim}', escapeHtml(names.victim ?? 'victim'))
      .replaceAll('{attacker}', escapeHtml(names.attacker ?? 'attacker'))
      .replaceAll('{flag}', escapeHtml(this.facts.overwrite?.reward?.country ?? ''));
  }

  publicState() {
    const state = this.guideState();
    const stepViews = steps.map((step, index) => {
      const evaluated = index === this.stepIndex ? this.evaluateStep(step, state) : step.tasks.map((task) => ({ task, done: false, current: false }));
      let complete = false;
      try {
        complete = this.phase === 'ready' && step.complete(state);
      } catch {
        complete = false;
      }
      return {
        id: step.id,
        short: step.short,
        marker: step.marker,
        focus: step.focus,
        bonus: Boolean(step.bonus),
        kicker: step.kicker,
        title: this.render(step.title),
        lead: step.lead ? this.render(step.lead) : null,
        points: (step.points ?? []).map((point) => this.render(point)),
        why: step.why ? { title: step.why.title, body: this.render(step.why.body) } : null,
        callout: step.callout ? this.render(step.callout) : null,
        doneMessage: step.doneMessage ? this.render(step.doneMessage) : null,
        complete,
        tasks: evaluated.map(({ task, done, current }) => ({ id: task.id, html: this.render(task.text), done, current })),
      };
    });

    const passkeys = [...this.facts.passkeys.values()].map((row) => ({
      credentialId: row.credentialId,
      credentialName: row.credentialName,
      account: row.account,
      keyName: row.keyName,
      keyOwner: keyOwner(row.keyName),
      overwritten: row.overwritten,
    }));
    const lastLogin = this.facts.lastLogin ? { ...this.facts.lastLogin, keyOwner: keyOwner(this.facts.lastLogin.keyName) } : null;

    return {
      phase: this.phase,
      setup: this.setup,
      stepIndex: this.stepIndex,
      steps: stepViews,
      names: this.facts.names,
      passkeys,
      lastLogin,
      notice: this.notice,
      celebration: this.celebration,
      autopilotRunning: this.autopilotRunning,
      browsers: Object.fromEntries(ROLES.map((role) => [role, {
        connected: this.live[role]?.connected ?? this.browsers[role].connected,
        user: this.live[role]?.learning?.user ?? null,
      }])),
    };
  }

  publish() {
    const state = this.publicState();
    const serialized = JSON.stringify(state);
    if (serialized === this.lastPublished) return;
    this.lastPublished = serialized;
    this.emit('state', serialized);
  }

  latestState() {
    return this.lastPublished || JSON.stringify(this.publicState());
  }
}
