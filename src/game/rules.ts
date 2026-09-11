/**
 * Connect Four over the frozen `Board` contract.
 *
 * The board is a flat, readonly array of 42 cells indexed `row * COLS + col`
 * with **row 0 at the bottom**, so a disc that lands in a column occupies the
 * lowest empty row. Every function here is pure: boards are never mutated, a
 * new array is returned instead.
 */
import type { Board, Cell, CellRef, Player, WinLine } from './types';
import { CELL_COUNT, COLS, ROWS } from './types';

export function indexOf(col: number, row: number): number {
  return row * COLS + col;
}

export function inBounds(col: number, row: number): boolean {
  return col >= 0 && col < COLS && row >= 0 && row < ROWS;
}

export function emptyBoard(): Board {
  return new Array<Cell>(CELL_COUNT).fill(0);
}

/** `0` for empty *and* for anything off the board, so callers can probe freely. */
export function cellAt(board: Board, col: number, row: number): Cell {
  if (!inBounds(col, row)) return 0;
  return board[indexOf(col, row)] ?? 0;
}

/** Number of discs stacked in a column (0..ROWS). */
export function columnHeight(board: Board, col: number): number {
  if (col < 0 || col >= COLS) return ROWS;
  let height = 0;
  while (height < ROWS && cellAt(board, col, height) !== 0) height++;
  return height;
}

export function isColumnFull(board: Board, col: number): boolean {
  return columnHeight(board, col) >= ROWS;
}

/** Lowest empty row in a column, or -1 when the column is full or off-board. */
export function landingRow(board: Board, col: number): number {
  if (col < 0 || col >= COLS) return -1;
  const height = columnHeight(board, col);
  return height >= ROWS ? -1 : height;
}

export function legalColumns(board: Board): number[] {
  const cols: number[] = [];
  for (let col = 0; col < COLS; col++) {
    if (!isColumnFull(board, col)) cols.push(col);
  }
  return cols;
}

/** Every empty cell — each one is an aperture the ball can be threaded through. */
export function openCells(board: Board): CellRef[] {
  const out: CellRef[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (cellAt(board, col, row) === 0) out.push({ col, row });
    }
  }
  return out;
}

/**
 * Drops a disc into `col`. Returns the new board plus the cell it settled in,
 * or `null` when the column is full. A threaded shot at a high aperture still
 * falls to the bottom of the stack — `rest` is where it actually ends up.
 */
export function dropPiece(
  board: Board,
  col: number,
  player: Player,
): { board: Board; rest: CellRef } | null {
  const row = landingRow(board, col);
  if (row < 0) return null;
  const next = board.slice();
  next[indexOf(col, row)] = player;
  return { board: next, rest: { col, row } };
}

/** Places a disc directly at a cell (used by tests and board fixtures). */
export function setCell(board: Board, col: number, row: number, cell: Cell): Board {
  if (!inBounds(col, row)) return board;
  const next = board.slice();
  next[indexOf(col, row)] = cell;
  return next;
}

/**
 * Blow a disc out of the middle of a column.
 *
 * Everything stacked above it drops one slot into the gap, which is the only
 * way a disc ever moves after it has come to rest. Returns the cells that
 * shifted, so the renderer can animate the collapse instead of the board just
 * changing between frames.
 */
export function explodeDisc(
  board: Board,
  col: number,
  row: number,
): { board: Board; fell: readonly CellRef[] } | null {
  if (!inBounds(col, row) || cellAt(board, col, row) === 0) return null;

  const next = board.slice();
  const fell: CellRef[] = [];
  const top = columnHeight(board, col);

  for (let r = row; r < top - 1; r++) {
    next[indexOf(col, r)] = cellAt(board, col, r + 1);
    fell.push({ col, row: r + 1 });
  }
  next[indexOf(col, top - 1)] = 0;

  return { board: next, fell };
}

const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0], // horizontal
  [0, 1], // vertical
  [1, 1], // diagonal up-right
  [1, -1], // diagonal down-right
];

/** The first four-in-a-row found, scanning bottom-up, left-to-right. */
export function findWin(board: Board): { player: Player; line: WinLine } | null {
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const start = cellAt(board, col, row);
      if (start === 0) continue;
      for (const dir of DIRECTIONS) {
        const [dc, dr] = dir;
        const endCol = col + dc * 3;
        const endRow = row + dr * 3;
        if (!inBounds(endCol, endRow)) continue;
        if (
          cellAt(board, col + dc, row + dr) === start &&
          cellAt(board, col + dc * 2, row + dr * 2) === start &&
          cellAt(board, endCol, endRow) === start
        ) {
          return {
            player: start,
            line: [
              indexOf(col, row),
              indexOf(col + dc, row + dr),
              indexOf(col + dc * 2, row + dr * 2),
              indexOf(endCol, endRow),
            ] as WinLine,
          };
        }
      }
    }
  }
  return null;
}

/** True when the board is full and nobody has four in a row. */
export function isDraw(board: Board): boolean {
  for (let i = 0; i < CELL_COUNT; i++) {
    if ((board[i] ?? 0) === 0) return false;
  }
  return findWin(board) === null;
}

/** Would dropping in `col` win for `player` right now? */
export function isWinningMove(board: Board, col: number, player: Player): boolean {
  const dropped = dropPiece(board, col, player);
  if (!dropped) return false;
  const win = findWin(dropped.board);
  return win !== null && win.player === player;
}
