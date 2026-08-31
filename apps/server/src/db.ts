import { PrismaClient } from '@prisma/client';
import type { ProfileUpdate } from '@nmu/shared';
import type { MatchResult } from './rooms/Room.js';
import type { GoogleIdentity } from './auth/tokens.js';

let client: PrismaClient | null = null;

export function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export async function disconnectDb(): Promise<void> {
  await client?.$disconnect();
  client = null;
}

/**
 * Find or create the account behind a verified Google identity.
 *
 * Keyed on `googleSub`, never on email: Google's subject claim is stable for
 * the life of the account, whereas someone changing their Gmail address would
 * otherwise orphan their match history.
 */
export async function upsertUserFromGoogle(identity: GoogleIdentity) {
  const existing = await db().user.findUnique({ where: { googleSub: identity.sub } });

  if (existing) {
    return db().user.update({
      where: { id: existing.id },
      data: {
        email: identity.email,
        avatarUrl: identity.picture,
        lastSeenAt: new Date(),
      },
    });
  }

  return db().user.create({
    data: {
      googleSub: identity.sub,
      email: identity.email,
      displayName: identity.name.slice(0, 24),
      avatarUrl: identity.picture,
    },
  });
}

export async function updateProfile(userId: string, patch: ProfileUpdate) {
  const data: Record<string, unknown> = {};
  if (patch.displayName !== undefined) data['displayName'] = patch.displayName;
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
