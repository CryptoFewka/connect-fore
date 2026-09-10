# Connect Fore!

NES-style 3D golf meets Connect Four. Aim, pick your power, and thread the ball
through a gap in the board — the piece spawns where it passes through and falls
to rest. Bounce off the frame and you forfeit your turn.

Play hot-seat, against a simulated AI, or online against a friend via a
shareable challenge URL.

## Running it

```sh
bun install
bun run dev          # Vite dev server (fast client iteration)
bun run dev:worker   # build + wrangler dev, including the room Durable Object
bun test
```

## Deploying

The app is a Cloudflare Worker that serves the built client from
`dist/client` and holds one SQLite-backed Durable Object per game room.

- Build command: `bun install && bun run build`
- Deploy command: `bunx wrangler deploy`

Status: under construction — see the milestone breakdown in the project plan.
