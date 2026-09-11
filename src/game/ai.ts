/**
 * The simulated opponent.
 *
 * Two separate problems: *which column* (a normal four in a row search) and
 * *how to hit it* (a numeric aim solve against the very same physics the player
 * is fighting). Difficulty only touches the second one — the AI always knows
 * what it wants, it just can't always pull the shot off.
 */
import type { Board, CellRef, Difficulty, Player, ShotParams, ShotResult } from './types';
import { cellCenter, COLS, COURSE, ROWS } from './types';
import {
  cellAt,
  dropPiece,
  findWin,
  isColumnFull,
  isWinningMove,
  landingRow,
  legalColumns,
  openCells,
} from './rules';
import { otherPlayer } from './match';
import { simulateShot } from './shot';
import {
  BOARD_MAX_Y,
  BOARD_MIN_Y,
  clamp,
  probeCrossing,
  TEE_TO_BOARD,
} from './physics';
import type { Rng } from './rng';

// ---------------------------------------------------------------------------
// Column choice: negamax with alpha-beta
// ---------------------------------------------------------------------------

/** Centre-out, which is both the best four in a row move order and good pruning. */
export const CENTRE_ORDER: readonly number[] = [3, 2, 4, 1, 5, 0, 6];

export const AI_DEPTH = 4;

/**
 * How far ahead each difficulty looks.
 *
 * Easy searches a single ply, which is not the same as playing blind: the
 * immediate-win check, the opponent block and the safe-column filter in
 * `chooseColumn` all run before the search, so easy still takes a win it can
 * see and still stops yours. What it loses is the ability to build threats you
 * cannot answer.
 */
export const SEARCH_DEPTH: Readonly<Record<Difficulty, number>> = {
  easy: 1,
  normal: AI_DEPTH,
  hard: AI_DEPTH,
};

const WIN_SCORE = 100000;

/** Weights for open windows of four. Blocking is valued slightly above attacking. */
const THREE_OPEN = 12;
const TWO_OPEN = 4;
const THREE_OPEN_ENEMY = -14;
const TWO_OPEN_ENEMY = -4;
const CENTRE_BONUS = 3;

const WINDOWS: readonly (readonly number[])[] = buildWindows();

function buildWindows(): number[][] {
  const dirs: readonly (readonly [number, number])[] = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  const out: number[][] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      for (const [dc, dr] of dirs) {
        const endCol = col + dc * 3;
        const endRow = row + dr * 3;
        if (endCol < 0 || endCol >= COLS || endRow < 0 || endRow >= ROWS) continue;
        out.push([
          row * COLS + col,
          (row + dr) * COLS + (col + dc),
          (row + dr * 2) * COLS + (col + dc * 2),
          endRow * COLS + endCol,
        ]);
      }
    }
  }
  return out;
}

/** Static evaluation of a non-terminal board from `player`'s point of view. */
export function evaluateBoard(board: Board, player: Player): number {
  const opponent = otherPlayer(player);
  let score = 0;
  for (const window of WINDOWS) {
    let mine = 0;
    let theirs = 0;
    for (const index of window) {
      const cell = board[index] ?? 0;
      if (cell === player) mine++;
      else if (cell === opponent) theirs++;
    }
    if (mine > 0 && theirs > 0) continue;
    if (mine === 3) score += THREE_OPEN;
    else if (mine === 2) score += TWO_OPEN;
    else if (theirs === 3) score += THREE_OPEN_ENEMY;
    else if (theirs === 2) score += TWO_OPEN_ENEMY;
  }
  const centre = (COLS - 1) / 2;
  for (let row = 0; row < ROWS; row++) {
    const cell = cellAt(board, centre, row);
    if (cell === player) score += CENTRE_BONUS;
    else if (cell === opponent) score -= CENTRE_BONUS;
  }
  return score;
}

function negamax(
  board: Board,
  player: Player,
  depth: number,
  alpha: number,
  beta: number,
): number {
  // Someone just completed a line; it can only have been the other side.
  const win = findWin(board);
  if (win) return win.player === player ? WIN_SCORE + depth : -(WIN_SCORE + depth);

  const legal = CENTRE_ORDER.filter((col) => !isColumnFull(board, col));
  if (legal.length === 0) return 0;
  if (depth === 0) return evaluateBoard(board, player);

  let best = -Infinity;
  let a = alpha;
  for (const col of legal) {
    const dropped = dropPiece(board, col, player);
    if (!dropped) continue;
    const value = -negamax(dropped.board, otherPlayer(player), depth - 1, -beta, -a);
    if (value > best) best = value;
    if (value > a) a = value;
    if (a >= beta) break;
  }
  return best;
}

/** Columns where dropping right now completes four in a row. */
export function immediateWins(board: Board, player: Player): number[] {
  return legalColumns(board).filter((col) => isWinningMove(board, col, player));
}

/** A column is unsafe when it lifts the opponent into an instant win above it. */
export function isSafeColumn(board: Board, col: number, player: Player): boolean {
  const dropped = dropPiece(board, col, player);
  if (!dropped) return false;
  return !isWinningMove(dropped.board, col, otherPlayer(player));
}

/**
 * Picks the column to aim at: win now, else block, else the best negamax score
 * among columns that don't gift-wrap a win, breaking ties towards the centre.
 */
export function chooseColumn(board: Board, player: Player, depth: number = AI_DEPTH): number {
  const legal = CENTRE_ORDER.filter((col) => !isColumnFull(board, col));
  if (legal.length === 0) return -1;

  // Centre-first among equally winning (or equally forced) columns.
  const wins = immediateWins(board, player);
  if (wins.length > 0) {
    for (const col of legal) if (wins.includes(col)) return col;
  }

  const blocks = immediateWins(board, otherPlayer(player));
  if (blocks.length > 0) {
    for (const col of legal) if (blocks.includes(col)) return col;
  }

  const safe = legal.filter((col) => isSafeColumn(board, col, player));
  const candidates = safe.length > 0 ? safe : legal;

  let bestCol = candidates[0] ?? legal[0] ?? 0;
  let bestScore = -Infinity;
  for (const col of candidates) {
    const dropped = dropPiece(board, col, player);
    if (!dropped) continue;
    const score = -negamax(dropped.board, otherPlayer(player), depth - 1, -Infinity, Infinity);
    if (score > bestScore) {
      bestScore = score;
      bestCol = col;
    }
  }
  return bestCol;
}

// ---------------------------------------------------------------------------
// Aim solver
// ---------------------------------------------------------------------------

/** Powers the solver tries, in order, before giving up on a target. */
export const AIM_POWERS: readonly number[] = [0.7, 0.78, 0.64, 0.86, 0.94, 0.56];

const LOFT_SCAN_STEPS = 24;
const LOFT_BISECTIONS = 16;
const YAW_ITERATIONS = 3;

export interface AimSolution {
  readonly params: ShotParams;
  readonly result: ShotResult;
  /** Distance from the aperture centre at the board plane. */
  readonly error: number;
  /** Physics calls burned finding it — probes plus the confirming simulation. */
  readonly sims: number;
}

interface Counter {
  n: number;
}

function crossing(
  yaw: number,
  loft: number,
  power: number,
  counter: Counter,
): { x: number; y: number; grounded: boolean } | null {
  counter.n++;
  return probeCrossing({ yaw, loft, power, accuracy: 0 });
}

/** Height the ball arrives at, or `null` when the flight is unusable. */
function arrivalHeight(
  yaw: number,
  loft: number,
  power: number,
  counter: Counter,
): number | null {
  const hit = crossing(yaw, loft, power, counter);
  if (!hit || hit.grounded) return null;
  return hit.y;
}

/** Solves loft for a target height by scanning for a bracket, then bisecting. */
function solveLoft(
  yaw: number,
  power: number,
  targetY: number,
  counter: Counter,
): number | null {
  const lo = COURSE.minLoft;
  const hi = COURSE.maxLoft;
  const stride = (hi - lo) / LOFT_SCAN_STEPS;

  let lowLoft = NaN;
  let lowY = NaN;
  let bracketLo = NaN;
  let bracketHi = NaN;

  for (let i = 0; i <= LOFT_SCAN_STEPS; i++) {
    const loft = lo + stride * i;
    const y = arrivalHeight(yaw, loft, power, counter);
    if (y === null) {
      if (!Number.isNaN(lowY) && lowY < targetY) break; // ball can no longer get there
      continue;
    }
    if (y >= targetY && !Number.isNaN(lowLoft) && lowY <= targetY) {
      bracketLo = lowLoft;
      bracketHi = loft;
      break;
    }
    lowLoft = loft;
    lowY = y;
  }
  if (Number.isNaN(bracketLo) || Number.isNaN(bracketHi)) return null;

  for (let i = 0; i < LOFT_BISECTIONS; i++) {
    const mid = (bracketLo + bracketHi) / 2;
    const y = arrivalHeight(yaw, mid, power, counter);
    if (y === null) {
      bracketHi = mid;
      continue;
    }
    if (y < targetY) bracketLo = mid;
    else bracketHi = mid;
  }
  return (bracketLo + bracketHi) / 2;
}

/** Nudges yaw until the ball arrives over the target column. */
function solveYaw(
  yaw: number,
  loft: number,
  power: number,
  targetX: number,
  counter: Counter,
): number {
  let current = yaw;
  for (let i = 0; i < YAW_ITERATIONS; i++) {
    const hit = crossing(current, loft, power, counter);
    if (!hit) break;
    const error = hit.x - targetX;
    if (Math.abs(error) < 0.002) break;
    current = clamp(current - error / TEE_TO_BOARD, -COURSE.maxYaw, COURSE.maxYaw);
  }
  return current;
}

/**
 * Coarse-to-fine search for parameters that thread `target`.
 *
 * Coarse: a loft scan per candidate power to bracket the arrival height.
 * Fine: bisect loft, then correct yaw, then re-bisect — the two axes are nearly
 * independent, so a couple of passes converge to well inside the aperture. The
 * candidate is confirmed against the real `simulateShot`, board and all.
 */
export function solveAim(
  board: Board,
  target: CellRef,
  powers: readonly number[] = AIM_POWERS,
): AimSolution | null {
  const centre = cellCenter(target.col, target.row);
  if (centre.y < BOARD_MIN_Y || centre.y > BOARD_MAX_Y) return null;
  const counter: Counter = { n: 0 };
  let fallback: AimSolution | null = null;

  for (const power of powers) {
    let yaw = Math.atan2(centre.x, TEE_TO_BOARD);
    let loft = solveLoft(yaw, power, centre.y, counter);
    if (loft === null) continue;

    for (let pass = 0; pass < 2; pass++) {
      yaw = solveYaw(yaw, loft, power, centre.x, counter);
      const refined = solveLoft(yaw, power, centre.y, counter);
      if (refined !== null) loft = refined;
    }

    const params: ShotParams = { yaw, loft, power, accuracy: 0 };
    counter.n++;
    const result = simulateShot(board, params);
    const hit = crossing(yaw, loft, power, counter);
    const error = hit
      ? Math.sqrt((hit.x - centre.x) ** 2 + (hit.y - centre.y) ** 2)
      : Infinity;
    const solution: AimSolution = { params, result, error, sims: counter.n };
    if (
      result.outcome === 'thread' &&
      result.entry?.col === target.col &&
      result.entry?.row === target.row
    ) {
      return solution;
    }
    if (!fallback || error < fallback.error) fallback = solution;
  }
  return fallback;
}

/**
 * A clean, error-free swing that drops a disc into `col`, or `null` if the
 * column is full. Handy for practice modes, replays and tests.
 */
export function aimForColumn(board: Board, col: number): ShotParams | null {
  const row = landingRow(board, col);
  if (row < 0) return null;
  const solution = solveAim(board, { col, row });
  return solution ? solution.params : null;
}

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

export interface ErrorProfile {
  /** Sigma, in world units at the board plane, of the aim error. */
  readonly aimSigma: number;
  /** Sigma of the residual hook/slice the AI leaves on the ball. */
  readonly accuracySigma: number;
}

/**
 * Tuned against `test/ai.test.ts`, which measures the resulting miss rates:
 * easy ~40%, normal ~20%, hard ~8%. The aperture only tolerates
 * `APERTURE_TOLERANCE` (0.26) of error, so these sigmas are small numbers.
 */
/**
 * Tuned empirically against the live geometry, not guessed. These are sigmas in
 * world units at the board plane, so they have to be re-measured whenever the
 * aperture tolerance moves - shrinking the ball makes the AI a better shot for
 * free, which is exactly how "easy" drifted into being deadly.
 */
export const ERROR_PROFILES: Readonly<Record<Difficulty, ErrorProfile>> = {
  easy: { aimSigma: 0.5, accuracySigma: 0.13 },
  normal: { aimSigma: 0.18, accuracySigma: 0.047 },
  hard: { aimSigma: 0.14, accuracySigma: 0.036 },
};

/** Lowest empty cell of a column — the aperture a disc can be dropped through. */
export function targetCell(board: Board, col: number): CellRef | null {
  const row = landingRow(board, col);
  return row < 0 ? null : { col, row };
}

/** Every aperture worth aiming at, best (chosen column, lowest) first. */
function aimTargets(board: Board, col: number): CellRef[] {
  const targets: CellRef[] = [];
  const own = targetCell(board, col);
  if (own) targets.push(own);
  for (const cell of openCells(board)) {
    if (cell.col === col && cell.row !== own?.row) targets.push(cell);
  }
  for (const cell of openCells(board)) {
    if (cell.col !== col && landingRow(board, cell.col) === cell.row) targets.push(cell);
  }
  return targets;
}

/** Local sensitivity of the arrival point to the two aim axes. */
function aimJacobian(
  params: ShotParams,
  counter: Counter,
): { dxdYaw: number; dydLoft: number } {
  const h = 0.02;
  const right = crossing(params.yaw + h, params.loft, params.power, counter);
  const left = crossing(params.yaw - h, params.loft, params.power, counter);
  const up = crossing(params.yaw, params.loft + h, params.power, counter);
  const down = crossing(params.yaw, params.loft - h, params.power, counter);
  const dxdYaw = right && left ? (right.x - left.x) / (2 * h) : TEE_TO_BOARD;
  const dydLoft = up && down ? (up.y - down.y) / (2 * h) : TEE_TO_BOARD;
  return {
    dxdYaw: Math.abs(dxdYaw) < 1 ? TEE_TO_BOARD : dxdYaw,
    dydLoft: Math.abs(dydLoft) < 1 ? TEE_TO_BOARD : dydLoft,
  };
}

/** A last-ditch swing, used only if the solver finds nothing at all. */
function desperationShot(board: Board, col: number): ShotParams {
  const row = Math.max(0, landingRow(board, col));
  const centre = cellCenter(col, row);
  return {
    yaw: clamp(Math.atan2(centre.x, TEE_TO_BOARD), -COURSE.maxYaw, COURSE.maxYaw),
    loft: clamp(0.28 + row * 0.06, COURSE.minLoft, COURSE.maxLoft),
    power: 0.72,
    accuracy: 0,
  };
}

/**
 * The AI's swing: pick a column, solve the aim for its lowest aperture, then
 * spray it by difficulty. The error is injected in *world units at the board*
 * and converted back through the local Jacobian, so a sigma means the same
 * thing whatever the shot shape — which is what makes the miss rates stable.
 */
export function planShot(
  board: Board,
  player: Player,
  difficulty: Difficulty,
  rng: Rng,
): ShotParams {
  const col = chooseColumn(board, player, SEARCH_DEPTH[difficulty]);
  if (col < 0) return desperationShot(board, 0);

  // Rotate the club selection so the AI doesn't hit the identical shot forever.
  const rotation = rng.nextInt(3);
  const powers = AIM_POWERS.slice(rotation).concat(AIM_POWERS.slice(0, rotation));

  let solution: AimSolution | null = null;
  for (const target of aimTargets(board, col)) {
    const candidate = solveAim(board, target, powers);
    if (candidate && candidate.result.outcome === 'thread') {
      solution = candidate;
      break;
    }
    if (candidate && (!solution || candidate.error < solution.error)) solution = candidate;
  }
  if (!solution) return desperationShot(board, col);

  const profile = ERROR_PROFILES[difficulty];
  const counter: Counter = { n: 0 };
  const { dxdYaw, dydLoft } = aimJacobian(solution.params, counter);

  const offsetX = rng.nextGaussian() * profile.aimSigma;
  const offsetY = rng.nextGaussian() * profile.aimSigma;
  const accuracy = rng.nextGaussian() * profile.accuracySigma;

  return {
    yaw: clamp(solution.params.yaw + offsetX / dxdYaw, -COURSE.maxYaw, COURSE.maxYaw),
    loft: clamp(solution.params.loft + offsetY / dydLoft, COURSE.minLoft, COURSE.maxLoft),
    power: clamp(solution.params.power, 0, 1),
    accuracy: clamp(accuracy, -1, 1),
  };
}
