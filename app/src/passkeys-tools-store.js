import { createHash, randomBytes } from 'node:crypto';

/**
 * Minimal client for the PASSKEYS-ATTACKER remote storage backend (db.passkeys.tools).
 * The frontend identifies a store by the SHA-256 of its secret; with end-to-end encryption
 * the item names stay readable, which is all the demo needs.
 */
export function generateSecret() {
  return randomBytes(24).toString('base64url');
}

function secretHash(secret) {
  return createHash('sha256').update(secret).digest('hex');
}

export async function listKeyNames(dbUrl, secret) {
  const response = await fetch(`${dbUrl}/api/data/keys_enc`, {
    headers: { 'X-Secret-Hash': secretHash(secret) },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`passkeys.tools storage answered ${response.status}`);
  return Object.keys(await response.json());
}
