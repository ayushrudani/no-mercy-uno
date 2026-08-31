import { randomInt } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@nmu/shared';

/**
 * Generate a room code.
 *
 * Lives on the server, not in @nmu/shared: it needs node:crypto, and anything
 * the shared barrel exports gets pulled into the browser bundle. Crypto
 * randomness rather than Math.random because a guessable code plus a weak
 * password is the entire security model of a room.
 */
export function generateRoomCode(length = ROOM_CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return out;
}
