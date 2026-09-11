/**
 * Renderer scratch page.
 *
 * Drives `createRenderer` from a hand-built `RenderFrame` so the look can be
 * checked without the sim, the netcode or the audio existing. It is not part of
 * the production bundle: only `index.html` is a build entry point.
 *
 * Query parameters:
 *   ?shot=title|address|follow|board|result   pick the camera
 *   ?still=1&t=2.4                            freeze time (stable screenshots)
 *   ?menu=1 ?message=1 ?win=1 ?falling=1      toggle HUD furniture
 *   ?shake=0.6 ?phase=power                   shake amount, meter phase
 */
import type { Board, Cell, Player, WinLine } from '../game/types';
import { CELL_COUNT, COLS, COURSE, ROWS, cellCenter } from '../game/types';
import type { CameraShot, MeterView, RenderFrame, Renderer } from './api';
import { createRenderer } from './renderer';

const params = new URLSearchParams(window.location.search);
const SHOTS: readonly CameraShot[] = ['title', 'address', 'follow', 'board', 'result'];
const PHASES: readonly MeterView['phase'][] = ['aim', 'power', 'accuracy', 'locked'];

function pick<T extends string>(options: readonly T[], value: string | null, fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

/** A plausible mid-game position: columns stacked from the bottom up. */
function demoBoard(): Board {
  const heights: readonly number[] = [3, 2, 4, 1, 0, 2, 3];
  const cells: Cell[] = new Array<Cell>(CELL_COUNT).fill(0);
  let turn: Player = 1;
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      if (row < (heights[col] ?? 0)) {
        cells[row * COLS + col] = turn;
        turn = turn === 1 ? 2 : 1;
      }
    }
  }
  return cells;
}

const WIN_LINE: WinLine = [0, 1, 2, 3];

const state = {
  shot: pick(SHOTS, params.get('shot'), 'follow'),
  still: params.get('still') === '1',
  frozen: Number(params.get('t') ?? '2.4'),
  menu: params.get('menu') === '1',
  message: params.get('message') === '1',
  win: params.get('win') === '1',
  falling: params.get('falling') === '1',
  shake: Number(params.get('shake') ?? '0'),
  phase: pick(PHASES, params.get('phase'), 'power'),
};

const app = document.getElementById('app');
if (!app) throw new Error('dev page is missing #app');

let renderer: Renderer;
try {
  renderer = createRenderer(app);
} catch (error) {
  app.textContent = String(error);
  throw error;
}

// --- controls ---------------------------------------------------------------
const controls = document.getElementById('controls');
function button(label: string, onClick: () => void): void {
  if (!controls) return;
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  controls.appendChild(element);
}
for (const shot of SHOTS) {
  button(shot.toUpperCase(), () => {
    state.shot = shot;
  });
}
button('MENU', () => {
  state.menu = !state.menu;
});
button('MESSAGE', () => {
  state.message = !state.message;
});
button('WIN', () => {
  state.win = !state.win;
});
button('DROP', () => {
  state.falling = !state.falling;
});
button('SHAKE', () => {
  state.shake = state.shake > 0 ? 0 : 0.7;
});
button('PHASE', () => {
  state.phase = PHASES[(PHASES.indexOf(state.phase) + 1) % PHASES.length] ?? 'power';
});

// --- the frame --------------------------------------------------------------
// Mutated in place every tick: the game loop is expected to reuse one frame
// object, and driving the renderer that way here proves it copes.
const frame: RenderFrame = {
  board: demoBoard(),
  ball: { x: 0, y: COURSE.tee.y, z: COURSE.tee.z, visible: true },
  aim: null,
  camera: state.shot,
  fallingDisc: null,
  explosion: null,
  collapse: null,
  highlight: null,
  shake: 0,
  hud: {
    visible: true,
    title: null,
    subtitle: null,
    message: null,
    players: [
      { name: 'PLAYER 1', player: 1, score: 2, active: true, connected: true },
      { name: 'BIRDIE', player: 2, score: 1, active: false, connected: true },
    ],
    meter: { phase: 'power', power: 0.62, accuracy: 0, perfect: 0.25, cursor: 0.62 },
    roomCode: 'FORE42',
    hint: 'A: SET POWER   B: BACK',
    menu: null,
    panel: null,
  },
  time: 0,
};

const FLIGHT_SECONDS = 2.6;
const TARGET_CELL = cellCenter(4, 2);

function tick(now: number): void {
  const time = state.still ? state.frozen : now / 1000;
  frame.time = time;
  frame.camera = state.shot;
  frame.shake = state.shake;
  frame.highlight = state.win ? WIN_LINE : null;

  // The ball on a lazy parabola from the tee towards the gap in column 4.
  const travel =
    state.shot === 'address' ? 0 : state.still ? 0.55 : (time % FLIGHT_SECONDS) / FLIGHT_SECONDS;
  frame.ball.x = COURSE.tee.x + (TARGET_CELL.x - COURSE.tee.x) * travel;
  frame.ball.z = COURSE.tee.z + (COURSE.boardZ - COURSE.tee.z) * travel;
  frame.ball.y =
    COURSE.tee.y + Math.sin(travel * Math.PI) * 4.2 + (TARGET_CELL.y - COURSE.tee.y) * travel;
  frame.ball.visible = state.shot !== 'title' && state.shot !== 'result';
  if (state.shot === 'address') frame.ball.y = COURSE.tee.y;
  frame.aim = state.shot === 'address' ? { yaw: Math.sin(time * 0.6) * 0.4, loft: 0.5 } : null;
  frame.fallingDisc = state.falling
    ? { player: 2, col: 4, y: cellCenter(4, ROWS - 1).y - ((time * 3) % 4.2) }
    : null;

  const hud = frame.hud;
  hud.title = state.shot === 'title' ? 'CONNECT FORE!' : null;
  hud.subtitle = state.shot === 'title' ? 'GOLF MEETS CONNECT FOUR' : null;
  hud.message = state.message ? 'THROUGH THE GAP!' : null;
  hud.menu = state.menu
    ? { items: ['1 PLAYER', '2 PLAYERS', 'ONLINE MATCH', 'OPTIONS'], index: Math.floor(time) % 4 }
    : null;
  hud.hint = state.menu ? 'START: SELECT' : 'A: SET POWER   B: BACK';

  const meter = hud.meter;
  if (meter) {
    const sweep = state.still ? 0.62 : (Math.sin(time * 2.4) + 1) / 2;
    meter.phase = state.phase;
    meter.power = state.phase === 'aim' ? 0 : state.phase === 'power' ? sweep : 0.78;
    meter.cursor = state.phase === 'accuracy' ? sweep : meter.power;
    meter.accuracy = state.phase === 'aim' ? 0 : state.still ? -0.22 : Math.sin(time * 1.3) * 0.35;
  }

  renderer.render(frame);
  window.requestAnimationFrame(tick);
}

window.requestAnimationFrame(tick);
