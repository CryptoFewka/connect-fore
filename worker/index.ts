/**
 * Fore! edge entrypoint.
 *
 * `/api/room/:code` upgrades to a WebSocket held by the `GameRoom` Durable
 * Object for that code — `idFromName(code)` means the challenge URL alone is
 * enough to find the room, with no lookup table. Everything else is the static
 * game bundle.
 */
import { isValidRoomCode, normalizeRoomCode, PROTOCOL_VERSION } from '../src/net/protocol';
import { appleAppSiteAssociation, assetLinks } from './deep-links';
import { GameRoom } from './room';

export { GameRoom };

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
}

const ROOM_ROUTE = /^\/api\/room\/([0-9A-Za-z]+)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const match = ROOM_ROUTE.exec(url.pathname);
    if (match) {
      const code = normalizeRoomCode(match[1] ?? '');
      if (!isValidRoomCode(code)) {
        return new Response('bad room code', { status: 400 });
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      const room = env.ROOMS.get(env.ROOMS.idFromName(code));
      return room.fetch(request);
    }

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, protocol: PROTOCOL_VERSION });
    }

    // Claimed by the native apps so a challenge link opens the game.
    if (url.pathname === '/.well-known/apple-app-site-association') {
      return appleAppSiteAssociation();
    }
    if (url.pathname === '/.well-known/assetlinks.json') {
      return assetLinks();
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
