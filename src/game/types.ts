/**
 * Shared vocabulary for Connect Fore!
 *
 * Everything in `src/game/**` is pure: no DOM, no WebGL, no `Math.random`, no
 * `Date.now`. That is what lets the Cloudflare Durable Object run the exact same
 * simulation the browser runs, so both ends of an online match agree on the
 * outcome of a shot without streaming positions.
 */

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export const COLS = 7;
export const ROWS = 6;
export const CELL_COUNT = COLS * ROWS;

/** 1 = red (player one), 2 = yellow (player two), 0 = empty. */
export type Player = 1 | 2;
export type Cell = 0 | Player;

/** Length 42. Index is `row * COLS + col`; **row 0 is the bottom row**. */
export type Board = readonly Cell[];

export interface CellRef {
  readonly col: number;
  readonly row: number;
}

/** Four board indices, in order, that make up a winning line. */
export type WinLine = readonly [number, number, number, number];

// ---------------------------------------------------------------------------
// Course geometry — the single source of truth for both the sim and the 3D scene
// ---------------------------------------------------------------------------

export const COURSE = {
  /** Seconds per physics step. Fixed; never derived from frame time. */
  dt: 1 / 120,
  /** Hard cap on a single shot's simulation. */
  maxSteps: 1200,

  gravity: -9.8,
  /** Quadratic-ish air drag coefficient applied per axis. */
  drag: 0.08,
  /** Lateral acceleration per unit of accuracy error (the hook/slice curve). */
  spinAccel: 3.6,

  ballRadius: 0.16,
  /** Ball rests here at address. The board sits at z = 0, facing -z. */
  tee: { x: 0, y: 0.16, z: 14 },

  /** Distance between neighbouring cell centres, both axes. */
  cellPitch: 1.0,
  /** Radius of the circular hole in an empty cell. */
  apertureRadius: 0.42,
  /** Board face plane. */
  boardZ: 0,
  /** Half-thickness of the board slab in z. */
  boardHalfDepth: 0.18,
  /** Height of the bottom row's centre above the ground. */
  bottomRowY: 1.1,

  /** Restitution/friction when the ball bounces off the frame or a disc. */
  boardRestitution: 0.45,
  groundRestitution: 0.38,
  groundFriction: 0.72,

  /** Ball is "gone" past these bounds; the shot ends. */
  bounds: { x: 12, y: 24, zBack: 20, zPast: -6 },
  /** Below this speed on the ground the ball is considered stopped. */
  restSpeed: 0.35,

  /** Launch speed at power = 1. */
  maxLaunchSpeed: 21.5,
  minLoft: 0.02,
  maxLoft: 0.95,
  maxYaw: 0.55,
} as const;

/** Centre of a cell in world space. */
export function cellCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: (col - (COLS - 1) / 2) * COURSE.cellPitch,
    y: COURSE.bottomRowY + row * COURSE.cellPitch,
  };
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

export interface ShotParams {
  /** Radians. 0 aims at board centre; positive is right. */
  readonly yaw: number;
  /** Radians above horizontal. */
  readonly loft: number;
  /** 0..1 of `COURSE.maxLaunchSpeed`. */
  readonly power: number;
  /** -1..1. 0 is a pure strike; negative hooks left, positive slices right. */
  readonly accuracy: number;
}

export type ShotOutcome =
  /** Passed cleanly through an empty aperture — a piece is placed. */
  | 'thread'
  /** Hit the frame or a placed disc — turn forfeited. */
  | 'bounce'
  /** Never reached the board — turn forfeited. */
  | 'short'
  /** Left the play area without touching the board — turn forfeited. */
  | 'wide';

export interface ShotResult {
  readonly outcome: ShotOutcome;
  /** Aperture the ball passed through, when `outcome === 'thread'`. */
  readonly entry: CellRef | null;
  /** Flat `x, y, z` triples, one per simulated step (index 0 = tee). */
  readonly points: readonly number[];
  /** Step index of board contact (thread or bounce), or -1. */
  readonly impactStep: number;
  /** Total steps simulated. `points.length === (steps + 1) * 3`. */
  readonly steps: number;
}

// ---------------------------------------------------------------------------
// Match state
// ---------------------------------------------------------------------------

export type MatchStatus = 'playing' | 'won' | 'draw';

export interface ShotRecord {
  readonly turn: number;
  readonly player: Player;
  readonly params: ShotParams;
  readonly outcome: ShotOutcome;
  readonly entry: CellRef | null;
  /** Cell the disc settled in after falling, when a piece was placed. */
  readonly rest: CellRef | null;
}

export interface MatchState {
  readonly board: Board;
  /** Monotonic shot counter; also the lockstep sequence number. */
  readonly turn: number;
  readonly current: Player;
  readonly status: MatchStatus;
  readonly winner: Player | null;
  readonly winLine: WinLine | null;
  readonly lastShot: ShotRecord | null;
}

export type Difficulty = 'easy' | 'normal' | 'hard';
