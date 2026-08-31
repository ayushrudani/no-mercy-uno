/**
 * Our own session tokens, signed with `jose`.
 *
 * The browser holds the token and presents it on every socket connection,
 * which is what makes reconnecting to your seat mid-game work.
 *
 * Tokens carry a scope, and that scope is the whole enforcement mechanism
 * behind the forced first password change. A brand-new account can only ever
 * be issued a `reset` token: it proves who you are and authorises exactly one
 * route -- setting a new password. Everything else, including the socket
 * handshake, demands a `session` token. There is no flag to forget to check
 * on some future route, because a reset token simply is not a session.
 */

import { jwtVerify, SignJWT } from 'jose';
import { env } from '../env.js';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const ISSUER = 'no-mercy-uno';
const AUDIENCE = 'no-mercy-uno-client';

/** A reset token is deliberately short-lived; it is a one-errand credential. */
const RESET_TTL = '20m';

export type TokenScope = 'session' | 'reset';

function secret(): Uint8Array {
  return new TextEncoder().encode(env().SESSION_SECRET);
}

export interface Session {
  userId: string;
  scope: TokenScope;
}

export async function signSession(
  userId: string,
  scope: TokenScope = 'session',
): Promise<string> {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(scope === 'reset' ? RESET_TTL : `${env().SESSION_TTL_DAYS}d`)
    .sign(secret());
}

export async function verifySession(token: string): Promise<Session> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload.sub !== 'string') throw new Error('missing subject');
    // Tokens minted before scopes existed have none; treat them as full
    // sessions so an upgrade does not sign everybody out mid-game.
    const scope = payload['scope'] === 'reset' ? 'reset' : 'session';
    return { userId: payload.sub, scope };
  } catch (err) {
    throw new AuthError(`session token rejected: ${(err as Error).message}`);
  }
}

export const SESSION_COOKIE = 'nmu_session';
