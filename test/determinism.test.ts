import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashTrajectory, simulateShot } from '../src/game/shot';
import { emptyBoard, dropPiece } from '../src/game/rules';
import { createRng, hashSeed, mixSeeds } from '../src/game/rng';
import type { Board, ShotParams } from '../src/game/types';

const SHOT: ShotParams = { yaw: 0.08, loft: 0.31, power: 0.74, accuracy: -0.22 };

describe('the simulation is reproducible', () => {
  test('100 runs of the same shot produce an identical trajectory', () => {
    const board = emptyBoard();
    const first = simulateShot(board, SHOT);
    const expected = hashTrajectory(first);
    for (let i = 0; i < 100; i++) {
      const again = simulateShot(board, SHOT);
      expect(hashTrajectory(again)).toBe(expected);
      expect(again.steps).toBe(first.steps);
      expect(again.outcome).toBe(first.outcome);
      expect(again.points.length).toBe(first.points.length);
    }
  });

  test('points are one xyz triple per step, starting at the tee', () => {
    const result = simulateShot(emptyBoard(), SHOT);
    expect(result.points.length).toBe((result.steps + 1) * 3);
    expect(result.points[0]).toBe(0);
    expect(result.points[1]).toBeCloseTo(0.16, 12);
    expect(result.points[2]).toBe(14);
  });

  test('the board state is part of the trajectory', () => {
    const empty = emptyBoard();
    const blocked: Board = dropPiece(empty, 3, 1)!.board;
    const a = simulateShot(empty, { yaw: 0, loft: 0.2908, power: 0.7, accuracy: 0 });
    const b = simulateShot(blocked, { yaw: 0, loft: 0.2908, power: 0.7, accuracy: 0 });
    expect(a.outcome).toBe('thread');
    expect(b.outcome).toBe('bounce');
    expect(hashTrajectory(a)).not.toBe(hashTrajectory(b));
  });

  test('a nudge to any parameter changes the flight', () => {
    const board = emptyBoard();
    const base = hashTrajectory(simulateShot(board, SHOT));
    for (const tweak of [
      { yaw: SHOT.yaw + 0.01 },
      { loft: SHOT.loft + 0.01 },
      { power: SHOT.power + 0.01 },
      { accuracy: SHOT.accuracy + 0.01 },
    ]) {
      expect(hashTrajectory(simulateShot(board, { ...SHOT, ...tweak }))).not.toBe(base);
    }
  });
});

describe('the seeded rng is reproducible', () => {
  test('the same seed replays the same stream', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    for (let i = 0; i < 500; i++) expect(a.next()).toBe(b.next());
  });

  test('different seeds diverge, and every draw is in [0, 1)', () => {
    const a = createRng(1);
    const b = createRng(2);
    let same = 0;
    for (let i = 0; i < 500; i++) {
      const x = a.next();
      const y = b.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      if (x === y) same++;
    }
    expect(same).toBe(0);
  });

  test('gaussians land where gaussians should', () => {
    const rng = createRng(0xbeef);
    const n = 20000;
    let sum = 0;
    let sumSq = 0;
    let outside3 = 0;
    for (let i = 0; i < n; i++) {
      const value = rng.nextGaussian();
      sum += value;
      sumSq += value * value;
      if (Math.abs(value) > 3) outside3++;
    }
    const mean = sum / n;
    const sigma = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(sigma).toBeGreaterThan(0.95);
    expect(sigma).toBeLessThan(1.05);
    expect(outside3 / n).toBeLessThan(0.01);
  });

  test('helpers stay inside their ranges', () => {
    const rng = createRng(7);
    for (let i = 0; i < 200; i++) {
      const r = rng.nextRange(-2, 5);
      expect(r).toBeGreaterThanOrEqual(-2);
      expect(r).toBeLessThan(5);
      const n = rng.nextInt(7);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(7);
    }
    expect(hashSeed('room-Q4X7')).toBe(hashSeed('room-Q4X7'));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
    expect(mixSeeds(1, 2)).toBe(mixSeeds(1, 2));
    expect(mixSeeds(1, 2)).not.toBe(mixSeeds(2, 1));
    expect(createRng(9).fork(3).next()).toBe(createRng(9).fork(3).next());
  });
});

describe('src/game stays pure', () => {
  const banned: readonly (readonly [RegExp, string])[] = [
    [/\bMath\s*\.\s*random\b/, 'Math.random'],
    [/\bDate\s*\.\s*now\b/, 'Date.now'],
    [/\bnew\s+Date\b/, 'new Date'],
    [/\bperformance\s*\.\s*now\b/, 'performance.now'],
    [/\bfrom\s*['"]three['"]/, "import from 'three'"],
    [/\bfrom\s*['"]three\//, "import from 'three/...'"],
    [/\bwindow\s*\./, 'window.'],
    [/\bdocument\s*\./, 'document.'],
    [/\brequestAnimationFrame\b/, 'requestAnimationFrame'],
    [/\bcrypto\s*\./, 'crypto.'],
  ];

  /** Comments legitimately name these things; only real code counts. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  const dir = join(import.meta.dir, '..', 'src', 'game');
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));

  test('there is something to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  for (const name of files) {
    test(`${name} has no platform or clock dependencies`, () => {
      const code = stripComments(readFileSync(join(dir, name), 'utf8'));
      for (const [pattern, label] of banned) {
        expect(`${name}: ${pattern.test(code) ? `uses ${label}` : 'clean'}`).toBe(
          `${name}: clean`,
        );
      }
    });
  }
});
