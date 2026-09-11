/**
 * The driving range's rules.
 *
 * The range is practice, not a match: you take every shot, and once you have a
 * few pucks down a rival puck appears now and then to get in the way. It is a
 * nuisance with a purpose - it blocks the win you were lining up, so you have
 * to find another line - but it is never allowed to beat you.
 *
 * Pure, like the rest of `src/game/**`: no DOM, no clock, no randomness.
 */
import type { Board, Player } from './types';
import { chooseColumn, immediateWins } from './ai';
import { isColumnFull, isWinningMove, legalColumns } from './rules';

export const RANGE_RULES = {
  /** A rival puck lands after this many shots you actually threaded. */
  everyThreads: 4,
  /** ...but not until you have this many pucks of your own to interfere with. */
  minShooterDiscs: 3,
} as const;

export function countDiscs(board: Board, player: Player): number {
  let n = 0;
  for (const cell of board) if (cell === player) n += 1;
  return n;
}

/** Shots still to thread before the next rival puck, or null when not yet armed. */
export function threadsUntilRival(threads: number, board: Board, shooter: Player): number | null {
  if (countDiscs(board, shooter) < RANGE_RULES.minShooterDiscs) return null;
  const into = threads % RANGE_RULES.everyThreads;
  return into === 0 ? RANGE_RULES.everyThreads : RANGE_RULES.everyThreads - into;
}

/** Is a rival puck due, having just threaded the `threads`-th shot? */
export function rivalDue(threads: number, board: Board, shooter: Player): boolean {
  if (threads <= 0 || threads % RANGE_RULES.everyThreads !== 0) return false;
  return countDiscs(board, shooter) >= RANGE_RULES.minShooterDiscs;
}

/**
 * Where the next rival puck lands: on the win you were about to make if there
 * is one, otherwise wherever an opponent would genuinely want to play.
 *
 * Whatever it picks, it is never a column that would complete four for the
 * rival. The range is somewhere to practise, not a match you can lose - so the
 * rival is allowed to build a three you have to answer, and no further.
 *
 * Returns -1 when there is nowhere legal left to put one.
 */
export function chooseRivalColumn(board: Board, shooter: Player, rival: Player): number {
  const safe = (col: number): boolean =>
    col >= 0 && !isColumnFull(board, col) && !isWinningMove(board, col, rival);

  // First choice: sit on the cell that would have won it for the player.
  for (const col of immediateWins(board, shooter)) {
    if (safe(col)) return col;
  }

  // Otherwise let the opponent's own judgement pick - it already weighs
  // threatening, blocking and not gift-wrapping a win, centre-first.
  const wanted = chooseColumn(board, rival);
  if (safe(wanted)) return wanted;

  // Its pick was the one column that would have won; take the next best legal
  // column instead, still centre-first.
  for (const col of legalColumns(board).sort((a, b) => Math.abs(3 - a) - Math.abs(3 - b))) {
    if (safe(col)) return col;
  }
  return -1;
}
