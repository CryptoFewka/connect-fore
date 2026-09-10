/**
 * Wire protocol between the browser and the `GameRoom` Durable Object.
 *
 * Deterministic lockstep: the client sends only the four numbers that describe a
 * swing. The DO validates the seat and turn number, runs the same simulation the
 * client is about to run, and broadcasts the authoritative record. Both ends then
 * animate identical flight paths from identical inputs.
 */
import type { MatchState, Player, ShotParams, ShotRecord } from '../game/types';

export const PROTOCOL_VERSION = 1;

export type Role = 'player' | 'spectator';

export interface PlayerInfo {
  readonly seat: Player;
  readonly name: string;
  readonly connected: boolean;
}

export type ClientMessage =
  | { t: 'hello'; v: number; clientId: string; name?: string }
  | { t: 'shot'; turn: number; params: ShotParams }
  | { t: 'rematch' }
  | { t: 'ping'; ts: number };

export type ServerErrorCode =
  | 'bad-version'
  | 'bad-message'
  | 'room-full'
  | 'not-your-turn'
  | 'stale-turn'
  | 'match-over'
  | 'spectator';

export type ServerMessage =
  | {
      t: 'welcome';
      code: string;
      role: Role;
      /** Which side this connection plays, or null for spectators. */
      seat: Player | null;
      state: MatchState;
      players: readonly PlayerInfo[];
      /** Wins per seat across rematches in this room: [p1, p2]. */
      score: readonly [number, number];
    }
  | { t: 'players'; players: readonly PlayerInfo[] }
  | { t: 'resolve'; record: ShotRecord; state: MatchState; score: readonly [number, number] }
  | { t: 'rematch'; state: MatchState; by: Player }
  | { t: 'error'; code: ServerErrorCode; message: string }
  | { t: 'pong'; ts: number };

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

/** Crockford-ish: no O/0/I/1/U, so codes survive being read aloud. */
export const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTVWXYZ';
export const ROOM_CODE_LENGTH = 5;

export function generateRoomCode(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    out += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)] ?? '2';
  }
  return out;
}

/** Upper-cases and maps look-alike characters onto the alphabet. */
export function normalizeRoomCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/0/g, 'Q')
    .replace(/1/g, 'V')
    .replace(/U/g, 'W')
    .slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(code: string): boolean {
  return (
    code.length === ROOM_CODE_LENGTH &&
    [...code].every((ch) => ROOM_ALPHABET.includes(ch))
  );
}

export function roomPath(code: string): string {
  return `/api/room/${code}`;
}

export function challengeUrl(origin: string, code: string): string {
  return `${origin}/#/r/${code}`;
}
