/**
 * Drives one match, whichever way it is being played.
 *
 * Hot-seat, versus the AI and online all funnel into the same turn machine: a
 * shot is chosen (by a human on the meter, by the AI, or by the server telling
 * us what the opponent did), then simulated, then played back. Because the
 * simulation is deterministic and pure, "play back what the server said" and
 * "play back what I just did" are the same code path.
 */
import { COURSE, cellCenter } from '../game/types';
import type { Board, Difficulty, MatchState, Player, ShotParams, ShotRecord } from '../game/types';
import { applyShot, newMatch } from '../game/match';
import { simulateShot } from '../game/shot';
import { planShot } from '../game/ai';
import { createRng } from '../game/rng';
import type { AudioEngine } from '../audio/api';
import type { CameraShot, HudState, RenderFrame } from '../render/api';
import { createMeter, ACCURACY_RANGE } from './meter';
import type { InputState } from './input';
import { prefersReducedMotion } from './settings';

export type TurnPhase =
  | 'aim'
  | 'power'
  | 'accuracy'
  | 'swing'
  | 'flight'
  | 'drop'
  | 'settle'
  | 'thinking'
  | 'waiting'
  | 'over';

export interface SessionSeats {
  /** Display names by seat. */
  readonly names: readonly [string, string];
  /** Seats this browser is allowed to play; both, for hot-seat. */
  readonly local: readonly Player[];
  readonly connected: readonly [boolean, boolean];
}

export interface SessionHooks {
  /** Online: hand a locked-in shot to the server instead of resolving locally. */
  submitShot?(turn: number, params: ShotParams): void;
  /** Fired after a match ends, once the result banner has settled. */
  onFinished?(state: MatchState): void;
}

const SWING_TIME = 0.32;
const SETTLE_TIME = 1.6;
const THINK_TIME = 0.8;
const DROP_SPEED = 7.5; // world units per second
const FLIGHT_TAIL_STEPS = 72; // keep rolling briefly after impact, then cut

interface PendingShot {
  record: ShotRecord;
  next: MatchState;
  points: readonly number[];
  lastStep: number;
}

export interface Session {
  readonly state: MatchState;
  readonly phase: TurnPhase;
  /** Seat whose shot is being set up or played. */
  readonly shooter: Player;
  update(dt: number, input: InputState): void;
  buildFrame(time: number, hud: Partial<HudState>): RenderFrame;
  /** Online: feed an authoritative resolution in. */
  acceptResolve(record: ShotRecord, next: MatchState): void;
  setState(state: MatchState): void;
  setSeats(seats: SessionSeats): void;
  reset(state?: MatchState): void;
}

export interface SessionOptions {
  audio: AudioEngine;
  seats: SessionSeats;
  /** Present for single player; absent for hot-seat and online. */
  ai?: { seat: Player; difficulty: Difficulty };
  hooks?: SessionHooks;
  /** Deterministic seed for the AI's execution error. */
  seed?: number;
  score?: readonly [number, number];
}

export function createSession(options: SessionOptions): Session {
  const { audio } = options;
  const hooks = options.hooks ?? {};
  const rng = createRng(options.seed ?? 0x5eed1e);
  const meter = createMeter();
  const reduceMotion = prefersReducedMotion();

  let seats = options.seats;
  let score: readonly [number, number] = options.score ?? [0, 0];
  let state: MatchState = newMatch();
  let phase: TurnPhase = 'aim';
  let timer = 0;
  let pending: PendingShot | null = null;
  let flightStep = 0;
  let dropY = 0;
  let dropTargetY = 0;
  let message: string | null = null;
  let lastDetent = -1;
  let shake = 0;
  let aiPlan: ShotParams | null = null;

  const ball = { x: COURSE.tee.x, y: COURSE.tee.y, z: COURSE.tee.z, visible: true };

  const isLocal = (seat: Player): boolean => seats.local.includes(seat);
  const isAi = (seat: Player): boolean => options.ai?.seat === seat;

  function beginTurn(): void {
    pending = null;
    flightStep = 0;
    message = null;
    lastDetent = -1;
    aiPlan = null;
    meter.reset({ yaw: 0, loft: 0.42 });
    ball.x = COURSE.tee.x;
    ball.y = COURSE.tee.y;
    ball.z = COURSE.tee.z;
    ball.visible = true;

    if (state.status !== 'playing') {
      phase = 'over';
      return;
    }
    if (isAi(state.current)) {
      phase = 'thinking';
      timer = THINK_TIME;
      return;
    }
    phase = isLocal(state.current) ? 'aim' : 'waiting';
  }

  function preparePlayback(preBoard: Board, record: ShotRecord, next: MatchState): void {
    const sim = simulateShot(preBoard, record.params);
    const lastStep =
      sim.impactStep >= 0
        ? Math.min(sim.steps, sim.impactStep + FLIGHT_TAIL_STEPS)
        : sim.steps;
    pending = { record, next, points: sim.points, lastStep };
    flightStep = 0;
    phase = 'flight';
    audio.sfx('swing');
  }

  /** Resolve a shot locally (hot-seat and single player). */
  function resolveLocally(params: ShotParams): void {
    const preBoard = state.board;
    const { state: next, record } = applyShot(state, params);
    preparePlayback(preBoard, record, next);
  }

  function commitShot(): void {
    const params = meter.params();
    audio.sfx('meter-lock');
    phase = 'swing';
    timer = SWING_TIME;
    if (hooks.submitShot) {
      // Online: the server is the one that decides what happened.
      hooks.submitShot(state.turn, params);
    } else {
      aiPlan = params;
    }
  }

  function finishShot(): void {
    if (!pending) {
      beginTurn();
      return;
    }
    const { record, next } = pending;
    const previous = state;
    state = next;

    if (record.outcome === 'thread') {
      audio.sfx('thread');
      message = 'THROUGH THE GAP!';
    } else if (record.outcome === 'bounce') {
      audio.sfx('thud');
      message = 'OFF THE BOARD - TURN LOST';
      shake = reduceMotion ? 0 : 0.7;
    } else {
      message = record.outcome === 'short' ? 'SHORT - TURN LOST' : 'WIDE - TURN LOST';
    }

    if (next.status === 'won' && next.winner) {
      const winnerIndex = next.winner - 1;
      score = winnerIndex === 0 ? [score[0] + 1, score[1]] : [score[0], score[1] + 1];
      message = `${seats.names[winnerIndex]} WINS!`;
      audio.sfx(isLocal(next.winner) && seats.local.length === 1 ? 'win' : 'win');
      audio.music('victory');
    } else if (next.status === 'draw') {
      message = 'BOARD FULL - DRAW';
      audio.sfx('draw');
    }

    void previous;
    phase = 'settle';
    timer = SETTLE_TIME;
  }

  function updateMeterPhases(dt: number, input: InputState): void {
    meter.update(dt, input.axisX, input.axisY);
    const detent = meter.detent;
    if ((meter.phase === 'power' || meter.phase === 'accuracy') && detent !== lastDetent) {
      lastDetent = detent;
      if (detent % 2 === 0) audio.sfx('meter-tick');
    }
    if (input.pressed('confirm')) {
      if (meter.commit()) commitShot();
      else audio.sfx('menu-select');
    }
    phase = meter.phase === 'locked' ? phase : meter.phase;
  }

  function updateAiMeter(dt: number): void {
    if (!aiPlan) return;
    meter.update(dt, 0, 0);
    const view = meter.view();
    if (meter.phase === 'power' && view.power >= aiPlan.power) {
      meter.commit();
      audio.sfx('meter-lock');
    } else if (meter.phase === 'accuracy' && view.cursor <= aiPlan.accuracy * ACCURACY_RANGE) {
      if (meter.commit()) commitShot();
    }
    const detent = meter.detent;
    if (detent !== lastDetent) {
      lastDetent = detent;
      if (detent % 2 === 0) audio.sfx('meter-tick');
    }
    phase = meter.phase === 'locked' ? phase : meter.phase;
  }

  function updateFlight(dt: number): void {
    if (!pending) return;
    flightStep += dt / COURSE.dt;
    const step = Math.min(Math.floor(flightStep), pending.lastStep);
    const i = step * 3;
    const pts = pending.points;
    ball.x = pts[i] ?? ball.x;
    ball.y = pts[i + 1] ?? ball.y;
    ball.z = pts[i + 2] ?? ball.z;

    if (step >= pending.lastStep) {
      const { record } = pending;
      if (record.outcome === 'thread' && record.entry && record.rest) {
        ball.visible = false;
        dropY = cellCenter(record.entry.col, record.entry.row).y;
        dropTargetY = cellCenter(record.rest.col, record.rest.row).y;
        audio.sfx('drop');
        phase = 'drop';
      } else {
        finishShot();
      }
    }
  }

  function updateDrop(dt: number): void {
    dropY -= DROP_SPEED * dt;
    if (dropY <= dropTargetY) {
      dropY = dropTargetY;
      audio.sfx('clack');
      finishShot();
    }
  }

  return {
    get state(): MatchState {
      return state;
    },
    get phase(): TurnPhase {
      return phase;
    },
    get shooter(): Player {
      return state.current;
    },

    update(dt: number, input: InputState): void {
      shake = Math.max(0, shake - dt * 2);

      switch (phase) {
        case 'aim':
        case 'power':
        case 'accuracy':
          updateMeterPhases(dt, input);
          break;

        case 'thinking': {
          timer -= dt;
          if (timer <= 0) {
            const plan = planShot(state.board, state.current, options.ai?.difficulty ?? 'normal', rng);
            aiPlan = plan;
            meter.reset({ yaw: plan.yaw, loft: plan.loft });
            meter.commit(); // leave aim, start the power sweep
            phase = 'power';
          }
          break;
        }

        case 'swing':
          timer -= dt;
          if (timer <= 0) {
            if (hooks.submitShot) {
              phase = 'waiting';
            } else if (aiPlan) {
              resolveLocally(aiPlan);
              aiPlan = null;
            }
          }
          break;

        case 'flight':
          updateFlight(dt);
          break;

        case 'drop':
          updateDrop(dt);
          break;

        case 'settle':
          timer -= dt;
          if (timer <= 0) {
            if (state.status === 'playing') {
              beginTurn();
            } else {
              phase = 'over';
              hooks.onFinished?.(state);
            }
          }
          break;

        case 'waiting':
          if (isAi(state.current)) beginTurn();
          break;

        case 'over':
          break;
      }

      if (phase === 'power' || phase === 'accuracy') {
        if (isAi(state.current)) updateAiMeter(dt);
      }
    },

    buildFrame(time: number, hud: Partial<HudState>): RenderFrame {
      const aiming = phase === 'aim' || phase === 'power' || phase === 'accuracy' || phase === 'swing';
      const camera: CameraShot =
        phase === 'over'
          ? 'result'
          : phase === 'drop' || phase === 'settle'
            ? 'board'
            : phase === 'flight'
              ? 'follow'
              : aiming
                ? 'address'
                : 'board';

      const showMeter = aiming && phase !== 'swing';
      const active = state.current;

      return {
        board: state.board,
        ball: { ...ball, visible: ball.visible && phase !== 'drop' },
        aim: aiming ? { yaw: meter.yaw, loft: meter.loft } : null,
        camera,
        fallingDisc:
          phase === 'drop' && pending?.record.rest
            ? { player: pending.record.player, col: pending.record.rest.col, y: dropY }
            : null,
        highlight: state.status === 'won' ? state.winLine : null,
        shake,
        time,
        hud: {
          visible: true,
          title: null,
          subtitle: null,
          message,
          players: [1, 2].map((seat) => ({
            name: seats.names[seat - 1] ?? `P${seat}`,
            player: seat as Player,
            score: score[seat - 1] ?? 0,
            active: active === seat && state.status === 'playing',
            connected: seats.connected[seat - 1] ?? true,
          })),
          meter: showMeter ? meter.view() : null,
          roomCode: null,
          hint: hintFor(phase, isLocal(active) && !isAi(active)),
          menu: null,
          ...hud,
        },
      };
    },

    acceptResolve(record: ShotRecord, next: MatchState): void {
      if (record.turn !== state.turn) return; // stale broadcast
      preparePlayback(state.board, record, next);
    },

    setState(next: MatchState): void {
      state = next;
      beginTurn();
    },

    setSeats(next: SessionSeats): void {
      seats = next;
    },

    reset(next?: MatchState): void {
      state = next ?? newMatch();
      shake = 0;
      beginTurn();
    },
  };
}

function hintFor(phase: TurnPhase, yours: boolean): string | null {
  switch (phase) {
    case 'aim':
      return yours ? 'ARROWS AIM   FIRE TO SET' : null;
    case 'power':
      return yours ? 'FIRE TO SET POWER' : null;
    case 'accuracy':
      return yours ? 'FIRE ON THE SWEET SPOT' : null;
    case 'waiting':
      return 'OPPONENT IS AWAY';
    case 'thinking':
      return 'OPPONENT IS LINING UP';
    case 'over':
      return 'FIRE FOR A REMATCH';
    default:
      return null;
  }
}
