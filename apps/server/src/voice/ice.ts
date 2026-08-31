/**
 * ICE server configuration for the browser's WebRTC connections.
 *
 * TURN credentials are minted per request and expire, using coturn's
 * `use-auth-secret` scheme: the username is `<unix-expiry>:<userId>` and the
 * credential is an HMAC of that username under a shared secret. coturn
 * recomputes the same HMAC and accepts it until the expiry passes.
 *
 * The alternative -- a static TURN username and password compiled into the
 * client -- hands anyone who opens devtools a free, permanent relay on your
 * Lightsail bandwidth. These credentials are useless within the hour and are
 * only issued to a signed-in user.
 */

import { createHmac } from 'node:crypto';
import { env } from '../env.js';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export function buildIceServers(userId: string): IceServer[] {
  const config = env();
  const servers: IceServer[] = [];

  const stun = config.STUN_URLS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (stun.length > 0) servers.push({ urls: stun });

  const turnUrls = config.TURN_URLS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (turnUrls.length > 0 && config.TURN_SECRET) {
    const expiry = Math.floor(Date.now() / 1000) + config.TURN_TTL_SECONDS;
    const username = `${expiry}:${userId}`;
    const credential = createHmac('sha1', config.TURN_SECRET).update(username).digest('base64');
    servers.push({ urls: turnUrls, username, credential });
  }

  return servers;
}

/**
 * Whether a relay is actually configured. Surfaced to the client so it can warn
 * that voice may fail across some networks rather than just failing silently --
 * a peer connection that never establishes is otherwise indistinguishable from
 * someone being quiet.
 */
export function hasTurn(): boolean {
  const config = env();
  return config.TURN_URLS.trim().length > 0 && config.TURN_SECRET.length > 0;
}
