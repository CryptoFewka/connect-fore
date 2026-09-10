/**
 * The three-click NES golf meter.
 *
 * 1. AIM      — nudge yaw and loft, then commit.
 * 2. POWER    — a cursor sweeps up; commit to set how hard you swing.
 * 3. ACCURACY — the cursor falls back through a sweet spot at zero; commit
 *               late and you hook left, early and you slice right.
 *
 * Pure state, driven by seconds and axis input, so it behaves identically at
 * any frame rate and can be driven by the AI as easily as by a human.
 */
import { COURSE } from '../game/types';
import type { ShotParams } from '../game/types';
import type { MeterView } from '../render/api';

export type MeterPhase = 'aim' | 'power' | 'accuracy' | 'locked';

/** How far either side of the sweet spot the accuracy cursor can travel. */
export const ACCURACY_RANGE = 0.35;

const AIM_YAW_RATE = 0.42; // radians per second at full deflection
const AIM_LOFT_RATE = 0.5;
const POWER_SPEED = 1.15; // meter fractions per second
const ACCURACY_SPEED = 1.75;
const MIN_POWER = 0.08;

export interface MeterOptions {
  yaw?: number;
  loft?: number;
}

export interface Meter {
  readonly phase: MeterPhase;
  readonly yaw: number;
  readonly loft: number;
  /** Rises through 20 detents across the bar; the session ticks a sound on each. */
  readonly detent: number;
  update(dt: number, axisX: number, axisY: number): void;
  /** Advances to the next phase. Returns true once the shot is fully specified. */
  commit(): boolean;
  view(): MeterView;
  params(): ShotParams;
  reset(options?: MeterOptions): void;
}

export function createMeter(options: MeterOptions = {}): Meter {
  let phase: MeterPhase = 'aim';
  let yaw = options.yaw ?? 0;
  let loft = options.loft ?? 0.42;
  let cursor = 0;
  let power = 0;
  let accuracy = 0;

  const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

  return {
    get phase(): MeterPhase {
      return phase;
    },
    get yaw(): number {
      return yaw;
    },
    get loft(): number {
      return loft;
    },
    get detent(): number {
      return Math.floor(Math.abs(cursor) * 20);
    },

    update(dt: number, axisX: number, axisY: number): void {
      if (phase === 'aim') {
        yaw = clamp(yaw + axisX * AIM_YAW_RATE * dt, -COURSE.maxYaw, COURSE.maxYaw);
        loft = clamp(loft + axisY * AIM_LOFT_RATE * dt, COURSE.minLoft, COURSE.maxLoft);
        return;
      }

      if (phase === 'power') {
        cursor += POWER_SPEED * dt;
        if (cursor >= 1) {
          // Ran the meter out: you swing at full power whether you meant to or not.
          cursor = 1;
          power = 1;
          phase = 'accuracy';
        }
        return;
      }

      if (phase === 'accuracy') {
        cursor -= ACCURACY_SPEED * dt;
        if (cursor <= -ACCURACY_RANGE) {
          // Missed the window entirely — a full hook.
          cursor = -ACCURACY_RANGE;
          accuracy = -1;
          phase = 'locked';
        }
      }
    },

    commit(): boolean {
      switch (phase) {
        case 'aim':
          phase = 'power';
          cursor = 0;
          return false;
        case 'power':
          power = Math.max(MIN_POWER, cursor);
          phase = 'accuracy';
          return false;
        case 'accuracy':
          accuracy = clamp(cursor / ACCURACY_RANGE, -1, 1);
          phase = 'locked';
          return true;
        case 'locked':
          return true;
      }
    },

    view(): MeterView {
      return {
        phase,
        power: phase === 'power' ? cursor : power,
        accuracy: phase === 'accuracy' ? cursor / ACCURACY_RANGE : accuracy,
        cursor: phase === 'accuracy' ? cursor : phase === 'power' ? cursor : 0,
      };
    },

    params(): ShotParams {
      return { yaw, loft, power, accuracy };
    },

    reset(next: MeterOptions = {}): void {
      phase = 'aim';
      yaw = next.yaw ?? 0;
      loft = next.loft ?? 0.42;
      cursor = 0;
      power = 0;
      accuracy = 0;
    },
  };
}
