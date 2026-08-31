/**
 * Seed a few finished matches into the local development database.
 *
 *   pnpm exec tsx scripts/seed-history.ts
 *
 * Development only: it writes through the same `saveMatch` path the server uses
 * when a real game ends, so it also serves as a check that persistence and the
 * history query actually work end to end.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const { db, saveMatch, recentMatchesFor, disconnectDb } = await import('../src/db.js');

const NAMES = ['Ayush', 'Rohit', 'Karan'];

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('refusing to seed a production database');
  }

  const users = await Promise.all(
    NAMES.map((name) =>
      db().user.upsert({
        where: { googleSub: `dev:${name.toLowerCase()}` },
        update: {},
        create: {
          googleSub: `dev:${name.toLowerCase()}`,
          email: `dev:${name.toLowerCase()}@dev.local`,
          displayName: name,
        },
      }),
    ),
  );

  const hoursAgo = (h: number) => Date.now() - h * 3600_000;

  // A mix of results, so the record panel shows something other than 100%.
  const games = [
    { winner: 0, rounds: 4, at: hoursAgo(1), places: [1, 2, 3], roundsWon: [3, 1, 0] },
    { winner: 1, rounds: 6, at: hoursAgo(20), places: [2, 1, 3], roundsWon: [2, 3, 1] },
    { winner: 0, rounds: 3, at: hoursAgo(50), places: [1, 3, 2], roundsWon: [2, 0, 1] },
    { winner: 2, rounds: 5, at: hoursAgo(100), places: [3, 2, 1], roundsWon: [1, 1, 3] },
  ];

  for (const g of games) {
    await saveMatch({
      roomCode: 'SEED01',
      startedAt: g.at,
      endedAt: g.at + g.rounds * 6 * 60_000,
      rounds: g.rounds,
      winnerId: users[g.winner]!.id,
      players: users.map((u, i) => ({
        userId: u.id,
        seat: i,
        roundsWon: g.roundsWon[i]!,
        finalPlace: g.places[i]!,
      })),
    });
  }

  const back = await recentMatchesFor(users[0]!.id);
  console.log(`seeded ${games.length} matches; history query returned ${back.length}`);
  console.log(
    back
      .map((m) => `  ${new Date(m.startedAt).toISOString()}  ${m.rounds} rounds  winner=${m.winnerId}`)
      .join('\n'),
  );

  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDb();
  process.exit(1);
});
