/**
 * Public entry point for simulating a swing.
 *
 * Both browsers and the Durable Object call `simulateShot` with the same board
 * and the same four numbers and get the same flight path back, point for point.
 * `hashTrajectory` gives the netcode a cheap way to assert that.
 */
import type { Board, ShotParams, ShotResult } from './types';
import { COURSE } from './types';
import { clampShotParams, runTrajectory } from './physics';

export { clampShotParams };

/** Simulate a shot at a board. Pure, deterministic, allocation-light. */
export function simulateShot(board: Board, params: ShotParams): ShotResult {
  return runTrajectory(board, params);
}

/** Ball position at a step index, for the renderer's playback cursor. */
export function pointAt(
  result: ShotResult,
  step: number,
): { x: number; y: number; z: number } {
  const clamped = Math.max(0, Math.min(result.steps, Math.floor(step)));
  const i = clamped * 3;
  return {
    x: result.points[i] ?? 0,
    y: result.points[i + 1] ?? 0,
    z: result.points[i + 2] ?? 0,
  };
}

/** Wall-clock duration of the flight, derived from the fixed timestep. */
export function flightSeconds(result: ShotResult): number {
  return result.steps * COURSE.dt;
}

/**
 * 32-bit FNV-ish hash of a trajectory, quantised to 1e-4 so it survives a JSON
 * round trip. Used by tests and by the room to detect a client/server drift.
 */
export function hashTrajectory(result: ShotResult): number {
  let h = 0x811c9dc5;
  const mix = (value: number): void => {
    const q = Math.round(value * 10000) | 0;
    h ^= q & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  for (const value of result.points) mix(value);
  mix(result.steps);
  mix(result.impactStep);
  mix(result.outcome.length);
  mix(result.entry ? result.entry.col * 10 + result.entry.row + 1 : 0);
  return h >>> 0;
}
