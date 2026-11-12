import { randomUUID } from 'node:crypto';
import { generateSecret, listKeyNames } from '../passkeys-tools-store.js';
import {
  PROFILE_BY_ROLE, restartBrowsers, configureExtension, connectRemoteKeyStore, openCtfInstance,
} from '../setup.js';
import {
  VICTIM_KEY, ATTACKER_KEY, usernameOf,
  signUpTasks, openSettingsTask, addPasskeyTasks, selectTask, sendTask, logoutTask, passkeyLoginTask,
  victimHasPasskey, keyOverwritten, attackerIsVictim, victimLockedOut,
} from './common.js';

/**
 * The full story: both people start from scratch. The victim signs up and registers a
 * passkey; the attacker signs up and registers a passkey with the victim's credential ID,
 * which the CTF's "Cred Overwrite" verifier turns into an overwrite of the victim's key.
 * Both browsers share one passkeys.tools key store, so the victim's credential ID is listed
 * in the attacker's interceptor as "victim | ES256".
 */

const SETUP_STAGES = [
  { id: 'browsers', label: 'Restart both browsers with fresh, empty profiles' },
  { id: 'extension', label: 'Install PASSKEYS-ATTACKER in both browsers, with keys labeled “victim” and “attacker”' },
  { id: 'storage', label: 'Connect both to one shared, end-to-end encrypted passkeys.tools key store' },
  { id: 'ctf', label: 'Open a fresh CTF instance shared by both browsers, with the vulnerable registration' },
];

async function prepare({ browsers: { victim, attacker }, config, onStage }) {
  const secret = generateSecret();
  const instanceId = randomUUID();

  onStage('browsers');
  await restartBrowsers([victim, attacker]);

  onStage('extension');
  await Promise.all([configureExtension(victim, config), configureExtension(attacker, config)]);

  onStage('storage');
  // Sequential on purpose: the victim's browser generates the profile keys first.
  await connectRemoteKeyStore(victim, config, secret);
  await connectRemoteKeyStore(attacker, config, secret);
  const keyNames = await listKeyNames(config.passkeysToolsDbUrl, secret);
  for (const required of Object.values(PROFILE_BY_ROLE).map((profile) => `${profile} | ES256`)) {
    if (!keyNames.includes(required)) throw new Error(`passkeys.tools key store is missing "${required}"`);
  }

  onStage('ctf');
  const verifiers = {
    registrationVerifier: config.verifiers.registration,
    authenticationVerifier: config.verifiers.discoverableLogin,
  };
  await Promise.all([
    openCtfInstance(victim, config, instanceId, verifiers),
    openCtfInstance(attacker, config, instanceId, verifiers),
  ]);
  return { instanceId };
}

const steps = [
  {
    id: 'intro',
    short: 'Intro',
    marker: 'i',
    focus: null,
    kicker: 'Demo · Account takeover',
    title: 'Credential Overwrite → Account Takeover',
    lead: 'The attacker takes over the victim’s account by replacing the victim’s passkey key on the website.',
    points: [
      '<span class="tag victim">Left</span> victim, <span class="tag attacker">right</span> attacker: real browsers with PASSKEYS-ATTACKER as authenticator, sharing one key store.',
      'Target: our vulnerable CTF website (bug: WebAuthn §7.1.26).',
    ],
    why: { title: 'How to follow', body: 'The diagram shows the whole attack; the current step lights up.' },
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
    lead: 'A normal sign-up.',
    why: { title: 'Nothing unusual', body: 'An ordinary account. Next, the victim adds a passkey.' },
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
    lead: 'PASSKEYS-ATTACKER acts as the victim’s authenticator.',
    why: { title: 'What the website stores', body: 'Account, credential ID and <b>public key</b> — see the database on the right.' },
    tasks: [
      openSettingsTask('victim', victimHasPasskey),
      ...addPasskeyTasks('victim', victimHasPasskey),
      selectTask('victim', 'create', 'credentialId', VICTIM_KEY, `Keep <b>Credential ID</b> <code>${VICTIM_KEY}</code>`, victimHasPasskey),
      selectTask('victim', 'create', 'key', VICTIM_KEY, `Keep <b>Key</b> <code>${VICTIM_KEY}</code>`, victimHasPasskey),
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
    lead: 'An ordinary account is all the attacker needs.',
    why: { title: 'No access to the victim', body: 'Nothing from the victim’s device or password is needed.' },
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
    title: 'Register the victim’s credential ID',
    lead: 'Attacker’s account, but the <span class="victim-text">victim’s</span> credential ID (from the shared key store) and the <span class="attacker-text">attacker’s</span> key.',
    why: {
      title: 'The bug',
      body: 'The website should reject a known credential ID (WebAuthn §7.1.26), but it <b>replaces the victim’s public key</b> with the attacker’s.',
    },
    tasks: [
      openSettingsTask('attacker', keyOverwritten),
      ...addPasskeyTasks('attacker', keyOverwritten),
      selectTask('attacker', 'create', 'credentialId', VICTIM_KEY, `<b>Credential ID</b>: <code>${VICTIM_KEY}</code> — the <span class="victim-text">victim’s</span>!`, keyOverwritten),
      selectTask('attacker', 'create', 'key', ATTACKER_KEY, `<b>Key</b>: keep <code>${ATTACKER_KEY}</code>`, keyOverwritten),
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
    lead: 'Victim’s credential ID, signed with the attacker’s key.',
    why: {
      title: 'Why it works',
      body: 'The website checks the signature with the stored key — now the attacker’s — so the attacker is in <b>as the victim</b>.',
    },
    tasks: [
      logoutTask('attacker', 'Close the pop-up, then <b>{attacker}</b> → <b>Logout</b>', attackerIsVictim),
      passkeyLoginTask('attacker', attackerIsVictim),
      selectTask('attacker', 'get', 'userHandle', (s) => usernameOf(s, 'victim'), '<b>User Handle</b>: <code>{victim}</code>', attackerIsVictim),
      selectTask('attacker', 'get', 'credentialId', VICTIM_KEY, `<b>Credential ID</b>: <code>${VICTIM_KEY}</code>`, attackerIsVictim),
      selectTask('attacker', 'get', 'key', ATTACKER_KEY, `<b>Key</b>: <code>${ATTACKER_KEY}</code>`, attackerIsVictim),
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
    title: 'The victim is locked out',
    lead: 'The victim tries their genuine passkey.',
    why: { title: 'Locked out', body: 'The stored key is now the attacker’s, so the victim’s signature fails.' },
    tasks: [
      logoutTask('victim', 'Log out: <b>{victim}</b> → <b>Logout</b>', victimLockedOut),
      passkeyLoginTask('victim', victimLockedOut),
      selectTask('victim', 'get', 'userHandle', (s) => usernameOf(s, 'victim'), '<b>User Handle</b>: <code>{victim}</code>', victimLockedOut),
      selectTask('victim', 'get', 'credentialId', VICTIM_KEY, `<b>Credential ID</b>: <code>${VICTIM_KEY}</code>`, victimLockedOut),
      selectTask('victim', 'get', 'key', VICTIM_KEY, `<b>Key</b>: <code>${VICTIM_KEY}</code> (genuine)`, victimLockedOut),
      sendTask('victim', 'get', victimLockedOut),
    ],
    complete: victimLockedOut,
    doneMessage: '🔒 “{victim}” is locked out',
  },
  {
    id: 'summary',
    short: 'Takeaways',
    marker: '★',
    focus: null,
    kicker: 'Takeaways',
    title: 'One missing check, full takeover',
    points: [
      '<b>Bug:</b> a registered credential ID was accepted again — and its key replaced.',
      '<b>Fix:</b> reject known credential IDs, for any user (WebAuthn §7.1.26).',
      '<b>In the wild:</b> 12 of 103 sites accepted it; on 5, keys were overwritten (CVSS 9.1).',
    ],
    why: {
      title: 'Try it yourself',
      body: '<b>passkeys.tools</b> — PASSKEYS-ATTACKER<br><b>learning.passkeys.tools</b> — the CTF<br><b>Paper:</b> The State of Passkeys, USENIX Security ’26',
    },
    tasks: [],
    complete: () => true,
  },
];

/** The attack at a glance: one row per message, each belonging to the step that sends it. */
const diagram = [
  { step: 'victim-signup', from: 'victim', to: 'website', text: 'Sign up' },
  { step: 'victim-passkey', from: 'victim', to: 'website', text: 'Register: victim’s credential ID + victim’s key' },
  { step: 'attacker-signup', from: 'attacker', to: 'website', text: 'Sign up' },
  { step: 'overwrite', from: 'attacker', to: 'website', text: 'Register: victim’s credential ID + attacker’s key' },
  { step: 'overwrite', from: 'website', to: 'website', text: 'Replaces victim’s key with attacker’s key', kind: 'bad', reached: keyOverwritten },
  { step: 'takeover', from: 'attacker', to: 'website', text: 'Log in as victim, signed with attacker’s key' },
  { step: 'takeover', from: 'website', to: 'attacker', text: '✓ Signature valid: logged in as victim', kind: 'bad', reached: attackerIsVictim },
  { step: 'lockout', from: 'victim', to: 'website', text: 'Log in as victim, signed with victim’s key' },
  { step: 'lockout', from: 'website', to: 'victim', text: '✗ Signature invalid: locked out', kind: 'bad', reached: victimLockedOut },
];

export default {
  id: 'full-story',
  title: 'demo: account takeover',
  headline: 'Credential Overwrite <span class="arrow">→</span> Account Takeover',
  summary: 'Both people start from scratch: the victim signs up and registers a passkey, the attacker overwrites it, takes over the account, and the victim is locked out.',
  presetNames: null,
  loginCheck: 'signature',
  flagDetail: 'the victim’s passkey now holds the attacker’s key.',
  setupStages: SETUP_STAGES,
  prepare,
  steps,
  diagram,
  notices: {
    overwriteMissed: `That created a brand-new passkey for the attacker — its credential ID was not the victim’s. Try again: <b>+ Add Passkey</b>, then pick <code>${VICTIM_KEY}</code> as Credential ID.`,
  },
};
