/**
 * HTTP surface: authentication, profile and match history.
 *
 * Everything that happens during a game goes over the socket instead. REST is
 * only for the things that must work before a socket exists.
 */

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  displayNameSchema,
  passwordSchema,
  profileUpdateSchema,
  roomCodeSchema,
  usernameSchema,
} from '@nmu/shared';
import { hashPassword, verifyPassword } from './auth/password.js';
import { AuthError, SESSION_COOKIE, signSession, verifySession, type TokenScope } from './auth/tokens.js';
import {
  createUser,
  findUserByUsername,
  recentMatchesFor,
  setPassword,
  touchUser,
  updateProfile,
  UsernameTakenError,
  db,
} from './db.js';
import { env } from './env.js';
import { buildIceServers, hasTurn } from './voice/ice.js';
import type { RoomManager } from './rooms/RoomManager.js';

const signupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  code: z.string().trim().min(1).max(64),
  displayName: displayNameSchema.optional(),
});

const loginSchema = z.object({
  username: usernameSchema,
  // Not `passwordSchema`: the rules may tighten later, and an old password that
  // no longer meets them should still get you in so you can change it.
  password: z.string().min(1).max(128),
});

const resetSchema = z.object({ newPassword: passwordSchema });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

/**
 * Wrong username and wrong password are reported identically.
 *
 * Otherwise the login form doubles as a "does this person play here" oracle for
 * anyone who finds the IP.
 */
const BAD_CREDENTIALS = 'incorrect username or password';

/**
 * Verifying against a throwaway hash when the username does not exist keeps an
 * unknown-user login as slow as a known-user one, so response time does not
 * leak the member list either. Built once at boot, not per request.
 */
const dummyHash = hashPassword('no-such-account-placeholder');

export interface HttpDeps {
  rooms: RoomManager;
}

/**
 * Session token from the Authorization header, falling back to the cookie.
 *
 * The header wins deliberately. A caller that sets `Bearer ...` has chosen a
 * specific credential, and the browser attaches the cookie to every request
 * whether it is wanted or not. With the old cookie-first order, finishing a
 * forced password change failed for anyone who still had a session cookie
 * lying around: the reset token in the header was ignored in favour of a
 * session cookie, and the route rejected it as the wrong scope.
 */
function tokenFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return req.cookies[SESSION_COOKIE] ?? null;
}

/**
 * The user behind the request, or an AuthError.
 *
 * Defaults to demanding a full `session` token, so a reset-scoped token is
 * rejected everywhere by default and only the password routes opt into
 * accepting one. Getting this backwards -- allowing by default, denying on the
 * routes you remember -- is how a forced password change ends up being
 * skippable.
 */
async function requireUserId(req: FastifyRequest, scope: TokenScope = 'session'): Promise<string> {
  const token = tokenFrom(req);
  if (!token) throw new AuthError('not signed in');
  const session = await verifySession(token);
  if (session.scope !== scope) {
    throw new AuthError(
      scope === 'session'
        ? 'set a new password before continuing'
        : 'this action needs a password-reset token',
    );
  }
  return session.userId;
}

export async function buildHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const config = env();
  const app = Fastify({
    logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true,
  });

  await app.register(cookie);
  await app.register(cors, { origin: config.corsOrigins, credentials: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) {
      return reply.code(401).send({ code: 'unauthorized', message: err.message });
    }
    if (err instanceof UsernameTakenError) {
      return reply.code(409).send({ code: 'username_taken', message: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ code: 'bad_request', message: err.issues[0]?.message ?? 'bad request' });
    }
    app.log.error(err);
    return reply.code(500).send({ code: 'internal', message: 'something went wrong' });
  });

  app.get('/api/config', async () => ({
    // Deliberately says only that signup exists, never what the code is.
    signupEnabled: true,
    minPasswordLength: 8,
  }));

  app.get('/api/health', async () => ({
    ok: true,
    rooms: deps.rooms.size,
    uptime: Math.round(process.uptime()),
  }));

  /**
   * Issue a full session: cookie for the REST calls, body copy for the socket.
   *
   * The cookie is httpOnly so page scripts cannot read it; the token is also
   * returned in the body because the socket handshake has to present it
   * explicitly and therefore cannot rely on the cookie.
   */
  const grantSession = async (reply: FastifyReply, userId: string) => {
    const token = await signSession(userId, 'session');
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production',
      path: '/',
      maxAge: config.SESSION_TTL_DAYS * 24 * 60 * 60,
    });
    return token;
  };

  /**
   * Create an account.
   *
   * The invite code is checked here and nowhere else -- the client never learns
   * it, and a wrong code fails before the username is even looked at, so this
   * route cannot be used to probe which names are taken.
   *
   * What comes back is a *reset*-scoped token, not a session. The password
   * chosen here is a one-time password by design: it gets you exactly as far as
   * the "choose a new password" screen and no further.
   */
  app.post('/api/auth/signup', async (req) => {
    const { username, password, code, displayName } = signupSchema.parse(req.body);

    if (code.trim() !== config.SIGNUP_CODE) {
      throw new AuthError('that signup code is not valid');
    }

    const user = await createUser(username, password, displayName ?? username);
    const token = await signSession(user.id, 'reset');
    return { token, mustResetPassword: true, user: publicProfile(user) };
  });

  /**
   * Sign in.
   *
   * An account that has never changed its signup password gets a reset token
   * and no cookie, so it lands on the password screen instead of the lobby.
   */
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = loginSchema.parse(req.body);

    const user = await findUserByUsername(username);
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
    if (!user || !ok) throw new AuthError(BAD_CREDENTIALS);

    if (user.mustResetPassword) {
      const token = await signSession(user.id, 'reset');
      return { token, mustResetPassword: true, user: publicProfile(user) };
    }

    const token = await grantSession(reply, user.id);
    await touchUser(user.id);
    return { token, mustResetPassword: false, user: publicProfile(user) };
  });

  /**
   * Complete the forced first password change.
   *
   * The reset token is the authorisation, so the old password is not asked for
   * again -- it was typed moments ago to obtain the token, and the token
   * expires in minutes. Ordinary later changes go through
   * /api/auth/change-password, which does require it.
   */
  app.post('/api/auth/reset-password', async (req, reply) => {
    const userId = await requireUserId(req, 'reset');
    const { newPassword } = resetSchema.parse(req.body);

    const current = await db().user.findUnique({ where: { id: userId } });
    if (!current) throw new AuthError('account no longer exists');
    if (await verifyPassword(newPassword, current.passwordHash)) {
      throw new AuthError('choose a password different from the one you were given');
    }

    const user = await setPassword(userId, newPassword);
    const token = await grantSession(reply, user.id);
    return { token, mustResetPassword: false, user: publicProfile(user) };
  });

  /** Change your password from the profile screen. Needs the old one. */
  app.post('/api/auth/change-password', async (req, reply) => {
    const userId = await requireUserId(req);
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    const current = await db().user.findUnique({ where: { id: userId } });
    if (!current) throw new AuthError('account no longer exists');
    if (!(await verifyPassword(currentPassword, current.passwordHash))) {
      throw new AuthError('your current password is not correct');
    }
    if (currentPassword === newPassword) {
      throw new AuthError('the new password must be different from the old one');
    }

    const user = await setPassword(userId, newPassword);
    // A fresh token, so the change is a good moment to extend the session
    // rather than have it expire on the old schedule.
    const token = await grantSession(reply, user.id);
    return { token, user: publicProfile(user) };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const userId = await requireUserId(req);
    const user = await db().user.findUnique({ where: { id: userId } });
    if (!user) throw new AuthError('account no longer exists');
    return { user: publicProfile(user) };
  });

  app.patch('/api/me', async (req) => {
    const userId = await requireUserId(req);
    const patch = profileUpdateSchema.parse(req.body);
    const user = await updateProfile(userId, patch);
    return { user: publicProfile(user) };
  });

  app.get('/api/me/matches', async (req) => {
    const userId = await requireUserId(req);
    const matches = await recentMatchesFor(userId);
    return { matches };
  });

  /**
   * Does this room exist, and is it joinable? Lets the join screen say "no such
   * room" before asking for a password. Deliberately does not reveal the member
   * list or settings to someone who has not authenticated into the room.
   */
  app.get('/api/rooms/:code', async (req) => {
    await requireUserId(req);
    const { code } = z.object({ code: roomCodeSchema }).parse(req.params);
    const room = deps.rooms.get(code);
    if (!room) return { exists: false };
    const view = room.view();
    return {
      exists: true,
      status: view.status,
      name: view.settings.name,
      players: view.members.length,
      maxPlayers: view.settings.maxPlayers,
    };
  });

  /**
   * Fresh ICE servers, including short-lived TURN credentials.
   *
   * Authenticated: TURN relays real bandwidth, so credentials go only to a
   * signed-in user. Fetched per call rather than baked into /api/config
   * because the credentials expire.
   */
  app.get('/api/voice/ice', async (req) => {
    const userId = await requireUserId(req);
    return { iceServers: buildIceServers(userId), hasTurn: hasTurn() };
  });

  // In production the same process serves the built client, so there is one
  // origin, no CORS in the request path, and one thing to deploy.
  if (config.WEB_DIST) {
    await app.register(fastifyStatic, { root: config.WEB_DIST, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/socket.io')) {
        return reply.code(404).send({ code: 'not_found', message: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

type UserRow = {
  id: string;
  username: string;
  mustResetPassword: boolean;
  displayName: string;
  avatarUrl: string | null;
  cardBack: string;
  sfxVolume: number;
  micDefaultOn: boolean;
  preferredTurnSeconds: number;
};

function publicProfile(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    mustResetPassword: user.mustResetPassword,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    cardBack: user.cardBack,
    sfxVolume: user.sfxVolume,
    micDefaultOn: user.micDefaultOn,
    preferredTurnSeconds: user.preferredTurnSeconds,
  };
}
