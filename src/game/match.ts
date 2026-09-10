/**
 * Turn state machine, shared by hot-seat, the AI and online play.
 *
 * Everything is immutable: `applyShot` returns a brand new `MatchState`, which
 * is what the Durable Object stores and broadcasts. A shot that does not thread
 * an aperture forfeits the turn — the same player does *not* get another swing.
 */
import type { CellRef, MatchState, Player, ShotParams, ShotRecord } from './types';
import { emptyBoard, dropPiece, findWin, isDraw } from './rules';
import { clampShotParams, simulateShot } from './shot';

export function otherPlayer(player: Player): Player {
  return player === 1 ? 2 : 1;
}

export function newMatch(first: Player = 1): MatchState {
  return {
    board: emptyBoard(),
    turn: 0,
    current: first,
    status: 'playing',
    winner: null,
    winLine: null,
    lastShot: null,
  };
}

/** Fresh board, loser (or the other side) tees off first. */
export function rematchMatch(previous: MatchState): MatchState {
  const first = previous.winner ? otherPlayer(previous.winner) : otherPlayer(previous.current);
  return newMatch(first);
}

export function isPlayable(state: MatchState): boolean {
  return state.status === 'playing';
}

/**
 * Simulates a swing and folds the result into the match.
 *
 * On `thread` the disc is placed in the threaded aperture's column and falls to
 * the lowest empty row; win and draw are then checked. Every outcome — thread or
 * not — advances `turn` and passes the honour to the other player.
 *
 * Shooting at a finished match is a no-op: the record describes the simulated
 * flight, but the returned state is the one that was passed in.
 */
export function applyShot(
  state: MatchState,
  params: ShotParams,
): { state: MatchState; record: ShotRecord } {
  const shot = clampShotParams(params);
  const result = simulateShot(state.board, shot);
  const player = state.current;

  if (state.status !== 'playing') {
    return {
      state,
      record: {
        turn: state.turn,
        player,
        params: shot,
        outcome: result.outcome,
        entry: result.entry,
        rest: null,
      },
    };
  }

  let board = state.board;
  let rest: CellRef | null = null;

  if (result.outcome === 'thread' && result.entry) {
    const dropped = dropPiece(board, result.entry.col, player);
    if (dropped) {
      board = dropped.board;
      rest = dropped.rest;
    }
  }

  const win = rest ? findWin(board) : null;
  const drawn = !win && rest ? isDraw(board) : false;

  const record: ShotRecord = {
    turn: state.turn,
    player,
    params: shot,
    outcome: result.outcome,
    entry: result.entry,
    rest,
  };

  return {
    state: {
      board,
      turn: state.turn + 1,
      current: otherPlayer(player),
      status: win ? 'won' : drawn ? 'draw' : 'playing',
      winner: win ? win.player : null,
      winLine: win ? win.line : null,
      lastShot: record,
    },
    record,
  };
}
