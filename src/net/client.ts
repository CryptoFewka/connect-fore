/**
 * Browser side of the room protocol.
 *
 * A plain object with callbacks — no framework, no globals, no singletons — so
 * a game loop can poll `connection.status()` each frame and the HUD can
 * subscribe to events. Everything the server says is treated as truth: the
 * client never applies its own shot locally and hopes the room agrees, it waits
 * for the `resolve` broadcast and animates that.
 *
 * The socket looks after itself: exponential backoff with jitter on drop, a
 * heartbeat that notices a link that has gone quiet without closing, and a
 * `clientId` kept in `sessionStorage` so a refresh reclaims the same seat.
 */
import type { MatchState, Player, ShotParams, ShotRecord } from '../game/types';
import type { PlayerInfo, Role, ServerErrorCode, ServerMessage } from './protocol';
import { isValidRoomCode, normalizeRoomCode, PROTOCOL_VERSION, roomPath } from './protocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** The slice of `WebSocket` this module uses, so tests can inject a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/** Just enough of the `Storage` interface to remember a client id. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RoomEventMap {
  status: ConnectionStatus;
  welcome: Extract<ServerMessage, { t: 'welcome' }>;
  players: Extract<ServerMessage, { t: 'players' }>;
  resolve: Extract<ServerMessage, { t: 'resolve' }>;
  rematch: Extract<ServerMessage, { t: 'rematch' }>;
  error: Extract<ServerMessage, { t: 'error' }>;
  pong: Extract<ServerMessage, { t: 'pong' }>;
  /** Every server message, after the specific handlers have run. */
  message: ServerMessage;
}

export type RoomEvent = keyof RoomEventMap;
export type RoomListener<K extends RoomEvent> = (payload: RoomEventMap[K]) => void;
export type Unsubscribe = () => void;

export interface ReconnectOptions {
  /** First retry delay in ms. Default 500. */
  baseMs?: number;
  /** Multiplier per attempt. Default 1.8. */
  factor?: number;
  /** Ceiling for a single delay. Default 15000. */
  maxMs?: number;
  /** Give up after this many consecutive failures. Default Infinity. */
  maxAttempts?: number;
}

/**
 * Callbacks, unpacked into plain arguments so the integrator never has to
 * destructure a wire message. `on()` gives the raw messages instead.
 */
export interface RoomCallbacks {
  onStatus?(status: ConnectionStatus): void;
  onWelcome?(msg: RoomEventMap['welcome']): void;
  onPlayers?(players: readonly PlayerInfo[]): void;
  onResolve?(record: ShotRecord, state: MatchState, score: readonly [number, number]): void;
  onRematch?(state: MatchState, by: Player): void;
  onError?(code: ServerErrorCode, message: string): void;
  onPong?(ts: number, latencyMs: number): void;
  /** Every server message, raw, after the specific callback above has run. */
  onMessage?(msg: ServerMessage): void;
}

export interface RoomConnectionOptions extends RoomCallbacks {
  /** Display name sent with `hello`. */
  name?: string;
  /** Force a client id instead of the one in `sessionStorage`. */
  clientId?: string;
  /** Full socket URL. Overrides `origin`; handy for tests and `wrangler dev`. */
  url?: string;
  /** Page origin to derive the socket URL from. Defaults to `location`. */
  origin?: string;
  /** Where the client id is remembered. Pass `null` to keep it in memory only. */
  storage?: KeyValueStore | null;
  /** Socket constructor. Defaults to the global `WebSocket`. */
  socketFactory?: SocketFactory;
  /** Ping period in ms. Default 20000. Zero disables the heartbeat. */
  heartbeatMs?: number;
  /** How long a ping may go unanswered before the link is declared dead. */
  pongTimeoutMs?: number;
  /** Start connecting immediately. Default true. */
  autoConnect?: boolean;
  reconnect?: ReconnectOptions;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Injectable RNG for backoff jitter, for tests. */
  random?: () => number;
}

export interface RoomConnection {
  /** Normalised room code this connection is for. */
  readonly code: string;
  /** Stable identity used to claim (and reclaim) a seat. */
  readonly clientId: string;
  readonly url: string;

  status(): ConnectionStatus;
  /** Seat this browser plays, or null while connecting / spectating. */
  seat(): Player | null;
  role(): Role | null;
  /** Last authoritative match state the room sent, or null before `welcome`. */
  state(): MatchState | null;
  players(): readonly PlayerInfo[];
  score(): readonly [number, number];
  /** Round-trip time of the last answered ping, in ms. */
  latency(): number | null;

  on<K extends RoomEvent>(event: K, listener: RoomListener<K>): Unsubscribe;
  /** Open the socket (only needed when `autoConnect: false`). */
  connect(): void;
  /** True when the frame was handed to an open socket. */
  sendShot(turn: number, params: ShotParams): boolean;
  requestRematch(): boolean;
  ping(): boolean;
  /** Close for good. No further reconnects. */
  close(): void;
}

const CLIENT_ID_KEY = 'connect-fore:client-id';
const DEFAULTS = {
  heartbeatMs: 20_000,
  pongTimeoutMs: 10_000,
  baseMs: 500,
  factor: 1.8,
  maxMs: 15_000,
} as const;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function defaultStore(): KeyValueStore | null {
  try {
    // Absent in workers, node and private-mode corner cases.
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the arithmetic id below.
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The seat-claiming identity for this tab. `sessionStorage` on purpose: per-tab,
 * so two tabs on one machine can play each other, but stable across a refresh so
 * a reload drops back into the same seat mid-match.
 *
 * A native shell wants the opposite and passes `localStorage` in via the
 * `storage` option - there is only ever one "tab", and session storage there is
 * wiped on every cold launch, which would lose the seat on every app restart.
 */
export function resolveClientId(store: KeyValueStore | null = defaultStore()): string {
  if (!store) return randomId();
  try {
    const saved = store.getItem(CLIENT_ID_KEY);
    if (saved) return saved;
    const fresh = randomId();
    store.setItem(CLIENT_ID_KEY, fresh);
    return fresh;
  } catch {
    return randomId();
  }
}

/**
 * `wss://host/api/room/CODE` for a room.
 *
 * Throws rather than returning a URL that cannot be opened. The URL spec
 * forbids switching a *non-special* scheme to a special one, so assigning
 * `protocol = 'wss:'` to a `capacitor://localhost` base is a silent no-op - the
 * caller would get `capacitor://...` back, `new WebSocket()` would throw, and
 * the retry loop would hide it as an endless "RECONNECTING". Better to fail
 * where the mistake actually is.
 */
export function roomSocketUrl(code: string, origin?: string): string {
  const base =
    origin ??
    (typeof location === 'undefined' ? 'http://127.0.0.1:8787' : location.origin);
  const url = new URL(roomPath(code), base);
  const wanted = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.protocol = wanted;
  if (url.protocol !== wanted) {
    throw new Error(
      `Cannot open a room socket against "${base}". A bundled build must be given a real ` +
        `origin: set VITE_API_ORIGIN to the deployed Worker, e.g. https://fore.automa.agency`,
    );
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * Open (and keep open) a connection to one room.
 *
 * Throws if `code` is not a valid room code — validate user input with
 * `isValidRoomCode` before calling.
 */
export function connectRoom(code: string, opts: RoomConnectionOptions = {}): RoomConnection {
  const roomCode = normalizeRoomCode(code);
  if (!isValidRoomCode(roomCode)) {
    throw new TypeError(`"${code}" is not a valid room code`);
  }

  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const store = opts.storage === undefined ? defaultStore() : opts.storage;
  const clientId = opts.clientId ?? resolveClientId(store);
  const url = opts.url ?? roomSocketUrl(roomCode, opts.origin);
  const makeSocket: SocketFactory =
    opts.socketFactory ?? ((target: string) => new WebSocket(target) as SocketLike);

  const heartbeatMs = opts.heartbeatMs ?? DEFAULTS.heartbeatMs;
  const pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULTS.pongTimeoutMs;
  const backoff = {
    baseMs: opts.reconnect?.baseMs ?? DEFAULTS.baseMs,
    factor: opts.reconnect?.factor ?? DEFAULTS.factor,
    maxMs: opts.reconnect?.maxMs ?? DEFAULTS.maxMs,
    maxAttempts: opts.reconnect?.maxAttempts ?? Number.POSITIVE_INFINITY,
  };

  const listeners = new Map<RoomEvent, Set<(payload: never) => void>>();
  let socket: SocketLike | null = null;
  let status: ConnectionStatus = 'closed';
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pingSentAt: number | null = null;
  let closedByUser = false;

  let seat: Player | null = null;
  let role: Role | null = null;
  let state: MatchState | null = null;
  let players: readonly PlayerInfo[] = [];
  let score: readonly [number, number] = [0, 0];
  let latency: number | null = null;

  function emit<K extends RoomEvent>(event: K, payload: RoomEventMap[K]): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      (listener as RoomListener<K>)(payload);
    }
  }

  function on<K extends RoomEvent>(event: K, listener: RoomListener<K>): Unsubscribe {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    const entry = listener as (payload: never) => void;
    set.add(entry);
    return () => {
      set?.delete(entry);
    };
  }

  function setStatus(next: ConnectionStatus): void {
    if (status === next) return;
    status = next;
    opts.onStatus?.(next);
    emit('status', next);
  }

  function send(payload: unknown): boolean {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function stopTimers(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    pingSentAt = null;
  }

  function detach(ws: SocketLike | null): void {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  }

  function startHeartbeat(): void {
    if (heartbeatMs <= 0) return;
    heartbeatTimer = setInterval(() => {
      // An unanswered ping means the socket is up but the link is gone —
      // common on sleeping laptops and captive wifi. Force a reconnect.
      if (pingSentAt !== null && now() - pingSentAt > pongTimeoutMs) {
        dropSocket();
        return;
      }
      if (pingSentAt === null) {
        pingSentAt = now();
        if (!send({ t: 'ping', ts: pingSentAt })) pingSentAt = null;
      }
    }, heartbeatMs);
  }

  /** Kill the current socket and let the close path schedule a retry. */
  function dropSocket(): void {
    const dying = socket;
    detach(dying);
    socket = null;
    stopTimers();
    try {
      dying?.close(4000, 'heartbeat timeout');
    } catch {
      // Already dead.
    }
    scheduleRetry();
  }

  function nextDelay(): number {
    const raw = Math.min(backoff.maxMs, backoff.baseMs * Math.pow(backoff.factor, attempts));
    // Full-ish jitter: 50–100% of the computed delay, so a room full of
    // clients that dropped together does not stampede back in lockstep.
    return Math.round(raw * (0.5 + random() * 0.5));
  }

  function scheduleRetry(): void {
    if (closedByUser) return;
    if (attempts >= backoff.maxAttempts) {
      setStatus('closed');
      return;
    }
    const delay = nextDelay();
    attempts += 1;
    setStatus('reconnecting');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, delay);
  }

  function handle(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') return;

    // Anything at all proves the link is alive.
    if (pingSentAt !== null && msg.t !== 'pong') pingSentAt = null;

    switch (msg.t) {
      case 'welcome':
        seat = msg.seat;
        role = msg.role;
        state = msg.state;
        players = msg.players;
        score = msg.score;
        opts.onWelcome?.(msg);
        emit('welcome', msg);
        break;
      case 'players':
        players = msg.players;
        opts.onPlayers?.(msg.players);
        emit('players', msg);
        break;
      case 'resolve':
        // The room is the authority; whatever we predicted locally is discarded.
        state = msg.state;
        score = msg.score;
        opts.onResolve?.(msg.record, msg.state, msg.score);
        emit('resolve', msg);
        break;
      case 'rematch':
        state = msg.state;
        opts.onRematch?.(msg.state, msg.by);
        emit('rematch', msg);
        break;
      case 'error':
        opts.onError?.(msg.code, msg.message);
        emit('error', msg);
        break;
      case 'pong':
        if (pingSentAt !== null) latency = Math.max(0, now() - pingSentAt);
        pingSentAt = null;
        opts.onPong?.(msg.ts, latency ?? 0);
        emit('pong', msg);
        break;
      default:
        break;
    }
    opts.onMessage?.(msg);
    emit('message', msg);
  }

  function open(): void {
    if (closedByUser) return;
    if (socket) return;
    setStatus(attempts === 0 ? 'connecting' : 'reconnecting');

    let ws: SocketLike;
    try {
      ws = makeSocket(url);
    } catch {
      scheduleRetry();
      return;
    }
    socket = ws;

    ws.onopen = (): void => {
      if (socket !== ws) return;
      attempts = 0;
      setStatus('open');
      // Re-`hello` on every connect: the room replies with a fresh `welcome`,
      // which is how a reconnecting client resyncs mid-match.
      send({ t: 'hello', v: PROTOCOL_VERSION, clientId, name: opts.name });
      startHeartbeat();
    };

    ws.onmessage = (ev: { data: unknown }): void => {
      if (socket !== ws) return;
      handle(ev.data);
    };

    ws.onerror = (): void => {
      // `onclose` always follows; retry bookkeeping lives there.
    };

    ws.onclose = (): void => {
      if (socket !== ws) return;
      detach(ws);
      socket = null;
      stopTimers();
      if (closedByUser) {
        setStatus('closed');
        return;
      }
      scheduleRetry();
    };
  }

  const connection: RoomConnection = {
    code: roomCode,
    clientId,
    url,
    status: () => status,
    seat: () => seat,
    role: () => role,
    state: () => state,
    players: () => players,
    score: () => score,
    latency: () => latency,
    on,
    connect: () => {
      closedByUser = false;
      if (socket || retryTimer !== null) return;
      attempts = 0;
      open();
    },
    sendShot: (turn: number, params: ShotParams) => send({ t: 'shot', turn, params }),
    requestRematch: () => send({ t: 'rematch' }),
    ping: () => {
      if (pingSentAt === null) pingSentAt = now();
      const ok = send({ t: 'ping', ts: pingSentAt });
      if (!ok) pingSentAt = null;
      return ok;
    },
    close: () => {
      closedByUser = true;
      const dying = socket;
      detach(dying);
      socket = null;
      stopTimers();
      try {
        dying?.close(1000, 'bye');
      } catch {
        // Already dead.
      }
      setStatus('closed');
    },
  };

  if (opts.autoConnect !== false) open();

  return connection;
}
