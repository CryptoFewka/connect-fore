/**
 * Drives one match, whichever way it is being played.
 *
 * Hot-seat, versus the AI and online all funnel into the same turn machine: a
 * shot is chosen (by a human on the meter, by the AI, or by the server telling
 * us what the opponent did), then simulated, then played back. Because the
 * simulation is deterministic and pure, "play back what the server said" and
 * "play back what I just did" are the same code path.
 */
import { COURSE, ROWS, cellCenter } from '../game/types';
import type {
  Board,
  CellRef,
  Difficulty,
  MatchState,
  Player,
  ShotParams,
  ShotRecord,
} from '../game/types';
import { applyShot, newMatch } from '../game/match';
import { chooseRivalColumn, rivalDue, threadsUntilRival } from '../game/practice';
import { dropPiece, findWin } from '../game/rules';
import { simulateShot } from '../game/shot';
import { planShot } from '../game/ai';
import { createRng } from '../game/rng';
import type { AudioEngine } from '../audio/api';
import type { CameraShot, HudState, RenderFrame } from '../render/api';
import { createMeter, ACCURACY_RANGE } from './meter';
import type { MeterOptions } from './meter';
import type { InputState } from './input';
import { prefersReducedMotion } from './settings';

export type TurnPhase =
  | 'aim'
  | 'power'
  | 'accuracy'
  | 'swing'
  | 'flight'
  | 'drop'
  | 'explode'
  | 'rival'
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
/** Seconds the burst plays before the stack starts sliding into the gap. */
const BLAST_TIME = 0.45;
/** Seconds the collapse itself takes. */
const COLLAPSE_TIME = 0.3;
const FLIGHT_TAIL_STEPS = 72; // keep rolling briefly after impact, then cut
/** Radians of aim per full canvas-width drag. Tuned for a thumb, not a mouse. */
const DRAG_YAW = 0.9;
const DRAG_LOFT = 1.1;

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
  /** Where the meter is currently pointed. */
  readonly aim: { yaw: number; loft: number };
  /** Range only: shots still to thread before the next rival puck. */
  readonly threadsToRival: number | null;
  update(dt: number, input: InputState): void;
  buildFrame(time: number, hud: Partial<HudState>): RenderFrame;
  /** Online: feed an authoritative resolution in. */
  acceptResolve(record: ShotRecord, next: MatchState): void;
  setState(state: MatchState): void;
  setSeats(seats: SessionSeats): void;
  reset(state?: MatchState): void;
}

/**
 * The driving range: one player takes every shot, and a rival puck drops in
 * now and then to spoil the line they were building.
 */
export interface PracticeOptions {
  /** The seat that shoots, every turn, forever. */
  readonly shooter: Player;
  /** The seat the interfering pucks belong to. */
  readonly rival: Player;
}

export interface SessionOptions {
  audio: AudioEngine;
  /** Physical feedback on impacts. A no-op in a browser. */
  haptic?: (weight: 'light' | 'medium' | 'heavy') => void;
  seats: SessionSeats;
  /** Set for the driving range; absent for a real match. */
  practice?: PracticeOptions;
  /** Present for single player; absent for hot-seat and online. */
  ai?: { seat: Player; difficulty: Difficulty };
  hooks?: SessionHooks;
  /** Deterministic seed for the AI's execution error. */
  seed?: number;
  score?: readonly [number, number];
}

export function createSession(options: SessionOptions): Session {
  const { audio } = options;
  const haptic = options.haptic ?? ((): void => {});
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
  /** Board as it stood before the blast, held so the slide can be animated. */
  let preBlastBoard: Board | null = null;
  let blastT = 0;
  let collapseT = 0;
  let message: string | null = null;
  let lastDetent = -1;
  let shake = 0;
  let aiPlan: ShotParams | null = null;
  let touch = false;
  const practice = options.practice;
  /** Range only: shots threaded so far, which is what arms the rival puck. */
  let threads = 0;
  /** Range only: a rival puck queued to drop once the shot's caption clears. */
  let rivalCol: number | null = null;
  /** Range only: the rival puck's landing, held while it falls. */
  let rivalLanding: { board: Board; rest: CellRef } | null = null;

  const ball: { x: number; y: number; z: number; visible: boolean } = {
    x: COURSE.tee.x,
    y: COURSE.tee.y,
    z: COURSE.tee.z,
    visible: true,
  };

  /**
   * The aim each seat left the meter on. Kept per seat so two players sharing a
   * screen don't fight over one setting, and so the CPU lining up its own shot
   * never disturbs yours.
   */
  const lastAim: Partial<Record<Player, MeterOptions>> = {};

  const isLocal = (seat: Player): boolean => seats.local.includes(seat);
  const isAi = (seat: Player): boolean => options.ai?.seat === seat;

  function beginTurn(): void {
    pending = null;
    flightStep = 0;
    preBlastBoard = null;
    blastT = 0;
    collapseT = 0;
    message = null;
    lastDetent = -1;
    aiPlan = null;
    meter.reset(lastAim[state.current]);
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
    lastAim[state.current] = { yaw: params.yaw, loft: params.loft };
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
    // In the range the honour never passes: whatever `applyShot` decided, the
    // same player is up again.
    state = practice ? { ...next, current: practice.shooter } : next;

    if (practice && record.outcome === 'thread') {
      threads += 1;
      if (rivalDue(threads, state.board, practice.shooter)) {
        const col = chooseRivalColumn(state.board, practice.shooter, practice.rival);
        rivalCol = col >= 0 ? col : null;
      }
    }

    if (record.outcome === 'thread') {
      audio.sfx('thread');
      haptic('light');
      message = 'THROUGH THE GAP!';
    } else if (record.outcome === 'bounce') {
      audio.sfx('thud');
      haptic('medium');
      message = 'OFF THE BOARD - TURN LOST';
      shake = reduceMotion ? 0 : 0.7;
    } else if (record.outcome === 'explode') {
      // The blast already played at the start of the phase; this is the caption.
      message = 'DIRECT HIT - STACK DOWN!';
    } else {
      message = record.outcome === 'short' ? 'SHORT - TURN LOST' : 'WIDE - TURN LOST';
    }

    if (next.status === 'won' && next.winner) {
      const winnerIndex = next.winner - 1;
      score = winnerIndex === 0 ? [score[0] + 1, score[1]] : [score[0], score[1] + 1];
      if (practice) {
        message = 'FOUR IN A ROW!';
        audio.sfx('win');
      } else {
        message = `${seats.names[winnerIndex]} WINS!`;
        // Playing one side of the match: it matters which way it went.
        const lost = seats.local.length === 1 && !isLocal(next.winner);
        audio.sfx(lost ? 'lose' : 'win');
        audio.music('victory');
      }
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
    if (meter.phase === 'aim') {
      meter.nudge(input.dragDeltaX * DRAG_YAW, -input.dragDeltaY * DRAG_LOFT);
    }

    const detent = meter.detent;
    if ((meter.phase === 'power' || meter.phase === 'accuracy') && detent !== lastDetent) {
      lastDetent = detent;
      if (detent % 2 === 0) audio.sfx('meter-tick');
    }

    // Aiming commits on a completed tap, so a drag can steer without locking the
    // shot the instant a finger lands. Power and accuracy commit on the way
    // down, because there the timing is the whole game.
    const commit = meter.phase === 'aim' ? input.pressed('select') : input.pressed('confirm');
    if (commit) {
      if (meter.commit()) commitShot();
      else audio.sfx('menu-select');
    }

    // The accuracy cursor can run off the end of its travel on its own, locking
    // a full hook. Nothing else fires the shot in that case, so a player who
    // hesitated would be left staring at a dead meter with no way to take a
    // turn ever again. Let the bad shot go.
    if (meter.phase === 'locked' && phase !== 'swing') {
      commitShot();
      return;
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
      } else if (record.outcome === 'explode' && record.destroyed) {
        // Hold the old board on screen so the stack can be seen to fall.
        preBlastBoard = state.board;
        blastT = 0;
        collapseT = 0;
        shake = reduceMotion ? 0 : 1;
        audio.sfx('explode');
        haptic('heavy');
        phase = 'explode';
      } else {
        finishShot();
      }
    }
  }

  /**
   * Drops the queued rival puck once the shot's own caption has cleared, using
   * the same fall animation a threaded disc gets - it should look like a puck
   * arriving, not like the board quietly changing behind your back.
   */
  function beginRivalDrop(): boolean {
    if (!practice || rivalCol === null) return false;
    const col = rivalCol;
    rivalCol = null;
    const landed = dropPiece(state.board, col, practice.rival);
    if (!landed) return false;

    rivalLanding = landed;
    dropY = cellCenter(col, ROWS - 1).y + COURSE.cellPitch;
    dropTargetY = cellCenter(landed.rest.col, landed.rest.row).y;
    message = 'RIVAL PUCK INCOMING!';
    audio.sfx('drop');
    phase = 'rival';
    return true;
  }

  function updateRivalDrop(dt: number): void {
    dropY -= DROP_SPEED * dt;
    if (dropY > dropTargetY) return;

    dropY = dropTargetY;
    audio.sfx('clack');
    if (rivalLanding) {
      const board = rivalLanding.board;
      const win = findWin(board);
      state = {
        ...state,
        board,
        // chooseRivalColumn refuses to complete four for the rival, so a line
        // here can only be the player's own, made by the puck landing on top.
        status: win ? 'won' : state.status,
        winner: win ? win.player : state.winner,
        winLine: win ? win.line : state.winLine,
      };
      rivalLanding = null;
    }
    message = null;
    beginTurn();
  }

  function updateExplode(dt: number): void {
    if (blastT < 1) {
      blastT = Math.min(1, blastT + dt / BLAST_TIME);
      return;
    }
    if (collapseT === 0) audio.sfx('clack');
    collapseT = Math.min(1, collapseT + dt / COLLAPSE_TIME);
    if (collapseT >= 1) finishShot();
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
    get aim(): { yaw: number; loft: number } {
      return { yaw: meter.yaw, loft: meter.loft };
    },
    get threadsToRival(): number | null {
      return practice ? threadsUntilRival(threads, state.board, practice.shooter) : null;
    },

    update(dt: number, input: InputState): void {
      shake = Math.max(0, shake - dt * 2);
      if (input.isTouch) touch = true;

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

        case 'explode':
          updateExplode(dt);
          break;

        case 'settle':
          timer -= dt;
          if (timer <= 0) {
            if (practice && state.status !== 'playing') {
              // The range never ends. Wipe the board and keep swinging.
              threads = 0;
              rivalCol = null;
              state = newMatch(practice.shooter);
              beginTurn();
            } else if (beginRivalDrop()) {
              // Handled: the puck is on its way down.
            } else if (state.status === 'playing') {
              beginTurn();
            } else {
              phase = 'over';
              hooks.onFinished?.(state);
            }
          }
          break;

        case 'rival':
          updateRivalDrop(dt);
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
          : phase === 'drop' || phase === 'settle' || phase === 'rival'
            ? 'board'
            : phase === 'flight'
              ? 'follow'
              : aiming
                ? 'address'
                : 'board';

      const showMeter = aiming && phase !== 'swing';
      const active = state.current;

      const blasting = phase === 'explode';
      const destroyed = pending?.record.destroyed ?? null;

      return {
        // Mid-blast the old arrangement stays on screen, so the discs the
        // player watches slide are the ones that actually moved.
        board: blasting && preBlastBoard ? preBlastBoard : state.board,
        ball: { ...ball, visible: ball.visible && phase !== 'drop' && phase !== 'rival' && !blasting },
        aim: aiming ? { yaw: meter.yaw, loft: meter.loft } : null,
        camera,
        fallingDisc:
          phase === 'drop' && pending?.record.rest
            ? { player: pending.record.player, col: pending.record.rest.col, y: dropY }
            : phase === 'rival' && rivalLanding && practice
              ? { player: practice.rival, col: rivalLanding.rest.col, y: dropY }
              : null,
        explosion:
          blasting && destroyed ? { col: destroyed.col, row: destroyed.row, t: blastT } : null,
        collapse:
          blasting && destroyed
            ? { col: destroyed.col, aboveRow: destroyed.row, offset: collapseT }
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
          hint: hintFor(phase, isLocal(active) && !isAi(active), touch),
          panel: null,
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
      state = next ?? newMatch(practice?.shooter);
      threads = 0;
      rivalCol = null;
      rivalLanding = null;
      // A brand new match starts everyone back at the default aim.
      delete lastAim[1];
      delete lastAim[2];
      shake = 0;
      beginTurn();
    },
  };
}

function hintFor(phase: TurnPhase, yours: boolean, touch: boolean): string | null {
  switch (phase) {
    case 'aim':
      return yours ? (touch ? 'DRAG TO AIM   TAP TO SET' : 'ARROWS AIM   FIRE TO SET') : null;
    case 'power':
      return yours ? (touch ? 'TAP TO SET POWER' : 'FIRE TO SET POWER') : null;
    case 'accuracy':
      return yours ? (touch ? 'TAP ON THE SWEET SPOT' : 'FIRE ON THE SWEET SPOT') : null;
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
