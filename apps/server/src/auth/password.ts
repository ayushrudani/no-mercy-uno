import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 32;

/**
 * Room-password hashing via node's built-in scrypt.
 *
 * Deliberately not bcrypt/argon2: those are native modules that need a
 * toolchain to install, which is friction on a Windows dev machine and one more
 * thing to break on a Lightsail rebuild. scrypt is memory-hard, in the standard
 * library, and far beyond adequate for a six-character room password.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length !== KEY_LENGTH) return false;

  const derived = await scrypt(password, Buffer.from(saltB64, 'base64'), KEY_LENGTH);
  // Constant-time: a length-independent compare would leak how much of the
  // hash matched, and both buffers are already known to be KEY_LENGTH.
  return timingSafeEqual(derived, expected);
}
