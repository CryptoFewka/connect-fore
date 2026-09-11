import { describe, expect, test } from 'bun:test';
import {
  chooseRivalColumn,
  countDiscs,
  RANGE_RULES,
  rivalDue,
  threadsUntilRival,
} from '../src/game/practice';
import { cellAt, dropPiece, emptyBoard, findWin, isWinningMove, setCell } from '../src/game/rules';
import { ALL_COACHING, MAX_HINT } from '../src/ui/tutorial';
import type { Board } from '../src/game/types';
import { COLS, ROWS } from '../src/game/types';

/** Stacks discs into columns, bottom-up, from a compact description. */
function build(spec: readonly (readonly [number, 1 | 2])[]): Board {
  let board = emptyBoard();
  for (const [col, player] of spec) {
    const dropped = dropPiece(board, col, player);
    expect(dropped).not.toBeNull();
    board = dropped!.board;
  }
  return board;
}

describe('counting what is on the board', () => {
  test('counts each side separately', () => {
    const board = build([
      [0, 1],
      [0, 2],
      [1, 1],
    ]);
    expect(countDiscs(board, 1)).toBe(2);
    expect(countDiscs(board, 2)).toBe(1);
    expect(countDiscs(emptyBoard(), 1)).toBe(0);
  });
});

describe('when a rival puck is due', () => {
  const threeDown = build([
    [0, 1],
    [1, 1],
    [2, 1],
  ]);

  test('not until the player has pucks worth interfering with', () => {
    const twoDown = build([
      [0, 1],
      [1, 1],
    ]);
    expect(countDiscs(twoDown, 1)).toBeLessThan(RANGE_RULES.minShooterDiscs);
    expect(rivalDue(4, twoDown, 1)).toBe(false);
    expect(threadsUntilRival(4, twoDown, 1)).toBeNull();
  });

  test('every fourth threaded shot once it is armed', () => {
    expect(rivalDue(1, threeDown, 1)).toBe(false);
    expect(rivalDue(2, threeDown, 1)).toBe(false);
    expect(rivalDue(3, threeDown, 1)).toBe(false);
    expect(rivalDue(4, threeDown, 1)).toBe(true);
    expect(rivalDue(8, threeDown, 1)).toBe(true);
    expect(rivalDue(9, threeDown, 1)).toBe(false);
  });

  test('never on the zeroth shot', () => {
    expect(rivalDue(0, threeDown, 1)).toBe(false);
  });

  test('counts down to the next one', () => {
    expect(threadsUntilRival(0, threeDown, 1)).toBe(4);
    expect(threadsUntilRival(1, threeDown, 1)).toBe(3);
    expect(threadsUntilRival(3, threeDown, 1)).toBe(1);
    expect(threadsUntilRival(4, threeDown, 1)).toBe(4);
  });
});

describe('where the rival puck lands', () => {
  test('on the win the player was one shot away from making', () => {
    // Player one holds the bottom of columns 0, 1 and 2 — column 3 finishes it.
    const board = build([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
    expect(isWinningMove(board, 3, 1)).toBe(true);
    expect(chooseRivalColumn(board, 1, 2)).toBe(3);
  });

  test('and blocks the low end of the row just as happily', () => {
    // Player one holds columns 2, 3 and 4; either 1 or 5 completes it.
    const board = build([
      [2, 1],
      [3, 1],
      [4, 1],
    ]);
    const col = chooseRivalColumn(board, 1, 2);
    expect([1, 5]).toContain(col);
  });

  test('never gives itself four in a row', () => {
    // Rival holds the bottom of 0, 1 and 2, so column 3 would win for it.
    let board = build([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    // Give the player enough pucks that the range would be arming a rival.
    board = setCell(board, 5, 0, 1);
    board = setCell(board, 6, 0, 1);
    board = setCell(board, 5, 1, 1);
    expect(isWinningMove(board, 3, 2)).toBe(true);

    const col = chooseRivalColumn(board, 1, 2);
    expect(col).not.toBe(3);
    expect(col).toBeGreaterThanOrEqual(0);
    const after = dropPiece(board, col, 2);
    expect(after).not.toBeNull();
    expect(findWin(after!.board)).toBeNull();
  });

  test('holds off entirely when every column would win it the game', () => {
    // Contrived: the only legal column is the rival's winning one.
    let board = emptyBoard();
    for (let col = 0; col < COLS; col += 1) {
      if (col === 3) continue;
      for (let row = 0; row < ROWS; row += 1) {
        board = setCell(board, col, row, row % 2 === 0 ? 1 : 2);
      }
    }
    // Column 3 alone is open; stack it so the rival's next disc makes four.
    board = setCell(board, 3, 0, 2);
    board = setCell(board, 3, 1, 2);
    board = setCell(board, 3, 2, 2);
    expect(isWinningMove(board, 3, 2)).toBe(true);
    expect(chooseRivalColumn(board, 1, 2)).toBe(-1);
  });

  test('returns nothing when the board is full', () => {
    let board = emptyBoard();
    for (let col = 0; col < COLS; col += 1) {
      for (let row = 0; row < ROWS; row += 1) {
        board = setCell(board, col, row, ((col + row) % 2 === 0 ? 1 : 2) as 1 | 2);
      }
    }
    expect(chooseRivalColumn(board, 1, 2)).toBe(-1);
  });

  test('always picks a legal, non-full column', () => {
    const board = build([
      [3, 1],
      [3, 2],
      [2, 1],
      [4, 2],
      [2, 1],
    ]);
    const col = chooseRivalColumn(board, 1, 2);
    expect(col).toBeGreaterThanOrEqual(0);
    expect(col).toBeLessThan(COLS);
    expect(cellAt(board, col, ROWS - 1)).toBe(0);
  });
});

describe('tutorial copy', () => {
  test('every hint fits the screen instead of clipping silently', () => {
    for (const { hint, message } of ALL_COACHING) {
      expect(hint.length).toBeLessThanOrEqual(MAX_HINT);
      // The message banner is centred and clips the same way.
      expect(message.length).toBeLessThanOrEqual(38);
    }
  });

  test('uses only characters the bitmap font has', () => {
    const renderable = /^[A-Z0-9 .,!?:;'"\-+=_/\\]*$/;
    for (const { hint, message } of ALL_COACHING) {
      expect(hint).toMatch(renderable);
      expect(message).toMatch(renderable);
    }
  });
});
