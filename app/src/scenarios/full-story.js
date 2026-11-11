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
    callout: `<b>How does the attacker know the victim’s credential ID?</b> It is not a secret: many websites reveal it to anyone who enters the victim’s username at login (<code>allowCredentials</code>). Here, both browsers share one passkeys.tools key store, so it is listed as <code>${VICTIM_KEY}</code>.`,
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

export default {
  id: 'full-story',
  title: 'Full story',
  summary: 'Both people start from scratch: the victim signs up and registers a passkey, the attacker overwrites it, takes over the account, and the victim is locked out.',
  presetNames: null,
  setupStages: SETUP_STAGES,
  prepare,
  steps,
  notices: {
    overwriteMissed: `That created a brand-new passkey for the attacker — its credential ID was not the victim’s. Try again: <b>+ Add Passkey</b>, then pick <code>${VICTIM_KEY}</code> as Credential ID.`,
  },
};
