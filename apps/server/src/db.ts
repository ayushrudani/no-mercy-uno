import { PrismaClient } from '@prisma/client';
import type { ProfileUpdate } from '@nmu/shared';
import type { MatchResult } from './rooms/Room.js';
import { hashPassword } from './auth/password.js';

let client: PrismaClient | null = null;

export function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export async function disconnectDb(): Promise<void> {
  await client?.$disconnect();
  client = null;
}

/** Raised when a signup collides with a username that is already taken. */
export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`the username "${username}" is already taken`);
    this.name = 'UsernameTakenError';
  }
}

export function findUserByUsername(username: string) {
  return db().user.findUnique({ where: { username } });
}

/**
 * Create an account.
 *
 * `mustResetPassword` comes from the schema default and is deliberately not
 * overridden here: every account starts out needing its password changed
 * before it can do anything.
 *
 * The unique constraint is what actually decides the race. Checking first and
 * then creating leaves a window where two simultaneous signups both see the
 * name as free, so the create is allowed to fail and P2002 is translated.
 */
export async function createUser(username: string, password: string, displayName: string) {
  try {
    return await db().user.create({
      data: {
        username,
        passwordHash: await hashPassword(password),
        displayName: displayName.slice(0, 24),
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new UsernameTakenError(username);
    throw err;
  }
}

/** Replace a password and clear the forced-reset flag in one write. */
export async function setPassword(userId: string, password: string) {
  return db().user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(password),
      mustResetPassword: false,
      lastSeenAt: new Date(),
    },
  });
}

export function touchUser(userId: string) {
  return db().user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
}

export async function updateProfile(userId: string, patch: ProfileUpdate) {
  const data: Record<string, unknown> = {};
  if (patch.displayName !== undefined) data['displayName'] = patch.displayName;
  if (patch.handSort !== undefined) data['handSort'] = patch.handSort;
  if (patch.cardBack !== undefined) data['cardBack'] = patch.cardBack;
  if (patch.sfxVolume !== undefined) data['sfxVolume'] = patch.sfxVolume;
  if (patch.micDefaultOn !== undefined) data['micDefaultOn'] = patch.micDefaultOn;
  if (patch.preferredTurnSeconds !== undefined) data['preferredTurnSeconds'] = patch.preferredTurnSeconds;

  return db().user.update({ where: { id: userId }, data });
}

/** Persist a finished game. Best-effort: a DB hiccup must not kill the room. */
export async function saveMatch(result: MatchResult): Promise<void> {
  await db().match.create({
    data: {
      roomCode: result.roomCode,
      startedAt: new Date(result.startedAt),
      endedAt: new Date(result.endedAt),
      rounds: result.rounds,
      winnerId: result.winnerId,
      players: {
        create: result.players.map((p) => ({
          userId: p.userId,
          seat: p.seat,
          roundsWon: p.roundsWon,
          finalPlace: p.finalPlace,
        })),
      },
    },
  });
}

export async function recentMatchesFor(userId: string, limit = 20) {
  return db().match.findMany({
    where: { players: { some: { userId } } },
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: {
      players: {
        include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
        orderBy: { seat: 'asc' },
      },
    },
  });
}
