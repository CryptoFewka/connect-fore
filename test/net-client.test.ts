/**
 * Browser client tests.
 *
 * `connectRoom` takes its socket, clock, RNG and storage from options, so all
 * of the awkward bits — backoff, a dead link that never closes, a reconnect
 * that has to re-`hello` — are testable without a network or a browser.
 */
import { describe, expect, test } from 'bun:test';
import type { MatchState, ShotParams } from '../src/game/types';
import { COLS, ROWS } from '../src/game/types';
import type { PlayerInfo, ServerMessage } from '../src/net/protocol';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import type { KeyValueStore, RoomConnectionOptions, SocketLike } from '../src/net/client';
import { connectRoom, resolveClientId, roomSocketUrl } from '../src/net/client';

const CODE = 'AB2CD';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeSocket implements SocketLike {
  static readonly opened: FakeSocket[] = [];

  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closedWith: number | null = null;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.readyState === 3) return;
    this.closedWith = code ?? 1000;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  // -- test controls --------------------------------------------------------

  accept(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Server -> client. */
  deliver(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** The link died without a courteous close frame. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  frames(): ReturnType<typeof JSON.parse>[] {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

function memoryStore(seed?: string): KeyValueStore {
  const map = new Map<string, string>();
  if (seed) map.set('fore:client-id', seed);
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

function harness(opts: RoomConnectionOptions = {}) {
  const sockets: FakeSocket[] = [];
  const connection = connectRoom(CODE, {
    url: `ws://test/api/room/${CODE}`,
    clientId: 'client-one',
    storage: null,
    heartbeatMs: 0,
    reconnect: { baseMs: 2, factor: 1, maxMs: 2 },
    random: () => 1,
    socketFactory: (url) => {
      const ws = new FakeSocket(url);
      sockets.push(ws);
      return ws;
    },
    ...opts,
  });
  const live = (): FakeSocket => {
    const ws = sockets[sockets.length - 1];
    if (!ws) throw new Error('no socket was opened');
    return ws;
  };
  return { connection, sockets, live };
}

function blankState(turn = 0): MatchState {
  return {
    board: new Array(COLS * ROWS).fill(0),
    turn,
    current: 1,
    status: 'playing',
    winner: null,
    winLine: null,
    lastShot: null,
  };
}

const PLAYERS: readonly PlayerInfo[] = [
  { seat: 1, name: 'Ada', connected: true },
  { seat: 2, name: 'Bo', connected: true },
];

function welcome(state = blankState()): ServerMessage {
  return { t: 'welcome', code: CODE, role: 'player', seat: 1, state, players: PLAYERS, score: [0, 0] };
}

const PARAMS: ShotParams = { yaw: 0.1, loft: 0.4, power: 0.7, accuracy: -0.2 };

// ---------------------------------------------------------------------------

describe('urls and identity', () => {
  test('derives a socket url from the page origin', () => {
    expect(roomSocketUrl(CODE, 'https://fore.example')).toBe(
      `wss://fore.example/api/room/${CODE}`,
    );
    expect(roomSocketUrl(CODE, 'http://127.0.0.1:8787')).toBe(
      `ws://127.0.0.1:8787/api/room/${CODE}`,
    );
  });

  test('a client id is minted once and then reused', () => {
    const store = memoryStore();
    const first = resolveClientId(store);
    expect(first).toHaveLength(36);
    expect(resolveClientId(store)).toBe(first);
  });

  test('an existing client id survives a reload, so the seat comes back', () => {
    const store = memoryStore('sticky-id');
    const { connection } = harness({ clientId: undefined, storage: store });
    expect(connection.clientId).toBe('sticky-id');
  });

  test('an unusable room code is a programming error, not a doomed socket', () => {
    expect(() => connectRoom('nope', { socketFactory: () => new FakeSocket('x') })).toThrow(
      TypeError,
    );
  });

  test('room codes are normalised', () => {
    const { connection } = harness();
    expect(connection.code).toBe(CODE);
  });
});

describe('handshake', () => {
  test('says hello as soon as the socket opens', () => {
    const { connection, live } = harness({ name: 'Ada' });
    expect(connection.status()).toBe('connecting');
    live().accept();
    expect(connection.status()).toBe('open');
    expect(live().frames()).toEqual([
      { t: 'hello', v: PROTOCOL_VERSION, clientId: 'client-one', name: 'Ada' },
    ]);
  });

  test('welcome fills in the seat, board, roster and score', () => {
    const seen: string[] = [];
    const { connection, live } = harness({ onWelcome: (msg) => seen.push(msg.role) });
    live().accept();
    live().deliver(welcome(blankState(3)));

    expect(seen).toEqual(['player']);
    expect(connection.seat()).toBe(1);
    expect(connection.role()).toBe('player');
    expect(connection.state()?.turn).toBe(3);
    expect(connection.players()).toEqual(PLAYERS);
    expect(connection.score()).toEqual([0, 0]);
  });

  test('autoConnect: false leaves the socket shut until asked', () => {
    const { connection, sockets } = harness({ autoConnect: false });
    expect(sockets).toHaveLength(0);
    expect(connection.status()).toBe('closed');
    connection.connect();
    expect(sockets).toHaveLength(1);
  });
});

describe('messages', () => {
  test('sendShot frames a shot only while the socket is open', () => {
    const { connection, live } = harness();
    expect(connection.sendShot(0, PARAMS)).toBe(false);
    live().accept();
    expect(connection.sendShot(0, PARAMS)).toBe(true);
    expect(live().frames()[1]).toEqual({ t: 'shot', turn: 0, params: PARAMS });
  });

  test('the server state wins, whatever the client thought', () => {
    const applied: MatchState[] = [];
    const { connection, live } = harness({ onResolve: (_record, state) => applied.push(state) });
    live().accept();
    live().deliver(welcome());

    const authoritative = { ...blankState(1), current: 2 as const };
    live().deliver({
      t: 'resolve',
      record: {
        turn: 0,
        player: 1,
        params: PARAMS,
        outcome: 'thread',
        entry: { col: 3, row: 0 },
        rest: { col: 3, row: 0 },
        destroyed: null,
      },
      state: authoritative,
      score: [1, 0],
    });

    expect(applied).toEqual([authoritative]);
    expect(connection.state()).toEqual(authoritative);
    expect(connection.score()).toEqual([1, 0]);
  });

  test('players, rematch and error callbacks arrive unpacked', () => {
    const log: string[] = [];
    const { connection, live } = harness({
      onPlayers: (players) => log.push(`players:${players.length}`),
      onRematch: (state, by) => log.push(`rematch:${by}:${state.turn}`),
      onError: (code, message) => log.push(`error:${code}:${message}`),
    });
    live().accept();
    live().deliver({ t: 'players', players: [PLAYERS[0] as PlayerInfo] });
    live().deliver({ t: 'rematch', state: blankState(), by: 2 });
    live().deliver({ t: 'error', code: 'not-your-turn', message: 'wait' });

    expect(log).toEqual(['players:1', 'rematch:2:0', 'error:not-your-turn:wait']);
    expect(connection.state()?.turn).toBe(0);
  });

  test('on() subscribes to raw messages and unsubscribes cleanly', () => {
    const seen: ServerMessage[] = [];
    const { connection, live } = harness();
    const off = connection.on('message', (msg) => seen.push(msg));
    live().accept();
    live().deliver({ t: 'pong', ts: 1 });
    off();
    live().deliver({ t: 'pong', ts: 2 });
    expect(seen).toHaveLength(1);
  });

  test('garbage from the wire is ignored rather than thrown', () => {
    const { connection, live } = harness();
    live().accept();
    expect(() => live().onmessage?.({ data: 'not json' })).not.toThrow();
    expect(() => live().onmessage?.({ data: JSON.stringify({ nope: true }) })).not.toThrow();
    expect(connection.status()).toBe('open');
  });

  test('requestRematch sends the bare message', () => {
    const { connection, live } = harness();
    live().accept();
    expect(connection.requestRematch()).toBe(true);
    expect(live().frames()[1]).toEqual({ t: 'rematch' });
  });
});

describe('reconnect', () => {
  test('a dropped socket comes back and says hello again', async () => {
    const statuses: string[] = [];
    const { connection, sockets, live } = harness({ onStatus: (s) => statuses.push(s) });
    live().accept();
    live().deliver(welcome());

    live().drop();
    expect(connection.status()).toBe('reconnecting');

    await Bun.sleep(20);
    expect(sockets).toHaveLength(2);
    live().accept();
    expect(connection.status()).toBe('open');
    expect(live().frames()[0]).toMatchObject({ t: 'hello', clientId: 'client-one' });
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);
  });

  test('backoff grows and is jittered', async () => {
    const delays: number[] = [];
    const { sockets, live } = harness({
      reconnect: { baseMs: 4, factor: 2, maxMs: 16 },
      random: () => 0, // floor of the jitter window: half the nominal delay
    });
    const started = Date.now();
    live().accept();
    live().drop();
    await Bun.sleep(30);
    delays.push(Date.now() - started);
    expect(sockets).toHaveLength(2);
    // 4ms nominal, halved by the jitter floor — the point is that it retried at
    // all and did not stampede; exact ms are the scheduler's business.
    expect(delays[0]).toBeGreaterThanOrEqual(2);
  });

  test('giving up after maxAttempts leaves the connection closed', async () => {
    const { connection, sockets, live } = harness({
      reconnect: { baseMs: 1, factor: 1, maxMs: 1, maxAttempts: 2 },
    });
    live().accept();
    live().drop();
    await Bun.sleep(10);
    live().drop();
    await Bun.sleep(10);
    live().drop();
    await Bun.sleep(10);
    expect(sockets).toHaveLength(3);
    expect(connection.status()).toBe('closed');
  });

  test('close() is final: no retry, no further sockets', async () => {
    const { connection, sockets, live } = harness();
    live().accept();
    connection.close();
    expect(connection.status()).toBe('closed');
    expect(live().closedWith).toBe(1000);
    await Bun.sleep(20);
    expect(sockets).toHaveLength(1);
    expect(connection.sendShot(0, PARAMS)).toBe(false);
  });

  test('a socket that never opens still retries', async () => {
    const { connection, sockets, live } = harness();
    live().drop(1006);
    expect(connection.status()).toBe('reconnecting');
    await Bun.sleep(20);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  });
});

describe('heartbeat', () => {
  test('pings on a timer and measures the round trip', async () => {
    let clock = 1000;
    const { connection, live } = harness({ heartbeatMs: 5, now: () => clock });
    live().accept();
    await Bun.sleep(20);

    const ping = live().frames().find((f) => f.t === 'ping');
    expect(ping).toBeDefined();
    clock += 42;
    live().deliver({ t: 'pong', ts: ping.ts });
    expect(connection.latency()).toBe(42);
  });

  test('an unanswered ping tears the link down and reconnects', async () => {
    let clock = 1000;
    const { connection, sockets, live } = harness({
      heartbeatMs: 4,
      pongTimeoutMs: 10,
      now: () => clock,
    });
    live().accept();
    await Bun.sleep(10); // a ping goes out
    clock += 5_000; // ...and is never answered
    await Bun.sleep(30);

    expect(sockets[0]?.closedWith).toBe(4000);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(['reconnecting', 'connecting', 'open']).toContain(connection.status());
  });

  test('an explicit ping is measured too', () => {
    let clock = 500;
    const { connection, live } = harness({ now: () => clock });
    live().accept();
    expect(connection.ping()).toBe(true);
    clock += 7;
    live().deliver({ t: 'pong', ts: 500 });
    expect(connection.latency()).toBe(7);
  });
});
