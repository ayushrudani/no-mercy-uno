/**
 * Password hashing with node's built-in scrypt.
 *
 * No bcrypt or argon2 dependency on purpose. Both are native modules, which
 * means a compiler toolchain on the Lightsail box and a rebuild every time node
 * changes -- a real source of "it deployed fine last month" failures. scrypt is
 * memory-hard, ships with node, and is more than enough for a private game.
 *
 * The stored format is self-describing:
 *
 *     scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>
 *
 * so the cost parameters can be raised later without invalidating the hashes
 * already in the database -- verification reads them back out of the string.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// ~64 MB and roughly 100ms on a small instance. Comfortably above the default
// (N=16384) without making a login feel slow or tripping scrypt's memory cap.
const PARAMS = { N: 32768, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** scrypt refuses to run if it would exceed maxmem, which defaults to 32 MB. */
const maxmemFor = (N: number, r: number) => 256 * N * r * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: maxmemFor(PARAMS.N, PARAMS.r),
  });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Check a password against a stored hash.
 *
 * Never throws on a malformed or unknown hash -- it returns false. A corrupt
 * row should read as "wrong password", not as a 500 that tells an attacker the
 * account exists and is in an unusual state.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return false;
  }
  // Bounds the cost of a hash we were handed rather than one we chose, so a
  // tampered row cannot turn one login into an enormous allocation.
  if (N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    });
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
