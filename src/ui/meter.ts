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

/**
 * Aim rate ramps: threading an aperture needs roughly a degree of yaw, so a
 * tap has to be finer than one aperture width, while a long hold still has to
 * cross the whole board in a sensible time.
 */
const AIM_YAW_RATE = 0.11; // radians per second from a standing start
const AIM_YAW_RATE_MAX = 0.5;
const AIM_RAMP_TIME = 0.7; // seconds of continuous hold to reach full rate
const AIM_LOFT_RATE = 0.32;
const POWER_SPEED = 0.62; // meter fractions per second
const ACCURACY_SPEED = 1.1;
const MIN_POWER = 0.08;
/**
 * Where a fresh match starts you: about 32 degrees of elevation. Lofted shots
 * have tighter power windows than flat ones, but the aim you set is kept from
 * one shot to the next, so this is only ever a starting point.
 */
export const DEFAULT_LOFT = 0.5618;

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
  /**
   * Move the aim directly, in radians. A dragging finger steers the shot
   * one-to-one rather than through the ramped key rate, so the aim tracks the
   * thumb instead of drifting after it.
   */
  nudge(dYaw: number, dLoft: number): void;
  /** Advances to the next phase. Returns true once the shot is fully specified. */
  commit(): boolean;
  view(): MeterView;
  params(): ShotParams;
  reset(options?: MeterOptions): void;
}

export function createMeter(options: MeterOptions = {}): Meter {
  let phase: MeterPhase = 'aim';
  let yaw = options.yaw ?? 0;
  let loft = options.loft ?? DEFAULT_LOFT;
  let cursor = 0;
  let power = 0;
  let accuracy = 0;
  let aimHeld = 0;

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
        const nudging = axisX !== 0 || axisY !== 0;
        aimHeld = nudging ? aimHeld + dt : 0;
        const ramp = Math.min(1, aimHeld / AIM_RAMP_TIME);
        const yawRate = AIM_YAW_RATE + (AIM_YAW_RATE_MAX - AIM_YAW_RATE) * ramp * ramp;
        yaw = clamp(yaw + axisX * yawRate * dt, -COURSE.maxYaw, COURSE.maxYaw);
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

    nudge(dYaw: number, dLoft: number): void {
      if (phase !== 'aim') return;
      yaw = clamp(yaw + dYaw, -COURSE.maxYaw, COURSE.maxYaw);
      loft = clamp(loft + dLoft, COURSE.minLoft, COURSE.maxLoft);
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
      loft = next.loft ?? DEFAULT_LOFT;
      cursor = 0;
      power = 0;
      accuracy = 0;
      aimHeld = 0;
    },
  };
}
