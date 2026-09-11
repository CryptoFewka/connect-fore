/**
 * Contract between the game loop and the NES-style 3D renderer.
 *
 * The renderer is declarative: the game builds a `RenderFrame` every animation
 * frame and hands it over. The renderer owns no game state and makes no
 * decisions, which keeps the sim authoritative and the visuals swappable.
 */
import type { Board, Player, WinLine } from '../game/types';

export type CameraShot =
  /** Slow orbit behind the board, used on menus. */
  | 'title'
  /** Over the shoulder at the tee. */
  | 'address'
  /** Chase the ball in flight. */
  | 'follow'
  /** Square on to the board, for the drop. */
  | 'board'
  /** Pull back on the winning line. */
  | 'result';

export interface MeterView {
  phase: 'aim' | 'power' | 'accuracy' | 'locked';
  /** 0..1 filled portion of the power bar. */
  power: number;
  /** -1..1 marker offset; 0 is the sweet spot. */
  accuracy: number;
  /**
   * Half-width, in accuracy units, of the band that counts as a dead-straight
   * strike. Drawn as a zone on the bar so the player can see what to aim for.
   */
  perfect: number;
  /** 0..1 position of the sweeping cursor. */
  cursor: number;
}

export interface HudPlayerView {
  name: string;
  player: Player;
  score: number;
  active: boolean;
  /** Shown greyed out when an online opponent drops. */
  connected: boolean;
}

export interface HudState {
  visible: boolean;
  /** Large centred banner, e.g. `CONNECT FORE!`. */
  title: string | null;
  subtitle: string | null;
  /** Transient call-out, e.g. `THROUGH THE GAP!`. */
  message: string | null;
  players: readonly HudPlayerView[];
  meter: MeterView | null;
  roomCode: string | null;
  /** Bottom-of-screen prompt. */
  hint: string | null;
  /** A block of left-aligned lines, for the instructions screen. */
  panel: { lines: readonly string[] } | null;
  menu: { items: readonly string[]; index: number } | null;
}

export interface RenderFrame {
  /** Discs currently resting on the board. */
  board: Board;
  /** Ball position in world space; hidden between shots. */
  ball: { x: number; y: number; z: number; visible: boolean };
  /** Aim guide, shown while addressing the ball. */
  aim: { yaw: number; loft: number } | null;
  camera: CameraShot;
  /** A disc mid-fall down a column, positioned by world-space `y`. */
  fallingDisc: { player: Player; col: number; y: number } | null;
  /**
   * A disc being destroyed, `t` running 0 to 1. The cell is drawn empty and a
   * burst plays in its place.
   */
  explosion: { col: number; row: number; t: number } | null;
  /**
   * The stack above a destroyed disc sliding into the gap: every disc in `col`
   * above `aboveRow` is drawn `offset` cells lower (0 to 1). During the slide
   * `board` still holds the *pre*-explosion arrangement, so the discs being
   * animated are the ones that actually moved.
   */
  collapse: { col: number; aboveRow: number; offset: number } | null;
  /** Flash the four winning discs. */
  highlight: WinLine | null;
  /** 0..1 screen shake, ignored under `prefers-reduced-motion`. */
  shake: number;
  hud: HudState;
  /** Seconds since boot; drives idle animation and HUD blink. */
  time: number;
}

export interface Renderer {
  readonly canvas: HTMLCanvasElement;
  render(frame: RenderFrame): void;
  /** Recompute the integer upscale factor and letterboxing. */
  resize(): void;
  dispose(): void;
}
