/**
 * The room's decision logic, as a pure function.
 *
 * `GameRoom` (the Durable Object in `./room.ts`) is deliberately a thin shell:
 * it owns sockets, hibernation attachments, storage and the idle alarm, and
 * defers every *decision* to `handleMessage` below. Nothing in this module
 * touches the Workers runtime, the clock or the network, so `bun test` can
 * drive a whole match — reconnects, rejected shots, rematches — with plain
 * objects and no Workers runtime at all.
 *
 * The match simulation itself arrives as a `MatchEngine` rather than an import
 * so the reducer stays independent of `src/game/match.ts`; the Durable Object
 * passes the real one in.
 */
import type { MatchState, Player, ShotParams, ShotRecord } from '../src/game/types';
import type {
  ClientMessage,
  PlayerInfo,
  Role,
  ServerErrorCode,
  ServerMessage,
} from '../src/net/protocol';
import { PROTOCOL_VERSION } from '../src/net/protocol';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The pure simulation, exactly as `src/game/match.ts` exports it. Injected so
 * this module (and its tests) never depend on that file directly.
 */
export interface MatchEngine {
  newMatch(): MatchState;
  applyShot(state: MatchState, params: ShotParams): { state: MatchState; record: ShotRecord };
  /**
   * Optional: fresh board for a rematch, given the match that just ended (the
   * loser tees off). Falls back to `newMatch` when the engine does not offer it.
   */
  rematchMatch?(previous: MatchState): MatchState;
}

/** A claimed seat. Survives disconnects so the same `clientId` can reclaim it. */
export interface SeatState {
  readonly clientId: string;
  readonly name: string;
  readonly connected: boolean;
}

/** Everything about a room that must outlive hibernation and eviction. */
export interface RoomState {
  /** Storage schema version, so a future shape change can migrate. */
  readonly version: number;
  readonly code: string;
  readonly match: MatchState;
  /** Wins per seat across rematches: `[p1, p2]`. */
  readonly score: readonly [number, number];
  /** Index 0 is seat 1, index 1 is seat 2. */
  readonly seats: readonly [SeatState | null, SeatState | null];
  /** Pending rematch agreement, per seat. */
  readonly rematch: readonly [boolean, boolean];
  /** Wall clock of the last meaningful activity; drives the idle alarm. */
  readonly updatedAt: number;
}

/** Per-socket identity. Mirrored into the socket's hibernation attachment. */
export interface Session {
  readonly clientId: string;
  readonly name: string;
  readonly seat: Player | null;
  readonly role: Role;
  /** Whether this socket has completed the `hello` handshake. */
  readonly hello: boolean;
}

export type Target =
  /** Just the socket that sent the message being handled. */
  | 'sender'
  /** Every live socket in the room, including the sender. */
  | 'all'
  /** Every live socket except the sender. */
  | 'others';

export interface Outbound {
  readonly to: Target;
  readonly msg: ServerMessage;
}

export interface RoomStep {
  readonly room: RoomState;
  readonly session: Session;
  readonly out: readonly Outbound[];
  /** True when `room` differs from the input and must be persisted. */
  readonly dirty: boolean;
}

export interface RoomContext {
  readonly engine: MatchEngine;
  /** `Date.now()` at the edge. The reducer never reads the clock itself. */
  readonly now: number;
}

/** A room with no traffic for this long is deleted by the alarm. */
export const IDLE_ROOM_MS = 2 * 60 * 60 * 1000;
export const ROOM_STATE_VERSION = 1;

const MAX_NAME = 24;
const MAX_CLIENT_ID = 64;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createRoomState(code: string, ctx: RoomContext): RoomState {
  return {
    version: ROOM_STATE_VERSION,
    code,
    match: ctx.engine.newMatch(),
    score: [0, 0],
    seats: [null, null],
    rematch: [false, false],
    updatedAt: ctx.now,
  };
}

export function anonymousSession(): Session {
  return { clientId: '', name: '', seat: null, role: 'spectator', hello: false };
}

/** The HUD's view of who is in the room. Spectators are deliberately absent. */
export function playersOf(room: RoomState): PlayerInfo[] {
  const out: PlayerInfo[] = [];
  for (let i = 0; i < room.seats.length; i++) {
    const seat = room.seats[i];
    if (seat) out.push({ seat: (i + 1) as Player, name: seat.name, connected: seat.connected });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSender(msg: ServerMessage): Outbound {
  return { to: 'sender', msg };
}

function toAll(msg: ServerMessage): Outbound {
  return { to: 'all', msg };
}

function toOthers(msg: ServerMessage): Outbound {
  return { to: 'others', msg };
}

function fail(
  room: RoomState,
  session: Session,
  code: ServerErrorCode,
  message: string,
): RoomStep {
  return { room, session, out: [toSender({ t: 'error', code, message })], dirty: false };
}

function quiet(room: RoomState, session: Session): RoomStep {
  return { room, session, out: [], dirty: false };
}

function clean(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // Drop control characters so a name can never smuggle newlines into a HUD.
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out.trim().slice(0, max);
}

function isFinitely(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validParams(params: unknown): params is ShotParams {
  if (typeof params !== 'object' || params === null) return false;
  const p = params as Record<string, unknown>;
  return isFinitely(p.yaw) && isFinitely(p.loft) && isFinitely(p.power) && isFinitely(p.accuracy);
}

function seatIndexOf(room: RoomState, clientId: string): 0 | 1 | null {
  if (room.seats[0]?.clientId === clientId) return 0;
  if (room.seats[1]?.clientId === clientId) return 1;
  return null;
}

function withSeat(
  room: RoomState,
  index: 0 | 1,
  seat: SeatState | null,
  now: number,
): RoomState {
  const seats: [SeatState | null, SeatState | null] = [room.seats[0], room.seats[1]];
  seats[index] = seat;
  return { ...room, seats, updatedAt: now };
}

function withRematch(room: RoomState, votes: [boolean, boolean]): RoomState {
  return { ...room, rematch: votes };
}

/** True when the other seat is taken by a live opponent whose game this also is. */
function opponentPresent(room: RoomState, index: 0 | 1): boolean {
  const other = room.seats[index === 0 ? 1 : 0];
  return other !== null && other.connected;
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/**
 * Handle one client message.
 *
 * Returns the (possibly unchanged) room, the (possibly re-seated) session for
 * the sending socket, and the messages the shell should deliver. The reducer
 * never throws: malformed input becomes an `error` message.
 */
export function handleMessage(
  room: RoomState,
  session: Session,
  msg: ClientMessage,
  ctx: RoomContext,
): RoomStep {
  if (typeof msg !== 'object' || msg === null || typeof (msg as { t?: unknown }).t !== 'string') {
    return fail(room, session, 'bad-message', 'unrecognised message');
  }

  switch (msg.t) {
    case 'ping':
      return {
        room,
        session,
        out: [toSender({ t: 'pong', ts: isFinitely(msg.ts) ? msg.ts : ctx.now })],
        dirty: false,
      };
    case 'hello':
      return handleHello(room, session, msg, ctx);
    case 'shot':
      return handleShot(room, session, msg, ctx);
    case 'rematch':
      return handleRematch(room, session, ctx);
    default:
      return fail(room, session, 'bad-message', `unknown message type`);
  }
}

function handleHello(
  room: RoomState,
  session: Session,
  msg: Extract<ClientMessage, { t: 'hello' }>,
  ctx: RoomContext,
): RoomStep {
  if (msg.v !== PROTOCOL_VERSION) {
    return fail(
      room,
      session,
      'bad-version',
      `room speaks protocol ${PROTOCOL_VERSION}; reload the page`,
    );
  }

  const clientId = clean(msg.clientId, MAX_CLIENT_ID);
  if (!clientId) return fail(room, session, 'bad-message', 'hello needs a clientId');

  if (session.hello) {
    // A second hello on the same socket is only ever a retry. Re-send the
    // welcome so a confused client resyncs; changing identity mid-socket is not
    // allowed, because the seat bookkeeping is keyed off the first one.
    if (session.clientId !== clientId) {
      return fail(room, session, 'bad-message', 'this socket already said hello');
    }
    return { room, session, out: [toSender(welcome(room, session))], dirty: false };
  }

  const existing = seatIndexOf(room, clientId);
  const free: 0 | 1 | null = room.seats[0] === null ? 0 : room.seats[1] === null ? 1 : null;
  const index = existing ?? free;

  if (index === null) {
    // Both seats belong to other people: watch, but shots will be refused.
    const spectator: Session = { clientId, name: clean(msg.name, MAX_NAME) || 'Spectator', seat: null, role: 'spectator', hello: true };
    return {
      room,
      session: spectator,
      out: [
        toSender(welcome(room, spectator)),
        toSender({ t: 'error', code: 'room-full', message: 'both seats are taken — watching' }),
      ],
      dirty: false,
    };
  }

  const seatNumber = (index + 1) as Player;
  const name = clean(msg.name, MAX_NAME) || room.seats[index]?.name || `Player ${seatNumber}`;
  const next = withSeat(room, index, { clientId, name, connected: true }, ctx.now);
  const seated: Session = { clientId, name, seat: seatNumber, role: 'player', hello: true };

  return {
    room: next,
    session: seated,
    out: [toSender(welcome(next, seated)), toOthers({ t: 'players', players: playersOf(next) })],
    dirty: true,
  };
}

function welcome(room: RoomState, session: Session): ServerMessage {
  return {
    t: 'welcome',
    code: room.code,
    role: session.role,
    seat: session.seat,
    state: room.match,
    players: playersOf(room),
    score: room.score,
  };
}

function handleShot(
  room: RoomState,
  session: Session,
  msg: Extract<ClientMessage, { t: 'shot' }>,
  ctx: RoomContext,
): RoomStep {
  if (!session.hello) return fail(room, session, 'bad-message', 'say hello first');
  if (session.seat === null || session.role !== 'player') {
    return fail(room, session, 'spectator', 'only seated players can swing');
  }
  if (room.match.status !== 'playing') {
    return fail(room, session, 'match-over', 'this match is finished — ask for a rematch');
  }
  if (!isFinitely(msg.turn) || msg.turn !== room.match.turn) {
    // Covers double-clicks, retried sends after a reconnect, and any client
    // that has drifted ahead. Either way the client should trust the last
    // `resolve`/`welcome` state it saw rather than re-send.
    return fail(
      room,
      session,
      'stale-turn',
      `shot was for turn ${String(msg.turn)}; the room is on turn ${room.match.turn}`,
    );
  }
  if (room.match.current !== session.seat) {
    return fail(room, session, 'not-your-turn', 'wait for your opponent to play');
  }
  if (!validParams(msg.params)) {
    return fail(room, session, 'bad-message', 'shot params must be four finite numbers');
  }

  const { state, record } = ctx.engine.applyShot(room.match, {
    yaw: msg.params.yaw,
    loft: msg.params.loft,
    power: msg.params.power,
    accuracy: msg.params.accuracy,
  });

  const score: [number, number] = [room.score[0], room.score[1]];
  if (state.status === 'won' && state.winner !== null) {
    const winner = (state.winner - 1) as 0 | 1;
    score[winner] += 1;
  }

  const next: RoomState = {
    ...room,
    match: state,
    score,
    // Any real progress invalidates a stale rematch offer.
    rematch: [false, false],
    updatedAt: ctx.now,
  };

  return {
    room: next,
    session,
    out: [toAll({ t: 'resolve', record, state, score })],
    dirty: true,
  };
}

/**
 * Rematch policy:
 *  - Once a match is over (`won`/`draw`), a single request from either seated
 *    player resets the board immediately. There is nothing left to lose and the
 *    protocol has no "waiting for opponent" message, so instant feedback wins.
 *  - While a match is still `playing`, both seats must ask (a mutual restart);
 *    one request just records the vote and stays silent so nobody can wipe a
 *    live board on their own.
 *  - A lone player in the room always resets immediately: there is nobody to
 *    agree with.
 * Either way the running score survives.
 */
function handleRematch(room: RoomState, session: Session, ctx: RoomContext): RoomStep {
  if (!session.hello) return fail(room, session, 'bad-message', 'say hello first');
  if (session.seat === null || session.role !== 'player') {
    return fail(room, session, 'spectator', 'only seated players can call a rematch');
  }

  const index = (session.seat - 1) as 0 | 1;
  const votes: [boolean, boolean] = [room.rematch[0], room.rematch[1]];
  votes[index] = true;

  const mutualNeeded = room.match.status === 'playing' && opponentPresent(room, index);
  const agreed = !mutualNeeded || votes[index === 0 ? 1 : 0];

  if (!agreed) {
    return { room: withRematch(room, votes), session, out: [], dirty: true };
  }

  const state = ctx.engine.rematchMatch
    ? ctx.engine.rematchMatch(room.match)
    : ctx.engine.newMatch();
  const next: RoomState = {
    ...room,
    match: state,
    rematch: [false, false],
    updatedAt: ctx.now,
  };

  return {
    room: next,
    session,
    out: [toAll({ t: 'rematch', state, by: session.seat })],
    dirty: true,
  };
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/**
 * A socket went away. `seatStillHeld` is true when another live socket is still
 * signed in as the same `clientId` (a client that reconnected before the old
 * socket's close event landed), in which case the seat stays lit.
 */
export function handleDisconnect(
  room: RoomState,
  session: Session,
  opts: { readonly seatStillHeld: boolean },
  ctx: RoomContext,
): RoomStep {
  if (session.seat === null) return quiet(room, session);
  const index = (session.seat - 1) as 0 | 1;
  const seat = room.seats[index];
  if (!seat || seat.clientId !== session.clientId) return quiet(room, session);
  if (opts.seatStillHeld) return quiet(room, session);
  if (!seat.connected) return quiet(room, session);

  // Drop any pending rematch offer: the player is not there to honour it.
  const votes: [boolean, boolean] = [room.rematch[0], room.rematch[1]];
  votes[index] = false;

  const next = withRematch(
    withSeat(room, index, { ...seat, connected: false }, ctx.now),
    votes,
  );

  return {
    room: next,
    session,
    out: [toOthers({ t: 'players', players: playersOf(next) })],
    dirty: true,
  };
}

/** True when the room has been silent long enough for the alarm to bin it. */
export function isIdle(room: RoomState, now: number, liveSockets: number): boolean {
  return liveSockets === 0 && now - room.updatedAt >= IDLE_ROOM_MS;
}
