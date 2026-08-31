#!/usr/bin/env node
/**
 * Deployment preflight.
 *
 *   node deploy/preflight.mjs
 *
 * Checks the things that fail *quietly* in production. A mismatched
 * TURN_SECRET does not crash anything: the server happily mints credentials,
 * coturn happily rejects them, and voice fails only for the people on the worst
 * networks -- which is close to impossible to diagnose from the outside. Same
 * for an unreplaced $PUBLIC_IP, which makes coturn hand out unroutable
 * candidates. Every check here exists because the failure it catches is silent.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

let failures = 0;
let warnings = 0;

const ok = (msg) => console.log(`  [32mok[0m    ${msg}`);
const bad = (msg, fix) => {
  console.log(`  [31mFAIL[0m  ${msg}`);
  if (fix) console.log(`        ${fix}`);
  failures++;
};
const warn = (msg, fix) => {
  console.log(`  [33mwarn[0m  ${msg}`);
  if (fix) console.log(`        ${fix}`);
  warnings++;
};

function section(name) {
  console.log(`\n${name}`);
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Parse a .env-style file into a map, ignoring comments and blanks. */
function parseEnv(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

/** Read a coturn-style `key=value` directive, ignoring commented lines. */
function turnDirective(text, key) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return null;
}

console.log('No Mercy UNO — deployment preflight');

// ---------------------------------------------------------------------------
section('server environment');

const envPath = join(REPO, 'apps/server/.env');
const envText = readIfExists(envPath);
let env = new Map();

if (!envText) {
  bad('apps/server/.env is missing', 'cp apps/server/.env.example apps/server/.env and fill it in');
} else {
  env = parseEnv(envText);
  ok('apps/server/.env exists');

  if (env.get('NODE_ENV') !== 'production') {
    bad(
      `NODE_ENV is "${env.get('NODE_ENV') ?? 'unset'}", not production`,
      'Anything but production also registers the passwordless /api/auth/dev route.',
    );
  } else {
    ok('NODE_ENV=production (dev sign-in route will not be registered)');
  }

  const secret = env.get('SESSION_SECRET') ?? '';
  if (secret.length < 32) {
    bad('SESSION_SECRET is shorter than 32 characters', 'openssl rand -base64 48');
  } else if (secret.includes('replace-me')) {
    bad('SESSION_SECRET is still the placeholder', 'openssl rand -base64 48');
  } else {
    ok('SESSION_SECRET looks real');
  }

  const clientId = env.get('GOOGLE_CLIENT_ID') ?? '';
  if (!clientId || clientId.includes('replace-me') || clientId.includes('placeholder')) {
    bad('GOOGLE_CLIENT_ID is unset or a placeholder', 'Google Cloud Console -> Credentials -> OAuth 2.0 Client ID');
  } else if (!clientId.endsWith('.apps.googleusercontent.com')) {
    warn(`GOOGLE_CLIENT_ID does not look like a Google client id: ${clientId}`);
  } else {
    ok('GOOGLE_CLIENT_ID is set');
  }

  const origins = env.get('CORS_ORIGINS') ?? '';
  if (origins.includes('localhost')) {
    warn(`CORS_ORIGINS still mentions localhost: ${origins}`, 'Should be your https:// origin in production.');
  } else if (!origins.startsWith('https://')) {
    bad(`CORS_ORIGINS is not https: ${origins}`, 'getUserMedia needs a secure origin, so the app must be served over https.');
  } else {
    ok(`CORS_ORIGINS = ${origins}`);
  }
}

// ---------------------------------------------------------------------------
section('nginx');

const nginx = readIfExists(join(HERE, 'nginx.conf'));
let domain = null;

if (!nginx) {
  bad('deploy/nginx.conf is missing');
} else {
  // Strip comments so prose about a directive is never mistaken for the
  // directive itself.
  const conf = nginx
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  const names = [...conf.matchAll(/server_name\s+([^;]+);/g)].map((m) => m[1].trim());
  domain = names.find((n) => n.includes('.')) ?? null;
  if (!domain) {
    bad('could not find a server_name in nginx.conf');
  } else {
    ok(`server_name: ${domain}`);
  }

  /**
   * The websocket block is the single most important thing in this file. Without
   * the upgrade headers Socket.IO never connects; without the long read timeout
   * every player is dropped 60s after the table goes quiet, which looks exactly
   * like a flaky network.
   */
  const socketBlock = /location\s+\/socket\.io\/\s*\{([\s\S]*?)\n\s*\}/.exec(conf)?.[1] ?? '';
  if (!socketBlock) {
    bad(
      'nginx.conf has no `location /socket.io/` block',
      'Socket.IO would never connect and the game would never start.',
    );
  } else {
    const needs = [
      ['proxy_http_version 1.1', 'websockets require HTTP/1.1'],
      ['Upgrade $http_upgrade', 'the upgrade header is what makes it a websocket'],
      ['Connection "upgrade"', 'without this nginx closes the upgrade'],
    ];
    const missing = needs.filter(([token]) => !socketBlock.includes(token));
    if (missing.length > 0) {
      bad(
        `the /socket.io/ block is missing: ${missing.map(([t]) => t).join(', ')}`,
        missing.map(([, why]) => why).join('; '),
      );
    } else {
      ok('/socket.io/ block has the websocket upgrade headers');
    }

    const timeout = /proxy_read_timeout\s+(\S+);/.exec(socketBlock)?.[1];
    if (!timeout) {
      bad(
        'the /socket.io/ block has no proxy_read_timeout',
        "nginx defaults to 60s, which silently drops every player a minute after the table goes quiet.",
      );
    } else if (/^(\d+)s?$/.test(timeout) && Number(timeout.replace('s', '')) < 3600) {
      warn(`proxy_read_timeout is only ${timeout} on the websocket block`, 'A quiet table longer than this disconnects everyone.');
    } else {
      ok(`websocket proxy_read_timeout = ${timeout}`);
    }

    if (!socketBlock.includes('proxy_buffering off')) {
      warn('the /socket.io/ block does not set `proxy_buffering off`', 'Buffering adds latency to realtime frames.');
    } else {
      ok('websocket buffering is off');
    }
  }

  if (domain && env.size > 0) {
    const origins = env.get('CORS_ORIGINS') ?? '';
    if (origins && !origins.includes(domain)) {
      bad(
        `CORS_ORIGINS (${origins}) does not mention the nginx server_name (${domain})`,
        'The browser origin must be allowed or every API call and socket is refused.',
      );
    } else if (origins) {
      ok('CORS_ORIGINS matches the nginx server_name');
    }
  }
}

// ---------------------------------------------------------------------------
section('pm2');

const pm2 = readIfExists(join(HERE, 'ecosystem.config.cjs'));
if (!pm2) {
  bad('deploy/ecosystem.config.cjs is missing');
} else {
  const instances = /instances:\s*(\S+?),/.exec(pm2)?.[1];
  const mode = /exec_mode:\s*'([^']+)'/.exec(pm2)?.[1];

  /**
   * Rooms are an in-process Map and Socket.IO has no Redis adapter. More than
   * one worker means two players in the same room can land on different
   * processes: each sees a room containing only themselves.
   */
  if (instances !== '1') {
    bad(
      `PM2 is set to ${instances} instances`,
      'Rooms live in memory with no Redis adapter. Anything above 1 splits players in the same room across processes.',
    );
  } else {
    ok('PM2 runs a single instance (required: rooms are in-process)');
  }

  if (mode && mode !== 'fork') {
    bad(`PM2 exec_mode is "${mode}"`, 'Use fork; cluster mode load-balances sockets across workers.');
  } else if (mode) {
    ok('PM2 exec_mode = fork');
  }
}

// ---------------------------------------------------------------------------
section('turn / voice');

const turnConf = readIfExists(join(HERE, 'coturn.conf'));

if (!turnConf) {
  bad('deploy/coturn.conf is missing');
} else {
  const external = turnDirective(turnConf, 'external-ip');
  if (!external || external.includes('$')) {
    bad(
      `coturn external-ip still has placeholders: ${external ?? 'unset'}`,
      'Set it to <PUBLIC_IP>/<PRIVATE_IP>. Lightsail maps a public IP onto a private one, and coturn must advertise the public address or every candidate it hands out is unroutable.',
    );
  } else {
    ok(`coturn external-ip = ${external}`);
  }

  const confSecret = turnDirective(turnConf, 'static-auth-secret');
  const envSecret = env.get('TURN_SECRET') ?? '';

  if (!confSecret || confSecret.includes('$')) {
    bad('coturn static-auth-secret is still a placeholder', 'openssl rand -hex 32, and use the same value in apps/server/.env');
  } else if (!envSecret) {
    warn('TURN_SECRET is not set in apps/server/.env — voice will fall back to STUN only', 'Peers on restrictive NATs will silently fail to hear each other.');
  } else if (confSecret !== envSecret) {
    bad(
      'TURN_SECRET does not match coturn static-auth-secret',
      'These sign and verify the same HMAC. When they differ, relayed connections are rejected and voice fails ONLY for the people who needed the relay.',
    );
  } else {
    ok('TURN_SECRET matches coturn static-auth-secret');
  }

  const turnUrls = env.get('TURN_URLS') ?? '';
  if (!turnUrls) {
    warn('TURN_URLS is empty — no relay will be offered to clients');
  } else if (domain && !turnUrls.includes(domain)) {
    warn(`TURN_URLS (${turnUrls}) does not mention ${domain}`);
  } else {
    ok(`TURN_URLS = ${turnUrls}`);
  }

  const minPort = turnDirective(turnConf, 'min-port');
  const maxPort = turnDirective(turnConf, 'max-port');
  if (minPort && maxPort) {
    ok(`relay UDP range ${minPort}-${maxPort} — must also be open in the Lightsail firewall`);
  }
}

// ---------------------------------------------------------------------------
section('paths');

if (env.size > 0) {
  const webDist = env.get('WEB_DIST') ?? '';
  if (!webDist) {
    bad('WEB_DIST is not set', 'The server would start and then 404 every page.');
  } else if (!webDist.startsWith('/')) {
    bad(`WEB_DIST is not an absolute path: ${webDist}`, 'PM2 sets its own cwd; a relative path will not resolve.');
  } else {
    ok(`WEB_DIST = ${webDist}`);
  }

  const dbUrl = env.get('DATABASE_URL') ?? '';
  if (!dbUrl.startsWith('file:/')) {
    bad(
      `DATABASE_URL should be an absolute file: path, got "${dbUrl}"`,
      'A relative path resolves against PM2 cwd and you will end up with two different databases.',
    );
  } else {
    ok(`DATABASE_URL = ${dbUrl}`);
  }

  const host = env.get('HOST') ?? '';
  if (host && host !== '127.0.0.1') {
    warn(
      `HOST is ${host}`,
      'Bound to 0.0.0.0 the app is reachable on :3000 directly, bypassing nginx and TLS.',
    );
  } else if (host) {
    ok('HOST = 127.0.0.1 (only nginx can reach it)');
  }
}

// ---------------------------------------------------------------------------
console.log(
  `\n${failures === 0 ? '[32mready to deploy[0m' : `[31m${failures} blocking problem(s)[0m`}` +
    (warnings ? ` [33m(${warnings} warning(s))[0m` : ''),
);
process.exit(failures === 0 ? 0 : 1);
