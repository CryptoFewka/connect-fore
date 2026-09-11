import { describe, expect, test } from 'bun:test';
import { applyShot, newMatch, otherPlayer, rematchMatch } from '../src/game/match';
import { aimForColumn, solveAim } from '../src/game/ai';
import { cellAt, setCell } from '../src/game/rules';
import type { Board, Cell, MatchState, ShotParams } from '../src/game/types';
import { CELL_COUNT, COLS, ROWS } from '../src/game/types';

/** A swing that threads `col`, solved against the live board. */
function shotAt(board: Board, col: number): ShotParams {
  const params = aimForColumn(board, col);
  expect(params).not.toBeNull();
  return params!;
}

/**
 * A swing that arrives at a specific cell, filled or not. `aimForColumn` only
 * solves for open apertures, so the aim is solved against a board where the
 * target cell is empty and then fired at the real one.
 */
function shotAtCell(board: Board, col: number, row: number): ShotParams {
  const cleared = setCell(board, col, row, 0);
  const solution = solveAim(cleared, { col, row });
  expect(solution).not.toBeNull();
  return solution!.params;
}

/** Plays a clean threading shot into `col`. */
function threadInto(state: MatchState, col: number): { state: MatchState; record: ReturnType<typeof applyShot>['record'] } {
  const result = applyShot(state, shotAt(state.board, col));
  expect(result.record.outcome).toBe('thread');
  return result;
}

describe('a new match', () => {
  test('starts empty with player one to play', () => {
    const state = newMatch();
    expect(state.board.length).toBe(CELL_COUNT);
    expect(state.board.every((cell) => cell === 0)).toBe(true);
    expect(state.turn).toBe(0);
    expect(state.current).toBe(1);
    expect(state.status).toBe('playing');
    expect(state.winner).toBeNull();
    expect(state.winLine).toBeNull();
    expect(state.lastShot).toBeNull();
  });

  test('the second player can be given the honour', () => {
    expect(newMatch(2).current).toBe(2);
    expect(otherPlayer(1)).toBe(2);
    expect(otherPlayer(2)).toBe(1);
  });
});

describe('applying a shot', () => {
  test('a threaded aperture places a disc and passes the turn', () => {
    const start = newMatch();
    const { state, record } = threadInto(start, 4);
    expect(record.player).toBe(1);
    expect(record.turn).toBe(0);
    expect(record.entry).toEqual({ col: 4, row: 0 });
    expect(record.rest).toEqual({ col: 4, row: 0 });
    expect(cellAt(state.board, 4, 0)).toBe(1);
    expect(state.turn).toBe(1);
    expect(state.current).toBe(2);
    expect(state.status).toBe('playing');
    expect(state.lastShot).toEqual(record);
  });

  test('the previous state is left untouched', () => {
    const start = newMatch();
    const before = start.board;
    threadInto(start, 4);
    expect(start.board).toBe(before);
    expect(start.board.every((cell) => cell === 0)).toBe(true);
    expect(start.turn).toBe(0);
    expect(start.current).toBe(1);
  });

  test('a disc threaded high still falls to the bottom of the stack', () => {
    let state = newMatch();
    state = threadInto(state, 2).state; // player 1 at row 0
    const params = shotAt(state.board, 2); // aims at row 1, the new aperture
    const { state: next, record } = applyShot(state, params);
    expect(record.entry).toEqual({ col: 2, row: 1 });
    expect(record.rest).toEqual({ col: 2, row: 1 });
    expect(cellAt(next.board, 2, 1)).toBe(2);
  });

  test('bouncing off your own disc forfeits the turn — no second swing', () => {
    const opened = threadInto(newMatch(), 3).state; // player one plugs (3,0)
    // ...and then player one is somehow up again, shooting at their own disc.
    const state: MatchState = { ...opened, current: 1 };
    const blocked = shotAtCell(state.board, 3, 0);
    const { state: next, record } = applyShot(state, blocked);
    expect(record.outcome).toBe('bounce');
    expect(record.player).toBe(1);
    expect(record.entry).toBeNull();
    expect(record.rest).toBeNull();
    expect(record.destroyed).toBeNull();
    expect(next.board).toEqual(state.board);
    expect(next.turn).toBe(state.turn + 1);
    expect(next.current).toBe(2);
  });

  test('striking an opponent disc explodes it, and still costs the turn', () => {
    const state = threadInto(newMatch(), 3).state; // player one at (3,0), player two to play
    expect(cellAt(state.board, 3, 0)).toBe(1);

    const { state: next, record } = applyShot(state, shotAtCell(state.board, 3, 0));
    expect(record.outcome).toBe('explode');
    expect(record.player).toBe(2);
    expect(record.destroyed).toEqual({ col: 3, row: 0 });
    expect(record.rest).toBeNull();
    // The disc is gone and the shooter placed nothing of their own.
    expect(cellAt(next.board, 3, 0)).toBe(0);
    expect(next.board.every((cell) => cell === 0)).toBe(true);
    // Demolition is not a free swing.
    expect(next.turn).toBe(state.turn + 1);
    expect(next.current).toBe(1);
  });

  test('the stack above an exploded disc drops one slot', () => {
    // Column 3 from the bottom: P1, P2, P1. Player two blasts the bottom one.
    let board = setCell(newMatch().board, 3, 0, 1);
    board = setCell(board, 3, 1, 2);
    board = setCell(board, 3, 2, 1);
    const state: MatchState = { ...newMatch(), board, current: 2 };

    const { state: next, record } = applyShot(state, shotAtCell(board, 3, 0));
    expect(record.outcome).toBe('explode');
    expect(cellAt(next.board, 3, 0)).toBe(2);
    expect(cellAt(next.board, 3, 1)).toBe(1);
    expect(cellAt(next.board, 3, 2)).toBe(0);
  });

  test('a short shot also forfeits the turn', () => {
    const start = newMatch();
    const { state, record } = applyShot(start, { yaw: 0, loft: 0.3, power: 0.15, accuracy: 0 });
    expect(record.outcome).toBe('short');
    expect(state.current).toBe(2);
    expect(state.turn).toBe(1);
    expect(state.board.every((cell) => cell === 0)).toBe(true);
  });

  test('shot parameters are recorded clamped, exactly as simulated', () => {
    const { record } = applyShot(newMatch(), { yaw: 99, loft: -5, power: 7, accuracy: -9 });
    expect(record.params).toEqual({ yaw: 0.55, loft: 0.02, power: 1, accuracy: -1 });
  });
});

describe('ending a match', () => {
  test('four in a column wins, and the match then ignores further shots', () => {
    let state = newMatch();
    for (const col of [0, 6, 0, 6, 0, 6, 0]) {
      state = threadInto(state, col).state;
    }
    expect(state.status).toBe('won');
    expect(state.winner).toBe(1);
    expect(state.winLine).toEqual([0, 7, 14, 21]);
    expect(state.current).toBe(2);

    const after = applyShot(state, shotAt(state.board, 3));
    expect(after.state).toBe(state);
    expect(after.state.turn).toBe(state.turn);
  });

  test('filling the last aperture with no line is a draw', () => {
    // The standard no-four filling pattern, one disc short of complete.
    const cells: Cell[] = [];
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        cells[row * COLS + col] = (((Math.floor(row / 2) + col) % 2) + 1) as Cell;
      }
    }
    const last = { col: 0, row: ROWS - 1 };
    const player = cells[last.row * COLS + last.col];
    const board: Board = setCell(cells, last.col, last.row, 0);
    const state: MatchState = {
      board,
      turn: CELL_COUNT - 1,
      current: player === 1 ? 1 : 2,
      status: 'playing',
      winner: null,
      winLine: null,
      lastShot: null,
    };
    const { state: next, record } = applyShot(state, shotAt(board, last.col));
    expect(record.rest).toEqual(last);
    expect(next.status).toBe('draw');
    expect(next.winner).toBeNull();
    expect(next.winLine).toBeNull();
  });

  test('the rematch hands the honour to the other side', () => {
    const state: MatchState = { ...newMatch(), status: 'won', winner: 1 };
    const next = rematchMatch(state);
    expect(next.current).toBe(2);
    expect(next.status).toBe('playing');
    expect(next.board.every((cell) => cell === 0)).toBe(true);
  });
});
