# Connect Fore!

Connect Four, except you don't drop the piece — you hit a golf ball at the board.

Line up your aim, stop the power meter, catch the sweet spot, and thread the ball
through one of the open cells. Get it through and a piece spawns in that hole and
falls down the column to rest. Clip the frame, or one of your own discs, and the
ball bounces away and **you forfeit your turn**.

Hit one of your **opponent's** discs, though, and it detonates — their whole stack
above it drops a slot into the hole you just made. It still costs you the turn, so
demolition is a choice, not a freebie: a shot spent wrecking their shape is a shot
not spent building yours.

The catch builds as you play: every disc you land closes an aperture, so the low,
easy holes in a column disappear and you're forced to loft the ball into the tight
ones near the top — right when the game is at its most tense.

Play against a friend on the same screen, against a simulated opponent, or online
by sending someone a challenge link.

## How to play

| | Keyboard | Touch |
|---|---|---|
| Aim | Arrows / WASD | Drag the screen |
| Move the cursor | Arrows / WASD | Swipe up or down |
| Commit | Enter, Space or Z | Tap |
| Back | Esc, Backspace or X | Swipe left, or hold in place while aiming |
| Mute | M | — |

All of this is in the game too, under **HOW TO PLAY** — and that screen flips
between the touch and keyboard listings, because a tablet with a keyboard
attached makes any single guess the wrong one.

A shot takes three commits, the way an NES golf meter always has:

1. **Aim** — swing the yaw left and right, and set how much loft you want. On a
   keyboard a tap nudges finely and a hold sweeps across the board; on a
   touchscreen the shot simply follows your finger. Flat shots have far more
   forgiving power windows than lofted ones, but only a lofted ball reaches the
   high cells. Your aim stays where you left it between shots.
2. **Power** — a cursor climbs the meter. Stop it in the window for the row you're
   after.
3. **Accuracy** — the cursor falls back through a sweet spot at the centre. Commit
   late and you hook left, early and you slice right.

## Online

Pick **PLAY ONLINE → CREATE CHALLENGE** and the game gives you a room code and a
link. Whoever opens the link drops straight into your room as player two. If you'd
rather read a code out loud, the other player can type it in with **ENTER A CODE** —
the alphabet leaves out characters that sound alike.

Refreshing or briefly losing signal doesn't cost you the match: your seat is held
and the board comes back with it.

## Running it

```sh
bun install
bun run dev          # Vite dev server, fastest for client work
bun run dev:worker   # build + wrangler dev, including the room Durable Object
bun test             # rules, physics determinism, AI, and room protocol
bun run typecheck && bun run lint
```

Online play needs the Worker, so use `bun run dev:worker` for anything involving a
room. There are also two scratch pages under the dev server for working on pieces
in isolation: `/src/render/dev.html` and `/src/audio/dev.html`.

## How it fits together

```
src/game/    the simulation - pure, no DOM, no WebGL, no clock, no Math.random
src/render/  Three.js scene, NES palette post-processing, HUD
src/audio/   a WebAudio NES APU; every sound is synthesised at runtime
src/net/     wire protocol and browser client
src/ui/      input, the golf meter, the turn machine, menus
worker/      Cloudflare Worker and the GameRoom Durable Object
```

Two decisions shape everything else:

**The simulation is pure and deterministic.** No wall clock, no `Math.random`, a
fixed timestep, and only add/multiply/abs in the integration path. So the Durable
Object can import the very same code the browsers run. A player sends four numbers —
yaw, loft, power, accuracy — the room replays the shot to decide what happened, and
both browsers replay it again to animate it. Nobody streams positions, and the
server is authoritative for almost nothing extra.

**The 3D scene is thrown away at 256×240.** The board really is geometry — one
extruded mesh with 42 holes cut through it, which is why you can see the fairway
through the empty cells and watch the ball pass through. It's rendered into a
native-resolution buffer, dithered, quantised to a 54-colour NES palette and scaled
back up, so the depth is genuine but every pixel is chunky. The HUD is drawn from a
hand-coded 5×7 bitmap font into the same buffer, so the text lives inside the pixel
grid rather than floating over it. No image or audio files ship with the game.

## Deploying

The whole thing is one Cloudflare Worker: static assets out of `dist/client`, plus
one SQLite-backed Durable Object per room, addressed by `idFromName(code)` so a
challenge link is all you need to find a game.

- Build command: `bun install && bun run build`
- Deploy command: `bunx wrangler deploy`

## Accessibility

Playable entirely from the keyboard. The two sides carry X and O faces as well as
red and yellow, so you never have to tell them apart by colour. Screen shake is
suppressed under `prefers-reduced-motion`, and sound can be muted with **M**.
