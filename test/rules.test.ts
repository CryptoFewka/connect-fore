import { describe, expect, test } from 'bun:test';
import {
  cellAt,
  columnHeight,
  dropPiece,
  emptyBoard,
  findWin,
  indexOf,
  isColumnFull,
  isDraw,
  isWinningMove,
  landingRow,
  legalColumns,
  openCells,
  setCell,
} from '../src/game/rules';
import type { Board, Cell, Player } from '../src/game/types';
import { CELL_COUNT, COLS, ROWS } from '../src/game/types';

/** Drops a sequence of columns, alternating players unless one is given. */
function play(cols: readonly number[], first: Player = 1): Board {
  let board = emptyBoard();
  let player: Player = first;
  for (const col of cols) {
    const dropped = dropPiece(board, col, player);
    expect(dropped).not.toBeNull();
    board = dropped!.board;
    player = player === 1 ? 2 : 1;
  }
  return board;
}

function place(pairs: readonly [number, number, Cell][]): Board {
  let board = emptyBoard();
  for (const [col, row, cell] of pairs) board = setCell(board, col, row, cell);
  return board;
}

describe('board basics', () => {
  test('an empty board is 42 empty cells', () => {
    const board = emptyBoard();
    expect(board.length).toBe(CELL_COUNT);
    expect(board.every((cell) => cell === 0)).toBe(true);
    expect(openCells(board).length).toBe(CELL_COUNT);
  });

  test('index maths puts row 0 at the bottom', () => {
    expect(indexOf(0, 0)).toBe(0);
    expect(indexOf(6, 0)).toBe(6);
    expect(indexOf(0, 1)).toBe(COLS);
    expect(indexOf(6, 5)).toBe(CELL_COUNT - 1);
  });

  test('cellAt is safe off the board', () => {
    const board = emptyBoard();
    expect(cellAt(board, -1, 0)).toBe(0);
    expect(cellAt(board, COLS, 0)).toBe(0);
    expect(cellAt(board, 0, ROWS)).toBe(0);
  });
});

describe('drops', () => {
  test('discs stack from the bottom up', () => {
    const board = play([3, 3, 3]);
    expect(cellAt(board, 3, 0)).toBe(1);
    expect(cellAt(board, 3, 1)).toBe(2);
    expect(cellAt(board, 3, 2)).toBe(1);
    expect(cellAt(board, 3, 3)).toBe(0);
    expect(columnHeight(board, 3)).toBe(3);
    expect(landingRow(board, 3)).toBe(3);
  });

  test('dropPiece reports where the disc came to rest', () => {
    const dropped = dropPiece(play([2, 2]), 2, 1);
    expect(dropped?.rest).toEqual({ col: 2, row: 2 });
  });

  test('dropPiece never mutates the board it was given', () => {
    const before = emptyBoard();
    dropPiece(before, 0, 1);
    expect(before.every((cell) => cell === 0)).toBe(true);
  });

  test('a full column refuses more discs', () => {
    const board = play([1, 1, 1, 1, 1, 1]);
    expect(columnHeight(board, 1)).toBe(ROWS);
    expect(isColumnFull(board, 1)).toBe(true);
    expect(landingRow(board, 1)).toBe(-1);
    expect(dropPiece(board, 1, 1)).toBeNull();
    expect(legalColumns(board)).toEqual([0, 2, 3, 4, 5, 6]);
  });

  test('openCells shrinks as apertures are plugged', () => {
    const board = play([0, 0, 0, 6]);
    const open = openCells(board);
    expect(open.length).toBe(CELL_COUNT - 4);
    expect(open).not.toContainEqual({ col: 0, row: 0 });
    expect(open).toContainEqual({ col: 0, row: 3 });
    expect(open).toContainEqual({ col: 6, row: 1 });
  });
});

describe('finding four in a row', () => {
  test('horizontal', () => {
    const board = place([
      [1, 0, 1],
      [2, 0, 1],
      [3, 0, 1],
      [4, 0, 1],
    ]);
    const win = findWin(board);
    expect(win?.player).toBe(1);
    expect(win?.line).toEqual([1, 2, 3, 4]);
  });

  test('vertical', () => {
    const board = place([
      [5, 0, 2],
      [5, 1, 2],
      [5, 2, 2],
      [5, 3, 2],
    ]);
    const win = findWin(board);
    expect(win?.player).toBe(2);
    expect(win?.line).toEqual([5, 12, 19, 26]);
  });

  test('diagonal up-right', () => {
    const board = place([
      [0, 0, 1],
      [1, 1, 1],
      [2, 2, 1],
      [3, 3, 1],
    ]);
    expect(findWin(board)?.player).toBe(1);
    expect(findWin(board)?.line).toEqual([0, 8, 16, 24]);
  });

  test('diagonal down-right', () => {
    const board = place([
      [0, 3, 2],
      [1, 2, 2],
      [2, 1, 2],
      [3, 0, 2],
    ]);
    expect(findWin(board)?.player).toBe(2);
    expect(findWin(board)?.line).toEqual([21, 15, 9, 3]);
  });

  test('three in a row is not a win, and mixed lines are not either', () => {
    expect(findWin(place([[1, 0, 1], [2, 0, 1], [3, 0, 1]]))).toBeNull();
    expect(
      findWin(place([[1, 0, 1], [2, 0, 1], [3, 0, 1], [4, 0, 2]])),
    ).toBeNull();
  });

  test('a real game ending in a vertical win', () => {
    const board = play([3, 4, 3, 4, 3, 4, 3]);
    const win = findWin(board);
    expect(win?.player).toBe(1);
    expect(win?.line).toEqual([3, 10, 17, 24]);
  });

  test('isWinningMove sees the win before it is played', () => {
    const board = play([3, 4, 3, 4, 3, 4]);
    expect(isWinningMove(board, 3, 1)).toBe(true);
    expect(isWinningMove(board, 5, 1)).toBe(false);
    expect(isWinningMove(board, 4, 2)).toBe(true);
  });
});

describe('draws', () => {
  test('a full board with no line is a draw', () => {
    const cells: Cell[] = [];
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        // Two-row bands, offset per column: no four ever line up.
        cells[row * COLS + col] = (((Math.floor(row / 2) + col) % 2) + 1) as Cell;
      }
    }
    const board: Board = cells;
    expect(findWin(board)).toBeNull();
    expect(isDraw(board)).toBe(true);
    expect(openCells(board).length).toBe(0);
    expect(legalColumns(board).length).toBe(0);
  });

  test('a partly filled board is not a draw', () => {
    expect(isDraw(emptyBoard())).toBe(false);
    expect(isDraw(play([0, 1, 2, 3]))).toBe(false);
  });

  test('a full board with a line is a win, not a draw', () => {
    const cells: Cell[] = new Array<Cell>(CELL_COUNT).fill(1);
    expect(isDraw(cells)).toBe(false);
  });
});
