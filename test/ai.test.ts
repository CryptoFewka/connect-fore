import { describe, expect, test } from 'bun:test';
import {
  aimForColumn,
  chooseColumn,
  evaluateBoard,
  immediateWins,
  isSafeColumn,
  planShot,
  solveAim,
} from '../src/game/ai';
import { applyShot, newMatch } from '../src/game/match';
import { dropPiece, emptyBoard, landingRow, openCells, setCell } from '../src/game/rules';
import { createRng } from '../src/game/rng';
import { simulateShot } from '../src/game/shot';
import type { Board, Cell, Difficulty, MatchState, Player } from '../src/game/types';
import { COLS, ROWS } from '../src/game/types';

function build(cells: readonly (readonly [number, number, Cell])[]): Board {
  let board = emptyBoard();
  for (const [col, row, value] of cells) board = setCell(board, col, row, value);
  return board;
}

function stack(board: Board, col: number, players: readonly Player[]): Board {
  let next = board;
  for (const player of players) next = dropPiece(next, col, player)!.board;
  return next;
}

describe('column choice', () => {
  test('takes the win in front of it', () => {
    // Player one has three on the bottom row of columns 1..3.
    const board = build([
      [0, 0, 2],
      [1, 0, 1],
      [2, 0, 1],
      [3, 0, 1],
      [1, 1, 2],
      [2, 1, 2],
      [3, 1, 2],
    ]);
    expect(immediateWins(board, 1)).toEqual([4]);
    expect(chooseColumn(board, 1)).toBe(4);
  });

  test('takes a vertical win rather than anything else', () => {
    let board = emptyBoard();
    board = stack(board, 5, [1, 1, 1]);
    board = stack(board, 6, [2, 2]);
    expect(chooseColumn(board, 1)).toBe(5);
  });

  test('blocks the opponent when it cannot win itself', () => {
    let board = emptyBoard();
    board = stack(board, 2, [2]);
    board = stack(board, 3, [2]);
    board = stack(board, 4, [2]);
    board = stack(board, 0, [1]);
    board = stack(board, 6, [1]);
    // Player two threatens the bottom row at columns 1 and 5.
    expect(immediateWins(board, 2).sort()).toEqual([1, 5]);
    expect([1, 5]).toContain(chooseColumn(board, 1));
  });

  test('never plays a column that lifts the opponent into a win', () => {
    // Player two owns row 3 across columns 3..5; column 2 is two discs deep,
    // so dropping there opens the winning square at (2, 3).
    const board = build([
      [3, 3, 2],
      [4, 3, 2],
      [5, 3, 2],
      [2, 0, 1],
      [2, 1, 1],
      [3, 0, 1],
      [3, 1, 1],
      [3, 2, 1],
      [4, 0, 2],
      [4, 1, 2],
      [4, 2, 1],
      [5, 0, 2],
      [5, 1, 1],
      [5, 2, 2],
    ]);
    expect(immediateWins(board, 1)).toEqual([]);
    expect(immediateWins(board, 2)).toEqual([]);
    expect(isSafeColumn(board, 2, 1)).toBe(false);
    expect(chooseColumn(board, 1)).not.toBe(2);

    const rng = createRng(11);
    for (let i = 0; i < 8; i++) {
      const params = planShot(board, 1, 'hard', rng);
      const result = simulateShot(board, params);
      if (result.outcome === 'thread') expect(result.entry?.col).not.toBe(2);
    }
  });

  test('opens in the centre', () => {
    expect(chooseColumn(emptyBoard(), 1)).toBe(3);
  });

  test('the heuristic likes the centre and dislikes enemy threats', () => {
    const centre = build([[3, 0, 1]]);
    const edge = build([[0, 0, 1]]);
    expect(evaluateBoard(centre, 1)).toBeGreaterThan(evaluateBoard(edge, 1));
    const threat = build([[1, 0, 2], [2, 0, 2], [3, 0, 2]]);
    expect(evaluateBoard(threat, 1)).toBeLessThan(0);
    expect(evaluateBoard(threat, 2)).toBeGreaterThan(0);
  });

  test('a full board has no move', () => {
    const full: Board = new Array<Cell>(COLS * ROWS).fill(1);
    expect(chooseColumn(full, 1)).toBe(-1);
  });
});

describe('the aim solver', () => {
  test('finds a swing for every aperture on an empty board', () => {
    const board = emptyBoard();
    for (const cell of openCells(board)) {
      const solution = solveAim(board, cell);
      expect(solution).not.toBeNull();
      expect(`${cell.col},${cell.row}: ${solution!.result.outcome}`).toBe(
        `${cell.col},${cell.row}: thread`,
      );
      expect(solution!.result.entry).toEqual(cell);
      expect(solution!.error).toBeLessThan(0.05);
    }
  });

  test('re-solves around discs that are already on the board', () => {
    let state: MatchState = newMatch();
    for (const col of [3, 3, 3, 2, 4, 4]) {
      const params = aimForColumn(state.board, col);
      expect(params).not.toBeNull();
      const { state: next, record } = applyShot(state, params!);
      expect(record.outcome).toBe('thread');
      expect(record.rest?.col).toBe(col);
      state = next;
    }
  });

  test('a full column has nothing to aim at', () => {
    let board = emptyBoard();
    board = stack(board, 0, [1, 2, 1, 2, 1, 2]);
    expect(landingRow(board, 0)).toBe(-1);
    expect(aimForColumn(board, 0)).toBeNull();
  });

  test('a solve costs a few hundred physics calls at most', () => {
    const board = emptyBoard();
    for (const cell of [{ col: 0, row: 5 }, { col: 3, row: 0 }, { col: 6, row: 3 }]) {
      const solution = solveAim(board, cell);
      expect(solution!.sims).toBeLessThan(400);
    }
  });

  test('planning a shot stays in the low milliseconds', () => {
    const rng = createRng(4242);
    let board = emptyBoard();
    const samples = 40;
    const start = Bun.nanoseconds();
    for (let i = 0; i < samples; i++) {
      planShot(board, ((i % 2) + 1) as Player, 'hard', rng);
      if (i % 3 === 0) board = dropPiece(board, i % COLS, ((i % 2) + 1) as Player)?.board ?? board;
    }
    const ms = (Bun.nanoseconds() - start) / 1e6 / samples;
    console.warn(`  planShot: ${ms.toFixed(2)} ms/shot`);
    expect(ms).toBeLessThan(25);
  });
});

describe('difficulty', () => {
  /** Plays whole AI-vs-AI matches and counts the swings that miss. */
  function missRate(difficulty: Difficulty, games: number, seed: number): number {
    const rng = createRng(seed);
    let shots = 0;
    let misses = 0;
    for (let game = 0; game < games; game++) {
      let state: MatchState = newMatch();
      let guard = 0;
      while (state.status === 'playing' && guard++ < 120) {
        const params = planShot(state.board, state.current, difficulty, rng);
        const { state: next, record } = applyShot(state, params);
        shots++;
        if (record.outcome !== 'thread') misses++;
        state = next;
      }
    }
    expect(shots).toBeGreaterThan(300);
    return misses / shots;
  }

  test(
    'miss rates land near 40 / 20 / 8 per cent',
    () => {
      const easy = missRate('easy', 16, 0x1111);
      const normal = missRate('normal', 16, 0x2222);
      const hard = missRate('hard', 16, 0x3333);
      console.warn(
        `  miss rates — easy ${(easy * 100).toFixed(1)}%, ` +
          `normal ${(normal * 100).toFixed(1)}%, hard ${(hard * 100).toFixed(1)}%`,
      );
      expect(easy).toBeGreaterThan(0.3);
      expect(easy).toBeLessThan(0.52);
      expect(normal).toBeGreaterThan(0.12);
      expect(normal).toBeLessThan(0.29);
      expect(hard).toBeGreaterThan(0.02);
      expect(hard).toBeLessThan(0.15);
      expect(easy).toBeGreaterThan(normal);
      expect(normal).toBeGreaterThan(hard);
    },
    120_000,
  );

  test('the same seed plans the same swings', () => {
    const board = emptyBoard();
    const a = createRng(99);
    const b = createRng(99);
    for (let i = 0; i < 5; i++) {
      expect(planShot(board, 1, 'normal', a)).toEqual(planShot(board, 1, 'normal', b));
    }
  });

  test('a clean plan is inside the course limits', () => {
    const rng = createRng(5);
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      const params = planShot(emptyBoard(), 1, difficulty, rng);
      expect(params.yaw).toBeGreaterThanOrEqual(-0.55);
      expect(params.yaw).toBeLessThanOrEqual(0.55);
      expect(params.loft).toBeGreaterThanOrEqual(0.02);
      expect(params.loft).toBeLessThanOrEqual(0.95);
      expect(params.power).toBeGreaterThan(0);
      expect(params.power).toBeLessThanOrEqual(1);
      expect(Math.abs(params.accuracy)).toBeLessThanOrEqual(1);
    }
  });
});
