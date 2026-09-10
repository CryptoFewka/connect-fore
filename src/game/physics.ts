/**
 * The ball flight model.
 *
 * Fixed timestep (`COURSE.dt`), no clock reads, no randomness: the same
 * `{ board, params }` always produces a byte-identical trajectory, which is what
 * lets the Durable Object validate a shot the two browsers are animating.
 *
 * Board contact uses a **swept** test. At full power the ball moves ~0.22 units
 * per step, so a point-in-slab check would happily tunnel straight through the
 * panel; instead each step solves for where the segment from the previous
 * position to the new one crosses the board's front face.
 */
import type { Board, CellRef, ShotOutcome, ShotParams, ShotResult } from './types';
import { cellCenter, COLS, COURSE, ROWS } from './types';
import { cellAt } from './rules';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Ball centre height when it is resting on the fairway. */
export const GROUND_Y = COURSE.ballRadius;

/** Ball-centre z at the instant its leading surface touches the board's face. */
export const CONTACT_Z = COURSE.boardZ + COURSE.boardHalfDepth + COURSE.ballRadius;

/** How far the ball may pass from a cell centre and still fit through the hole. */
export const APERTURE_TOLERANCE = COURSE.apertureRadius - COURSE.ballRadius;

/** Solid frame border around the grid of holes. */
export const FRAME_MARGIN = 0.5 * COURSE.cellPitch;
export const BOARD_HALF_WIDTH = (COLS * COURSE.cellPitch) / 2 + FRAME_MARGIN;
export const BOARD_MIN_Y = COURSE.bottomRowY - COURSE.cellPitch / 2 - FRAME_MARGIN;
export const BOARD_MAX_Y =
  COURSE.bottomRowY + (ROWS - 1 + 0.5) * COURSE.cellPitch + FRAME_MARGIN;

/** Straight-line distance from the tee to the board's face. */
export const TEE_TO_BOARD = COURSE.tee.z - CONTACT_Z;

/** Steps the ball keeps flying behind the board after threading, for the camera. */
export const THREAD_FOLLOW_STEPS = 36;

/** Tangential damping when the ball slaps the frame or a disc. */
export const BOARD_TANGENT_DAMP = 0.62;

/** Below this downward speed the ball stops bouncing and starts rolling. */
export const BOUNCE_THRESHOLD = 0.6;

/** Rolling resistance as a deceleration (fairway friction under gravity). */
export const ROLL_DECEL = COURSE.groundFriction * -COURSE.gravity;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clampShotParams(params: ShotParams): ShotParams {
  return {
    yaw: clamp(params.yaw, -COURSE.maxYaw, COURSE.maxYaw),
    loft: clamp(params.loft, COURSE.minLoft, COURSE.maxLoft),
    power: clamp(params.power, 0, 1),
    accuracy: clamp(params.accuracy, -1, 1),
  };
}

/** Launch velocity: yaw swings right (+x), loft lifts, the board is at -z. */
export function launchVelocity(params: ShotParams): Vec3 {
  const speed = params.power * COURSE.maxLaunchSpeed;
  const cosLoft = Math.cos(params.loft);
  return {
    x: speed * cosLoft * Math.sin(params.yaw),
    y: speed * Math.sin(params.loft),
    z: -speed * cosLoft * Math.cos(params.yaw),
  };
}

/**
 * One fixed-timestep integration of gravity, per-axis quadratic drag and the
 * hook/slice side force. Shared by the authoritative sim and the AI's probe so
 * the two can never disagree about a flight path.
 */
export function stepBall(pos: Vec3, vel: Vec3, spin: number): void {
  const dt = COURSE.dt;
  vel.x += (-COURSE.drag * Math.abs(vel.x) * vel.x + spin) * dt;
  vel.y += (COURSE.gravity - COURSE.drag * Math.abs(vel.y) * vel.y) * dt;
  vel.z += -COURSE.drag * Math.abs(vel.z) * vel.z * dt;
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
  pos.z += vel.z * dt;
}

/** Clamps the ball to the fairway; reports whether it touched down or stopped. */
export function resolveGround(pos: Vec3, vel: Vec3): { grounded: boolean; resting: boolean } {
  if (pos.y >= GROUND_Y) return { grounded: false, resting: false };
  pos.y = GROUND_Y;
  if (vel.y < -BOUNCE_THRESHOLD) {
    vel.y = -vel.y * COURSE.groundRestitution;
    vel.x *= COURSE.groundFriction;
    vel.z *= COURSE.groundFriction;
  } else {
    vel.y = 0;
    const roll = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    if (roll > 0) {
      const scale = Math.max(0, roll - ROLL_DECEL * COURSE.dt) / roll;
      vel.x *= scale;
      vel.z *= scale;
    }
  }
  const speedSq = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z;
  if (speedSq < COURSE.restSpeed * COURSE.restSpeed) {
    vel.x = 0;
    vel.y = 0;
    vel.z = 0;
    return { grounded: true, resting: true };
  }
  return { grounded: true, resting: false };
}

export function outOfBounds(pos: Vec3): boolean {
  return (
    Math.abs(pos.x) > COURSE.bounds.x ||
    pos.y > COURSE.bounds.y ||
    pos.z > COURSE.bounds.zBack ||
    pos.z < COURSE.bounds.zPast
  );
}

/** Is a point on the board plane inside the panel (holes plus frame)? */
export function onPanel(x: number, y: number): boolean {
  return Math.abs(x) <= BOARD_HALF_WIDTH && y >= BOARD_MIN_Y && y <= BOARD_MAX_Y;
}

/** Nearest cell to a point on the board plane, or `null` if outside the grid. */
export function cellForPoint(x: number, y: number): CellRef | null {
  // `| 0` also normalises the -0 that Math.round hands back just left of centre,
  // which would otherwise survive into a CellRef and out onto the wire.
  const col = Math.round(x / COURSE.cellPitch + (COLS - 1) / 2) | 0;
  const row = Math.round((y - COURSE.bottomRowY) / COURSE.cellPitch) | 0;
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
  return { col, row };
}

/**
 * Distance from a board-plane point to a cell's centre.
 *
 * `Math.sqrt` rather than `Math.hypot`: sqrt is correctly rounded by IEEE-754
 * everywhere, hypot is not, and this number decides thread versus bounce.
 */
export function distanceToCell(x: number, y: number, cell: CellRef): number {
  const centre = cellCenter(cell.col, cell.row);
  const dx = x - centre.x;
  const dy = y - centre.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export interface PlaneHit {
  /** Fraction of the step at which the front face is crossed, 0..1. */
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

/** Where the segment `prev -> next` crosses the board's front face, if it does. */
export function planeCrossing(prev: Vec3, next: Vec3): PlaneHit | null {
  if (prev.z <= CONTACT_Z || next.z > CONTACT_Z) return null;
  const span = prev.z - next.z;
  const t = span <= 0 ? 0 : (prev.z - CONTACT_Z) / span;
  return {
    t,
    x: prev.x + (next.x - prev.x) * t,
    y: prev.y + (next.y - prev.y) * t,
  };
}

export interface Contact {
  readonly kind: 'thread' | 'bounce';
  /** The aperture threaded, or the cell whose disc was struck (null on frame). */
  readonly cell: CellRef | null;
}

/** Classifies a crossing of the board plane against the current board state. */
export function classifyCrossing(board: Board, hit: PlaneHit): Contact | null {
  if (!onPanel(hit.x, hit.y)) return null; // sailed past the whole panel
  const cell = cellForPoint(hit.x, hit.y);
  if (
    cell !== null &&
    cellAt(board, cell.col, cell.row) === 0 &&
    distanceToCell(hit.x, hit.y, cell) <= APERTURE_TOLERANCE
  ) {
    return { kind: 'thread', cell };
  }
  return { kind: 'bounce', cell };
}

export interface BoardProbe {
  readonly x: number;
  readonly y: number;
  /** Step index at which the plane was crossed. */
  readonly step: number;
  /** True when the ball skipped along the fairway before arriving. */
  readonly grounded: boolean;
}

/**
 * Where a shot would cross the board plane, ignoring the board's contents.
 *
 * The flight up to first contact does not depend on what is on the board, so
 * the aim solver can steer with this instead of paying for a full simulation —
 * and because it shares `stepBall`/`resolveGround` with `runTrajectory`, the
 * two can never disagree about where the ball arrives. `null` when the ball
 * never gets there.
 */
export function probeCrossing(raw: ShotParams): BoardProbe | null {
  const params = clampShotParams(raw);
  const vel = launchVelocity(params);
  const pos: Vec3 = { x: COURSE.tee.x, y: COURSE.tee.y, z: COURSE.tee.z };
  const spinAccel = COURSE.spinAccel * params.accuracy;
  let spinning = true;
  let grounded = false;

  for (let step = 1; step <= COURSE.maxSteps; step++) {
    const prev: Vec3 = { x: pos.x, y: pos.y, z: pos.z };
    stepBall(pos, vel, spinning ? spinAccel : 0);
    const hit = planeCrossing(prev, pos);
    if (hit) return { x: hit.x, y: hit.y, step, grounded };
    const ground = resolveGround(pos, vel);
    if (ground.grounded) {
      spinning = false;
      grounded = true;
    }
    if (ground.resting || outOfBounds(pos)) return null;
  }
  return null;
}

/**
 * Integrates one shot to rest. This is the beating heart of the game; `shot.ts`
 * wraps it with parameter clamping as the public entry point.
 */
export function runTrajectory(board: Board, raw: ShotParams): ShotResult {
  const params = clampShotParams(raw);
  const vel = launchVelocity(params);
  const pos: Vec3 = { x: COURSE.tee.x, y: COURSE.tee.y, z: COURSE.tee.z };

  const points: number[] = [pos.x, pos.y, pos.z];
  const spinAccel = COURSE.spinAccel * params.accuracy;

  let entry: CellRef | null = null;
  let impactStep = -1;
  let threaded = false;
  let bounced = false;
  let crossedPlane = false;
  let spinning = true;
  let steps = 0;

  for (let step = 1; step <= COURSE.maxSteps; step++) {
    const prev: Vec3 = { x: pos.x, y: pos.y, z: pos.z };
    stepBall(pos, vel, spinning ? spinAccel : 0);

    if (!threaded && !bounced) {
      const hit = planeCrossing(prev, pos);
      if (hit) {
        crossedPlane = true;
        const contact = classifyCrossing(board, hit);
        if (contact?.kind === 'thread') {
          threaded = true;
          entry = contact.cell;
          impactStep = step;
          spinning = false;
        } else if (contact?.kind === 'bounce') {
          bounced = true;
          impactStep = step;
          spinning = false;
          // Rewind to the face and kick back out of the board.
          pos.x = hit.x;
          pos.y = hit.y;
          pos.z = CONTACT_Z;
          vel.z = Math.abs(vel.z) * COURSE.boardRestitution;
          vel.x *= BOARD_TANGENT_DAMP;
          vel.y *= BOARD_TANGENT_DAMP;
        }
      }
    }

    const ground = resolveGround(pos, vel);
    if (ground.grounded) spinning = false;

    points.push(pos.x, pos.y, pos.z);
    steps = step;

    if (outOfBounds(pos)) break;
    if (ground.resting) break;
    // Behind the board: give the camera a moment of follow-through, then stop.
    if (threaded && step - impactStep >= THREAD_FOLLOW_STEPS) break;
  }

  const outcome: ShotOutcome = threaded
    ? 'thread'
    : bounced
      ? 'bounce'
      : crossedPlane || Math.abs(pos.x) > COURSE.bounds.x || pos.y > COURSE.bounds.y
        ? 'wide'
        : 'short';

  return {
    outcome,
    entry: threaded ? entry : null,
    points,
    impactStep,
    steps,
  };
}
