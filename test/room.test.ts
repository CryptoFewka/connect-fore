/**
 * Room reducer tests.
 *
 * `worker/match-room.ts` is the whole brain of the Durable Object, and it is
 * pure, so a full match — bad handshakes, refused shots, a drop and a reclaim,
 * two rematches — runs here in milliseconds with no Workers runtime.
 *
 * The match simulation is stubbed on purpose. Real shots are physics, and a
 * test that wants "player one now wins" should be able to say so; the stub
 * treats `yaw` as the target column and `accuracy === 1` as "this one wins".
 */
import { describe, expect, test } from 'bun:test';
import type { Cell, MatchState, Player, ShotOutcome, ShotParams } from '../src/game/types';
import { COLS, ROWS } from '../src/game/types';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import type { ClientMessage, ServerMessage } from '../src/net/protocol';
import type { MatchEngine, Outbound, RoomState, RoomStep, Session } from '../worker/match-room';
import {
  anonymousSession,
  createRoomState,
  handleDisconnect,
  handleMessage,
  IDLE_ROOM_MS,
  isIdle,
  playersOf,
} from '../worker/match-room';

// ---------------------------------------------------------------------------
// A stand-in for src/game/match.ts
// ---------------------------------------------------------------------------

function blankMatch(first: Player = 1): MatchState {
  return {
    board: new Array<Cell>(COLS * ROWS).fill(0),
    turn: 0,
    current: first,
    status: 'playing',
    winner: null,
    winLine: null,
    lastShot: null,
  };
}

const stubEngine: MatchEngine = {
  newMatch: () => blankMatch(),
  rematchMatch: (previous) => blankMatch(previous.winner === 1 ? 2 : 1),
  applyShot(state, params) {
    const col = Math.max(0, Math.min(COLS - 1, Math.round(params.yaw)));
    const board: Cell[] = [...state.board];
    let outcome: ShotOutcome = 'bounce';
    let rest: { col: number; row: number } | null = null;

    // power === 0 is the stub's "missed the board entirely".
    if (params.power > 0) {
      for (let row = 0; row < ROWS; row++) {
        if (board[row * COLS + col] === 0) {
          board[row * COLS + col] = state.current;
          rest = { col, row };
          outcome = 'thread';
          break;
        }
      }
    }

    const wins = outcome === 'thread' && params.accuracy === 1;
    const record = { turn: state.turn, player: state.current, params, outcome, entry: rest, rest };

    return {
      record,
      state: {
        board,
        turn: state.turn + 1,
        current: state.current === 1 ? 2 : 1,
        status: wins ? 'won' : 'playing',
        winner: wins ? state.current : null,
        winLine: wins ? ([0, 1, 2, 3] as const) : null,
        lastShot: record,
      },
    };
  },
};

const CTX = { engine: stubEngine, now: 1_000 } as const;

function shot(col: number, opts: { win?: boolean; miss?: boolean } = {}): ShotParams {
  return { yaw: col, loft: 0.4, power: opts.miss ? 0 : 0.8, accuracy: opts.win ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Harness — one room, a handful of sockets, exactly as the DO holds them
// ---------------------------------------------------------------------------

/** One connected socket: the reducer's per-socket session, kept up to date. */
interface Client {
  session: Session;
}

class Table {
  room: RoomState = createRoomState('AB2CD', CTX);

  /** A socket connects and says hello. */
  join(clientId: string, name?: string): { client: Client; step: RoomStep } {
    const client: Client = { session: anonymousSession() };
    const hello: ClientMessage = name
      ? { t: 'hello', v: PROTOCOL_VERSION, clientId, name }
      : { t: 'hello', v: PROTOCOL_VERSION, clientId };
    return { client, step: this.say(client, hello) };
  }

  say(client: Client, msg: ClientMessage): RoomStep {
    const step = handleMessage(this.room, client.session, msg, CTX);
    this.room = step.room;
    client.session = step.session;
    return step;
  }

  /** The socket went away for good (nobody else holds the seat). */
  leave(client: Client): RoomStep {
    const step = handleDisconnect(this.room, client.session, { seatStillHeld: false }, CTX);
    this.room = step.room;
    return step;
  }
}

/** A table with both seats taken. */
function seated(): { table: Table; one: Client; two: Client } {
  const table = new Table();
  const one = table.join('client-one', 'Ada').client;
  const two = table.join('client-two', 'Bo').client;
  return { table, one, two };
}

function errorOf(step: RoomStep): { code: string; message: string } | null {
  for (const item of step.out) {
    if (item.msg.t === 'error') return { code: item.msg.code, message: item.msg.message };
  }
  return null;
}

function pick<K extends ServerMessage['t']>(
  step: RoomStep,
  t: K,
): (Outbound & { msg: Extract<ServerMessage, { t: K }> }) | undefined {
  return step.out.find((item): item is Outbound & { msg: Extract<ServerMessage, { t: K }> } =>
    item.msg.t === t,
  );
}

// ---------------------------------------------------------------------------

describe('handshake and seating', () => {
  test('the first two distinct clients get seats one and two', () => {
    const table = new Table();

    const first = table.join('client-one', 'Ada');
    expect(first.client.session.seat).toBe(1);
    expect(first.client.session.role).toBe('player');
    expect(pick(first.step, 'welcome')?.msg).toMatchObject({
      t: 'welcome',
      code: 'AB2CD',
      role: 'player',
      seat: 1,
      score: [0, 0],
    });
    expect(first.step.dirty).toBe(true);

    const second = table.join('client-two', 'Bo');
    expect(second.client.session.seat).toBe(2);
    expect(playersOf(table.room)).toEqual([
      { seat: 1, name: 'Ada', connected: true },
      { seat: 2, name: 'Bo', connected: true },
    ]);
    // The room tells the other side someone arrived, so the HUD can light up.
    expect(pick(second.step, 'players')?.to).toBe('others');
  });

  test('a third client watches and is told the room is full', () => {
    const { table } = seated();
    const { client, step } = table.join('client-three');
    expect(client.session.role).toBe('spectator');
    expect(client.session.seat).toBeNull();
    expect(pick(step, 'welcome')?.msg).toMatchObject({ role: 'spectator', seat: null });
    expect(errorOf(step)?.code).toBe('room-full');
    expect(step.dirty).toBe(false);
    expect(playersOf(table.room)).toHaveLength(2);
  });

  test('a wrong protocol version is refused before seating', () => {
    const table = new Table();
    const client: Client = { session: anonymousSession() };
    const step = table.say(client, {
      t: 'hello',
      v: PROTOCOL_VERSION + 1,
      clientId: 'client-one',
    });
    expect(errorOf(step)?.code).toBe('bad-version');
    expect(client.session.seat).toBeNull();
    expect(step.dirty).toBe(false);
  });

  test('hello without a client id is a bad message', () => {
    const table = new Table();
    const step = table.join('   ').step;
    expect(errorOf(step)?.code).toBe('bad-message');
  });

  test('a repeated hello re-sends welcome; a different identity is refused', () => {
    const table = new Table();
    const { client } = table.join('client-one');

    const repeat = table.say(client, { t: 'hello', v: PROTOCOL_VERSION, clientId: 'client-one' });
    expect(pick(repeat, 'welcome')?.msg).toMatchObject({ seat: 1 });
    expect(repeat.dirty).toBe(false);

    const swap = table.say(client, { t: 'hello', v: PROTOCOL_VERSION, clientId: 'someone-else' });
    expect(errorOf(swap)?.code).toBe('bad-message');
    expect(client.session.seat).toBe(1);
  });

  test('names are trimmed, capped and stripped of control characters', () => {
    const table = new Table();
    table.join('client-one', '  Ada\u0000Lovelace the exceedingly long  ');
    expect(playersOf(table.room)[0]?.name).toBe('AdaLovelace the exceedin');
  });
});

describe('shots', () => {
  test('a legal shot resolves to everyone and advances the turn', () => {
    const { table, one } = seated();
    const step = table.say(one, { t: 'shot', turn: 0, params: shot(3) });

    const resolve = pick(step, 'resolve');
    expect(resolve?.to).toBe('all');
    expect(resolve?.msg.record.player).toBe(1);
    expect(resolve?.msg.state.turn).toBe(1);
    expect(resolve?.msg.state.current).toBe(2);
    expect(resolve?.msg.score).toEqual([0, 0]);
    expect(table.room.match.turn).toBe(1);
    expect(step.dirty).toBe(true);
  });

  test('the player who is not on the clock is refused', () => {
    const { table, two } = seated();
    const step = table.say(two, { t: 'shot', turn: 0, params: shot(3) });
    expect(errorOf(step)?.code).toBe('not-your-turn');
    expect(step.dirty).toBe(false);
    expect(table.room.match.turn).toBe(0);
  });

  test('a duplicate shot for a turn already played is stale, not a second swing', () => {
    const { table, one } = seated();
    table.say(one, { t: 'shot', turn: 0, params: shot(3) });
    // The double-click, or a retry after a flaky send.
    const step = table.say(one, { t: 'shot', turn: 0, params: shot(3) });
    expect(errorOf(step)?.code).toBe('stale-turn');
    expect(table.room.match.turn).toBe(1);
    expect(table.room.match.board.filter((c) => c !== 0)).toHaveLength(1);
  });

  test('a client that has run ahead of the room is stale too', () => {
    const { table, one } = seated();
    const step = table.say(one, { t: 'shot', turn: 7, params: shot(3) });
    expect(errorOf(step)?.code).toBe('stale-turn');
  });

  test('spectators cannot swing', () => {
    const { table } = seated();
    const { client } = table.join('client-three');
    const step = table.say(client, { t: 'shot', turn: 0, params: shot(3) });
    expect(errorOf(step)?.code).toBe('spectator');
  });

  test('a socket that skipped hello cannot swing', () => {
    const table = new Table();
    const step = table.say({ session: anonymousSession() }, {
      t: 'shot',
      turn: 0,
      params: shot(3),
    });
    expect(errorOf(step)?.code).toBe('bad-message');
  });

  test('shots after the final ball are refused', () => {
    const { table, one, two } = seated();
    table.say(one, { t: 'shot', turn: 0, params: shot(3, { win: true }) });
    expect(table.room.match.status).toBe('won');

    const step = table.say(two, { t: 'shot', turn: 1, params: shot(4) });
    expect(errorOf(step)?.code).toBe('match-over');
  });

  test('params that are not four finite numbers are refused', () => {
    const { table, one } = seated();
    const step = table.say(one, {
      t: 'shot',
      turn: 0,
      params: { yaw: 0, loft: 0, power: Number.NaN, accuracy: 0 },
    });
    expect(errorOf(step)?.code).toBe('bad-message');
  });

  test('a missed shot still forfeits the turn', () => {
    const { table, one } = seated();
    const step = table.say(one, { t: 'shot', turn: 0, params: shot(3, { miss: true }) });
    expect(pick(step, 'resolve')?.msg.record.outcome).toBe('bounce');
    expect(table.room.match.current).toBe(2);
    expect(table.room.match.board.every((c) => c === 0)).toBe(true);
  });
});

describe('reconnect', () => {
  test('a dropped player is greyed out but keeps the seat', () => {
    const { table, one } = seated();
    const step = table.leave(one);
    expect(step.dirty).toBe(true);
    expect(playersOf(table.room)).toEqual([
      { seat: 1, name: 'Ada', connected: false },
      { seat: 2, name: 'Bo', connected: true },
    ]);
    expect(pick(step, 'players')?.to).toBe('others');
  });

  test('the same client id reclaims its seat mid-match', () => {
    const { table, one, two } = seated();
    table.say(one, { t: 'shot', turn: 0, params: shot(3) });
    table.leave(one);

    const back = table.join('client-one', 'Ada');
    expect(back.client.session.seat).toBe(1);
    expect(back.client.session.role).toBe('player');
    // The reconnecting client is handed the live board, not a fresh one.
    const welcome = pick(back.step, 'welcome')?.msg;
    expect(welcome?.state.turn).toBe(1);
    expect(welcome?.state.board.filter((c) => c !== 0)).toHaveLength(1);
    expect(playersOf(table.room)[0]?.connected).toBe(true);

    // ...and can carry on playing once it is their turn again.
    table.say(two, { t: 'shot', turn: 1, params: shot(4) });
    const resumed = table.say(back.client, { t: 'shot', turn: 2, params: shot(5) });
    expect(pick(resumed, 'resolve')).toBeDefined();
    expect(table.room.match.turn).toBe(3);
  });

  test('a stranger cannot steal a seat that is merely disconnected', () => {
    const { table, one } = seated();
    table.leave(one);
    expect(table.join('client-three').client.session.role).toBe('spectator');
  });

  test('a seat already reclaimed by a newer socket is not dimmed by the old close', () => {
    const { table, one } = seated();
    const step = handleDisconnect(table.room, one.session, { seatStillHeld: true }, CTX);
    expect(step.dirty).toBe(false);
    expect(playersOf(step.room)[0]?.connected).toBe(true);
  });

  test('disconnecting twice is harmless', () => {
    const { table, one } = seated();
    table.leave(one);
    const twice = table.leave(one);
    expect(twice.dirty).toBe(false);
    expect(twice.out).toHaveLength(0);
  });

  test('a spectator leaving says nothing', () => {
    const { table } = seated();
    const { client } = table.join('client-three');
    const step = table.leave(client);
    expect(step.out).toHaveLength(0);
    expect(step.dirty).toBe(false);
  });
});

describe('rematch', () => {
  test('after a win, one request is enough and the score carries over', () => {
    const { table, one, two } = seated();
    table.say(one, { t: 'shot', turn: 0, params: shot(3, { win: true }) });
    expect(table.room.score).toEqual([1, 0]);

    const step = table.say(two, { t: 'rematch' });
    const rematch = pick(step, 'rematch');
    expect(rematch?.to).toBe('all');
    expect(rematch?.msg.by).toBe(2);
    expect(rematch?.msg.state.turn).toBe(0);
    // Loser tees off, courtesy of the engine's rematch hook.
    expect(rematch?.msg.state.current).toBe(2);
    expect(table.room.match.board.every((c) => c === 0)).toBe(true);
    expect(table.room.score).toEqual([1, 0]);

    // Second match, the other way round.
    table.say(two, { t: 'shot', turn: 0, params: shot(3, { win: true }) });
    expect(table.room.score).toEqual([1, 1]);
    table.say(one, { t: 'rematch' });
    expect(table.room.score).toEqual([1, 1]);
    expect(table.room.match.status).toBe('playing');
  });

  test('mid-match a restart needs both players', () => {
    const { table, one, two } = seated();
    table.say(one, { t: 'shot', turn: 0, params: shot(3) });

    const offered = table.say(one, { t: 'rematch' });
    expect(offered.out).toHaveLength(0);
    expect(table.room.rematch).toEqual([true, false]);
    expect(table.room.match.turn).toBe(1);

    const agreed = table.say(two, { t: 'rematch' });
    expect(pick(agreed, 'rematch')).toBeDefined();
    expect(table.room.match.turn).toBe(0);
    expect(table.room.rematch).toEqual([false, false]);
  });

  test('a shot cancels a pending rematch offer', () => {
    const { table, one, two } = seated();
    table.say(two, { t: 'rematch' });
    expect(table.room.rematch).toEqual([false, true]);
    table.say(one, { t: 'shot', turn: 0, params: shot(3) });
    expect(table.room.rematch).toEqual([false, false]);
  });

  test('a player alone in the room may restart on their own', () => {
    const table = new Table();
    const { client } = table.join('client-one');
    expect(pick(table.say(client, { t: 'rematch' }), 'rematch')).toBeDefined();
  });

  test('a departed opponent does not block a restart', () => {
    const { table, one, two } = seated();
    table.leave(two);
    expect(pick(table.say(one, { t: 'rematch' }), 'rematch')).toBeDefined();
  });

  test('a disconnect withdraws that seat pending offer', () => {
    const { table, one, two } = seated();
    table.say(one, { t: 'rematch' });
    expect(table.room.rematch).toEqual([true, false]);
    table.leave(one);
    expect(table.room.rematch).toEqual([false, false]);
    // Player two asking now restarts (their opponent is away) rather than
    // silently completing a vote nobody is around to honour.
    expect(pick(table.say(two, { t: 'rematch' }), 'rematch')).toBeDefined();
  });

  test('spectators cannot call a rematch', () => {
    const { table } = seated();
    const { client } = table.join('client-three');
    expect(errorOf(table.say(client, { t: 'rematch' }))?.code).toBe('spectator');
  });
});

describe('housekeeping', () => {
  test('ping echoes the timestamp back to the sender only', () => {
    const { table, one } = seated();
    const step = table.say(one, { t: 'ping', ts: 12345 });
    expect(step.out).toEqual([{ to: 'sender', msg: { t: 'pong', ts: 12345 } }]);
    expect(step.dirty).toBe(false);
  });

  test('unknown message types are refused rather than thrown', () => {
    const { table, one } = seated();
    const step = table.say(one, { t: 'wat' } as unknown as ClientMessage);
    expect(errorOf(step)?.code).toBe('bad-message');
  });

  test('a room is idle only once it is empty and quiet', () => {
    const table = new Table();
    expect(isIdle(table.room, CTX.now + IDLE_ROOM_MS, 0)).toBe(true);
    expect(isIdle(table.room, CTX.now + IDLE_ROOM_MS, 1)).toBe(false);
    expect(isIdle(table.room, CTX.now + IDLE_ROOM_MS - 1, 0)).toBe(false);
  });

  test('activity pushes the idle deadline out', () => {
    const { table, one } = seated();
    table.say(one, { t: 'shot', turn: 0, params: shot(3) });
    expect(table.room.updatedAt).toBe(CTX.now);
    expect(isIdle(table.room, CTX.now + IDLE_ROOM_MS - 1, 0)).toBe(false);
  });
});
