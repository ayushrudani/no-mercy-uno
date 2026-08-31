/**
 * TURN credential minting.
 *
 * These matter because a mistake here fails in one of two bad ways: credentials
 * coturn rejects (voice silently never connects across NATs), or credentials
 * that never expire (a free permanent relay on your bandwidth for anyone who
 * opens devtools).
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  SIGNUP_CODE: '94997749',
  SESSION_SECRET: 'x'.repeat(40),
};

async function load(extra: Record<string, string> = {}) {
  vi.resetModules();
  const env = await import('../src/env.js');
  // loadEnv reads process.env; set it before the module caches anything.
  Object.assign(process.env, BASE_ENV, extra);
  // Re-import a fresh copy so env() re-reads.
  const ice = await import('../src/voice/ice.js');
  return { ice, env };
}

const ORIGINAL = { ...process.env };

beforeEach(() => {
  for (const k of ['STUN_URLS', 'TURN_URLS', 'TURN_SECRET', 'TURN_TTL_SECONDS']) {
    delete process.env[k];
  }
  Object.assign(process.env, BASE_ENV);
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.useRealTimers();
});

describe('with no TURN configured', () => {
  it('still returns STUN, and reports that there is no relay', async () => {
    const { ice } = await load();
    const servers = ice.buildIceServers('user-1');
    expect(servers).toHaveLength(1);
    expect(String(servers[0]!.urls)).toContain('stun:');
    expect(servers[0]!.username).toBeUndefined();
    expect(ice.hasTurn()).toBe(false);
  });

  it('reports no relay when a URL is set but the secret is missing', async () => {
    const { ice } = await load({ TURN_URLS: 'turn:example.com:3478' });
    expect(ice.hasTurn()).toBe(false);
    expect(ice.buildIceServers('u').every((s) => !s.username)).toBe(true);
  });
});

describe('with TURN configured', () => {
  const TURN = {
    TURN_URLS: 'turn:uno.bunkcode.online:3478,turns:uno.bunkcode.online:5349',
    TURN_SECRET: 'super-secret-value',
    TURN_TTL_SECONDS: '3600',
  };

  it('mints a username of <expiry>:<userId>', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00Z'));

    const { ice } = await load(TURN);
    const turn = ice.buildIceServers('user-42').find((s) => s.username);
    expect(turn).toBeDefined();

    const nowSec = Math.floor(Date.parse('2026-08-31T12:00:00Z') / 1000);
    expect(turn!.username).toBe(`${nowSec + 3600}:user-42`);
  });

  it('signs the username with HMAC-SHA1 the way coturn verifies it', async () => {
    const { ice } = await load(TURN);
    const turn = ice.buildIceServers('user-42').find((s) => s.username)!;

    const expected = createHmac('sha1', TURN.TURN_SECRET)
      .update(turn.username!)
      .digest('base64');
    expect(turn.credential).toBe(expected);
  });

  it('lists every configured TURN URL', async () => {
    const { ice } = await load(TURN);
    const turn = ice.buildIceServers('u').find((s) => s.username)!;
    expect(turn.urls).toEqual([
      'turn:uno.bunkcode.online:3478',
      'turns:uno.bunkcode.online:5349',
    ]);
  });

  it('gives different users different credentials', async () => {
    const { ice } = await load(TURN);
    const a = ice.buildIceServers('alice').find((s) => s.username)!;
    const b = ice.buildIceServers('bob').find((s) => s.username)!;
    expect(a.credential).not.toBe(b.credential);
  });

  it('issues a credential that expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00Z'));
    const { ice } = await load(TURN);
    const turn = ice.buildIceServers('u').find((s) => s.username)!;
    const expiry = Number(turn.username!.split(':')[0]);
    expect(expiry).toBeGreaterThan(Date.now() / 1000);
    expect(expiry).toBeLessThanOrEqual(Date.now() / 1000 + 3600);
  });

  it('puts STUN first, so a direct path is tried before paying for a relay', async () => {
    const { ice } = await load(TURN);
    const servers = ice.buildIceServers('u');
    expect(String(servers[0]!.urls)).toContain('stun:');
    expect(servers[1]!.username).toBeDefined();
    expect(ice.hasTurn()).toBe(true);
  });
});
