/**
 * One Durable Object per room code — the authority for a match.
 *
 * The DO imports the *same* pure simulation the browsers run (`src/game/match`)
 * and replays every shot itself, so "authoritative server" costs nothing beyond
 * a function call: the client only ever sends four numbers, and the board it
 * draws is the board the room broadcast back.
 *
 * This class is only a shell. It owns sockets, hibernation attachments,
 * storage and the idle alarm; every decision lives in `./match-room.ts`, which
 * is pure and unit-tested without a Workers runtime.
 *
 * Hibernation matters here: two players staring at a board for ten minutes
 * should cost nothing, so sockets are accepted with `ctx.acceptWebSocket` and
 * each one's identity rides along in `serializeAttachment` — instance memory
 * does not survive eviction, attachments and storage do.
 */
import { DurableObject } from 'cloudflare:workers';
import { applyShot, newMatch, rematchMatch } from '../src/game/match';
import type { ClientMessage, ServerMessage } from '../src/net/protocol';
import { normalizeRoomCode } from '../src/net/protocol';
import type { MatchEngine, Outbound, RoomState, Session } from './match-room';
import {
  anonymousSession,
  createRoomState,
  handleDisconnect,
  handleMessage,
  IDLE_ROOM_MS,
  isIdle,
} from './match-room';
import type { Env } from './index';

const ROOM_KEY = 'room';
/** Don't rewrite the alarm on every packet; only when it has drifted this far. */
const ALARM_SLACK_MS = 5 * 60 * 1000;

const ENGINE: MatchEngine = { newMatch, applyShot, rematchMatch };

export class GameRoom extends DurableObject<Env> {
  /** Cached room state. Rebuilt from storage after eviction. */
  private cached: RoomState | null = null;

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    const path = new URL(request.url).pathname;
    const code = normalizeRoomCode(path.slice(path.lastIndexOf('/') + 1));
    await this.load(code);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernatable: the runtime can evict this object and still hold the socket.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(anonymousSession());
    await this.touchAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') {
      this.send(ws, { t: 'error', code: 'bad-message', message: 'text frames only' });
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(ws, { t: 'error', code: 'bad-message', message: 'malformed json' });
      return;
    }

    const room = await this.load();
    const session = this.sessionOf(ws);
    const step = handleMessage(room, session, msg, { engine: ENGINE, now: Date.now() });

    if (step.session !== session) ws.serializeAttachment(step.session);
    if (step.dirty) await this.persist(step.room);
    this.deliver(ws, step.out);
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.dropped(ws);
    try {
      // 1006 is "abnormal closure"; it is never a legal code to send back.
      ws.close(code >= 1000 && code < 5000 && code !== 1006 ? code : 1000, reason);
    } catch {
      // Already gone. Nothing to do.
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.dropped(ws);
  }

  /**
   * Mark a seat as away. Idempotent, because a dying socket can deliver both an
   * error and a close, and a client that reconnected first keeps its seat lit.
   */
  private async dropped(ws: WebSocket): Promise<void> {
    const room = await this.load();
    const session = this.sessionOf(ws);
    const step = handleDisconnect(
      room,
      session,
      { seatStillHeld: this.seatHeldElsewhere(ws, session.clientId) },
      { engine: ENGINE, now: Date.now() },
    );
    if (step.dirty) await this.persist(step.room);
    this.deliver(ws, step.out);
  }

  /** Another live socket already signed in as this client, so keep the seat. */
  private seatHeldElsewhere(ws: WebSocket, clientId: string): boolean {
    if (!clientId) return false;
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      if (other.readyState !== WebSocket.OPEN) continue;
      if (this.sessionOf(other).clientId === clientId) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Idle expiry
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    const live = this.ctx.getWebSockets().length;
    const room = await this.load();
    if (isIdle(room, Date.now(), live)) {
      await this.ctx.storage.deleteAll();
      this.cached = null;
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + IDLE_ROOM_MS);
  }

  private async touchAlarm(): Promise<void> {
    const target = Date.now() + IDLE_ROOM_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing < target - ALARM_SLACK_MS) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private async load(code = ''): Promise<RoomState> {
    if (this.cached) return this.cached;
    const stored = await this.ctx.storage.get<RoomState>(ROOM_KEY);
    this.cached = stored ?? createRoomState(code, { engine: ENGINE, now: Date.now() });
    return this.cached;
  }

  private async persist(room: RoomState): Promise<void> {
    this.cached = room;
    await this.ctx.storage.put(ROOM_KEY, room);
    await this.touchAlarm();
  }

  private sessionOf(ws: WebSocket): Session {
    const raw = ws.deserializeAttachment() as Partial<Session> | null;
    if (!raw || typeof raw.clientId !== 'string' || typeof raw.hello !== 'boolean') {
      return anonymousSession();
    }
    return {
      clientId: raw.clientId,
      name: typeof raw.name === 'string' ? raw.name : '',
      seat: raw.seat === 1 || raw.seat === 2 ? raw.seat : null,
      role: raw.role === 'player' ? 'player' : 'spectator',
      hello: raw.hello,
    };
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  private deliver(sender: WebSocket, out: readonly Outbound[]): void {
    for (const item of out) {
      if (item.to === 'sender') {
        this.send(sender, item.msg);
        continue;
      }
      for (const ws of this.ctx.getWebSockets()) {
        if (item.to === 'others' && ws === sender) continue;
        this.send(ws, item.msg);
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(msg));
    } catch {
      // The socket died between our check and the write; the close handler
      // will clean the seat up.
    }
  }
}
