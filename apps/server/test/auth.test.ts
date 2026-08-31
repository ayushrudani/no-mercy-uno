/**
 * Password hashing and token scopes.
 *
 * These are the two pieces that decide who gets in, and neither needs a
 * database, so they are worth testing directly rather than only through the
 * routes that use them.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { AuthError, signSession, verifySession } from '../src/auth/tokens.js';
import { loadEnv } from '../src/env.js';
import { SignJWT } from 'jose';

const SECRET = 'test-secret-that-is-comfortably-over-32-characters';

beforeAll(() => {
  // env() caches on first call, and tokens.ts reads SESSION_SECRET from it.
  process.env['SESSION_SECRET'] = SECRET;
  loadEnv();
});

describe('password hashing', () => {
  it('accepts the right password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
  });

  it('rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse batter', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('is case and whitespace sensitive', async () => {
    const hash = await hashPassword('Hunter2 ');
    expect(await verifyPassword('hunter2 ', hash)).toBe(false);
    expect(await verifyPassword('Hunter2', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    // Both still verify: the salt travels inside the string.
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('records its cost parameters so they can be raised later', async () => {
    const [scheme, N, r, p] = (await hashPassword('x')).split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(N)).toBeGreaterThanOrEqual(32768);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
  });

  it('verifies against parameters stored in the hash, not the current ones', async () => {
    // A hash written when the cost was lower must keep working.
    const legacy = await hashPassword('old account');
    const weakened = legacy.replace(/^scrypt\$\d+/, 'scrypt$16384');
    // Different N derives a different key, so this must NOT verify -- the point
    // is that it reads 16384 and fails cleanly rather than throwing.
    expect(await verifyPassword('old account', weakened)).toBe(false);
  });

  /**
   * A corrupt row has to read as "wrong password". Throwing would turn it into
   * a 500 that tells an attacker the account exists and is in an odd state.
   */
  it('returns false rather than throwing on a malformed hash', async () => {
    for (const bad of [
      '',
      'not-a-hash',
      'scrypt$1$2$3',
      'bcrypt$32768$8$1$c2FsdA==$aGFzaA==',
      'scrypt$abc$8$1$c2FsdA==$aGFzaA==',
      'scrypt$32768$8$1$$',
      'scrypt$999999999$8$1$c2FsdA==$aGFzaA==',
    ]) {
      expect(await verifyPassword('anything', bad), bad).toBe(false);
    }
  });
});

describe('session scopes', () => {
  it('round-trips a full session', async () => {
    const token = await signSession('user-1');
    expect(await verifySession(token)).toEqual({ userId: 'user-1', scope: 'session' });
  });

  it('marks a reset token as such', async () => {
    const token = await signSession('user-1', 'reset');
    expect(await verifySession(token)).toEqual({ userId: 'user-1', scope: 'reset' });
  });

  /**
   * The whole forced-reset mechanism rests on these two being distinguishable,
   * so it is worth asserting they are not interchangeable strings.
   */
  it('does not let a reset token pass as a session', async () => {
    const reset = await verifySession(await signSession('user-1', 'reset'));
    expect(reset.scope).not.toBe('session');
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = await new SignJWT({ scope: 'session' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer('no-mercy-uno')
      .setAudience('no-mercy-uno-client')
      .setIssuedAt()
      .setExpirationTime('1d')
      .sign(new TextEncoder().encode('a completely different secret over 32 chars'));

    await expect(verifySession(forged)).rejects.toThrow(AuthError);
  });

  it('rejects garbage', async () => {
    await expect(verifySession('not.a.jwt')).rejects.toThrow(AuthError);
    await expect(verifySession('')).rejects.toThrow(AuthError);
  });

  /** Upgrading should not sign everyone out mid-game. */
  it('treats a scopeless legacy token as a full session', async () => {
    const legacy = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer('no-mercy-uno')
      .setAudience('no-mercy-uno-client')
      .setIssuedAt()
      .setExpirationTime('1d')
      .sign(new TextEncoder().encode(SECRET));

    expect(await verifySession(legacy)).toEqual({ userId: 'user-1', scope: 'session' });
  });
});
