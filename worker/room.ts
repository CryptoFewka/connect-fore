/**
 * One Durable Object per room code.
 *
 * Uses the WebSocket Hibernation API so an idle room costs nothing while two
 * players stare at the board. This is the M1 skeleton: it seats connections and
 * echoes, and gains the authoritative match logic in the netcode milestone.
 */
import { DurableObject } from 'cloudflare:workers';
import type { ClientMessage, ServerMessage } from '../src/net/protocol';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import type { Env } from './index';

export class GameRoom extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(ws, { t: 'error', code: 'bad-message', message: 'malformed json' });
      return;
    }

    if (msg.t === 'ping') {
      this.send(ws, { t: 'pong', ts: msg.ts });
      return;
    }

    if (msg.t === 'hello' && msg.v !== PROTOCOL_VERSION) {
      this.send(ws, { t: 'error', code: 'bad-version', message: 'reload the page' });
      return;
    }

    // Match logic lands here in the netcode milestone.
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code === 1006 ? 1000 : code, reason);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    ws.send(JSON.stringify(msg));
  }
}
