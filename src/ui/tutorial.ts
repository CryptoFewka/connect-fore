/**
 * The five-step aiming lesson.
 *
 * It runs on top of a live driving range and gates every step on the player
 * actually doing the thing - move the aim, set the loft, stop the bar, catch
 * the sweet spot, thread a gap - so it cannot be skimmed past by tapping. When
 * the last step lands it gets out of the way and leaves the range running.
 *
 * It reads only the session's public surface, so it knows nothing about how a
 * shot is simulated and cannot get the game into a state of its own.
 */
import type { ShotOutcome } from '../game/types';

export type TutorialStep = 'aim' | 'loft' | 'power' | 'accuracy' | 'thread' | 'done';

/** What the tutorial needs to watch. Everything is already on `Session`. */
export interface TutorialView {
  readonly phase: string;
  readonly aim: { yaw: number; loft: number };
  /** The turn counter, used to notice that a shot resolved. */
  readonly turn: number;
  readonly lastOutcome: ShotOutcome | null;
}

export interface TutorialCoaching {
  /** The call-out over the board. */
  readonly message: string;
  /** The bottom prompt: which step this is, and what to do. */
  readonly hint: string;
}

export interface Tutorial {
  readonly step: TutorialStep;
  readonly finished: boolean;
  /** Advances the lesson. Returns true on the frame a step is completed. */
  update(view: TutorialView): boolean;
  /** Null once the lesson is over. */
  coaching(): TutorialCoaching | null;
}

const ORDER: readonly TutorialStep[] = ['aim', 'loft', 'power', 'accuracy', 'thread'];

/** Enough movement to be a deliberate nudge rather than a twitch. */
const AIM_MOVED = 0.05;
const LOFT_MOVED = 0.05;

/**
 * The hint bar is one line of the 5x7 font across a 256px screen and it clips
 * silently at both ends, so nothing here may exceed `MAX_HINT`.
 */
export const MAX_HINT = 40;

const COPY: Record<Exclude<TutorialStep, 'done'>, TutorialCoaching> = {
  aim: {
    message: 'SWING YOUR AIM',
    hint: 'STEP 1/5   AIM LEFT AND RIGHT',
  },
  loft: {
    message: 'NOW SET THE LOFT',
    hint: 'STEP 2/5   AIM UP AND DOWN',
  },
  power: {
    message: 'STOP THE POWER BAR',
    hint: 'STEP 3/5   FIRE TO LOCK, THEN STOP',
  },
  accuracy: {
    message: 'CATCH THE SWEET SPOT',
    hint: 'STEP 4/5   STOP IT IN THE GREEN BAND',
  },
  thread: {
    message: 'NOW THREAD A GAP',
    hint: 'STEP 5/5   PUT ONE THROUGH THE BOARD',
  },
};

/** Every step's coaching, for tests and for anyone editing the copy. */
export const ALL_COACHING: readonly TutorialCoaching[] = Object.values(COPY);

export function createTutorial(): Tutorial {
  let index = 0;
  let baseYaw: number | null = null;
  let baseLoft: number | null = null;
  let lastTurn = -1;

  const current = (): TutorialStep => ORDER[index] ?? 'done';

  return {
    get step(): TutorialStep {
      return current();
    },
    get finished(): boolean {
      return current() === 'done';
    },

    update(view: TutorialView): boolean {
      const step = current();
      if (step === 'done') return false;

      // Anchor against wherever the aim happens to be sitting, since it is kept
      // between shots and so does not start at zero.
      if (baseYaw === null) baseYaw = view.aim.yaw;
      if (baseLoft === null) baseLoft = view.aim.loft;

      let done = false;
      switch (step) {
        case 'aim':
          done = Math.abs(view.aim.yaw - baseYaw) >= AIM_MOVED;
          break;
        case 'loft':
          done = Math.abs(view.aim.loft - baseLoft) >= LOFT_MOVED;
          break;
        case 'power':
          // Reaching the accuracy sweep means the power was locked.
          done = view.phase === 'accuracy';
          break;
        case 'accuracy':
          // The swing starts the moment the third press lands.
          done = view.phase === 'swing' || view.phase === 'flight';
          break;
        case 'thread':
          done = view.turn !== lastTurn && view.lastOutcome === 'thread';
          break;
      }

      if (view.turn !== lastTurn) lastTurn = view.turn;
      if (!done) return false;

      index += 1;
      // Re-anchor so the next step measures from here.
      baseYaw = view.aim.yaw;
      baseLoft = view.aim.loft;
      return true;
    },

    coaching(): TutorialCoaching | null {
      const step = current();
      return step === 'done' ? null : COPY[step];
    },
  };
}
