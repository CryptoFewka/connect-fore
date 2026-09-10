import { describe, expect, test } from 'bun:test';
import { simulateShot } from '../src/game/shot';
import { emptyBoard, dropPiece, setCell } from '../src/game/rules';
import {
  APERTURE_TOLERANCE,
  BOARD_MAX_Y,
  CONTACT_Z,
  cellForPoint,
  clampShotParams,
  GROUND_Y,
  launchVelocity,
  onPanel,
  planeCrossing,
  probeCrossing,
} from '../src/game/physics';
import type { Board, ShotParams } from '../src/game/types';
import { cellCenter, COURSE } from '../src/game/types';

/** Solved offline against this course; see the report for the solver. */
const AT_C3_R0: ShotParams = { yaw: 0, loft: 0.29080979347229, power: 0.7, accuracy: 0 };
const AT_C0_R0: ShotParams = { yaw: -0.20948776063205446, loft: 0.29476130485534674, power: 0.7, accuracy: 0 };
const AT_C6_R2: ShotParams = { yaw: 0.20949191553012225, loft: 0.44131726264953614, power: 0.7, accuracy: 0 };
const AT_C2_R4: ShotParams = { yaw: -0.07020101107295434, loft: 0.5850611019134522, power: 0.7, accuracy: 0 };

function minZ(points: readonly number[]): number {
  let lowest = Infinity;
  for (let i = 2; i < points.length; i += 3) lowest = Math.min(lowest, points[i] ?? Infinity);
  return lowest;
}

function pointAtStep(points: readonly number[], step: number): { x: number; y: number; z: number } {
  return { x: points[step * 3] ?? 0, y: points[step * 3 + 1] ?? 0, z: points[step * 3 + 2] ?? 0 };
}

describe('threading an aperture', () => {
  test('a straight shot at the middle of the bottom row goes through', () => {
    const result = simulateShot(emptyBoard(), AT_C3_R0);
    expect(result.outcome).toBe('thread');
    expect(result.entry).toEqual({ col: 3, row: 0 });
    expect(result.impactStep).toBeGreaterThan(0);
    const impact = pointAtStep(result.points, result.impactStep);
    const centre = cellCenter(3, 0);
    expect(Math.abs(impact.x - centre.x)).toBeLessThan(APERTURE_TOLERANCE);
  });

  test('corners and upper rows are reachable too', () => {
    for (const [params, col, row] of [
      [AT_C0_R0, 0, 0],
      [AT_C6_R2, 6, 2],
      [AT_C2_R4, 2, 4],
    ] as const) {
      const result = simulateShot(emptyBoard(), params);
      expect(result.outcome).toBe('thread');
      expect(result.entry).toEqual({ col, row });
    }
  });

  test('the ball keeps flying behind the board so the camera can follow', () => {
    const result = simulateShot(emptyBoard(), AT_C3_R0);
    expect(result.steps).toBeGreaterThan(result.impactStep + 10);
    const last = pointAtStep(result.points, result.steps);
    expect(last.z).toBeLessThan(COURSE.boardZ);
  });
});

describe('bouncing off the board', () => {
  test('the same shot at a plugged aperture is rejected', () => {
    const blocked: Board = dropPiece(emptyBoard(), 3, 2)!.board;
    const result = simulateShot(blocked, AT_C3_R0);
    expect(result.outcome).toBe('bounce');
    expect(result.entry).toBeNull();
    expect(result.impactStep).toBeGreaterThan(0);
  });

  test('a bounced ball comes back out and lands in front of the board', () => {
    const blocked: Board = dropPiece(emptyBoard(), 3, 2)!.board;
    const result = simulateShot(blocked, AT_C3_R0);
    const impact = pointAtStep(result.points, result.impactStep);
    expect(impact.z).toBeCloseTo(CONTACT_Z, 10);
    const last = pointAtStep(result.points, result.steps);
    expect(last.z).toBeGreaterThan(CONTACT_Z);
    expect(last.y).toBeCloseTo(GROUND_Y, 6);
  });

  test('hitting the frame between the holes bounces', () => {
    // Aim at the pillar between columns 3 and 4 on the bottom row.
    const between = { ...AT_C3_R0, yaw: Math.atan2(0.5, COURSE.tee.z - CONTACT_Z) };
    const result = simulateShot(emptyBoard(), between);
    expect(result.outcome).toBe('bounce');
  });

  test('the disc that blocks a hole is the one that was dropped there', () => {
    const board = setCell(emptyBoard(), 2, 4, 1);
    expect(simulateShot(board, AT_C2_R4).outcome).toBe('bounce');
    expect(simulateShot(emptyBoard(), AT_C2_R4).outcome).toBe('thread');
  });
});

describe('no tunnelling', () => {
  // Solved for the same aperture at each power; with the cell filled every one
  // of them must be stopped by the panel, however fast the ball is moving.
  const shotsAtC3R0: readonly ShotParams[] = [
    { yaw: 0, loft: 0.38484251499176025, power: 0.6, accuracy: 0 },
    { yaw: 0, loft: 0.29080979347229, power: 0.7, accuracy: 0 },
    { yaw: 0, loft: 0.23508789539337155, power: 0.8, accuracy: 0 },
    { yaw: 0, loft: 0.1985482692718506, power: 0.9, accuracy: 0 },
    { yaw: 0, loft: 0.17284824848175048, power: 1, accuracy: 0 },
  ];

  test('every power threads the open hole', () => {
    for (const params of shotsAtC3R0) {
      const result = simulateShot(emptyBoard(), params);
      expect(`${params.power}: ${result.outcome} ${JSON.stringify(result.entry)}`).toBe(
        `${params.power}: thread {"col":3,"row":0}`,
      );
    }
  });

  test('every power bounces when the hole is plugged, and none gets behind the panel', () => {
    const blocked = setCell(emptyBoard(), 3, 0, 1);
    for (const params of shotsAtC3R0) {
      const result = simulateShot(blocked, params);
      expect(`${params.power}: ${result.outcome}`).toBe(`${params.power}: bounce`);
      expect(minZ(result.points)).toBeGreaterThanOrEqual(CONTACT_Z - 1e-9);
    }
  });

  test('a full board can never be threaded, at any power or loft', () => {
    const full: Board = new Array(42).fill(1);
    for (let power = 0.4; power <= 1.0001; power += 0.05) {
      for (let loft = COURSE.minLoft; loft <= COURSE.maxLoft; loft += 0.05) {
        const result = simulateShot(full, { yaw: 0.03, loft, power, accuracy: 0 });
        expect(result.outcome).not.toBe('thread');
        expect(result.entry).toBeNull();
        if (result.impactStep >= 0) {
          expect(minZ(result.points)).toBeGreaterThanOrEqual(CONTACT_Z - 1e-9);
        }
      }
    }
  });
});

describe('spin', () => {
  test('accuracy curves the ball, and the sign points the right way', () => {
    const straight = simulateShot(emptyBoard(), AT_C2_R4);
    const slice = simulateShot(emptyBoard(), { ...AT_C2_R4, accuracy: 0.6 });
    const hook = simulateShot(emptyBoard(), { ...AT_C2_R4, accuracy: -0.6 });

    const xAt = (r: typeof straight): number => pointAtStep(r.points, r.impactStep).x;
    expect(xAt(slice)).toBeGreaterThan(xAt(straight) + 0.5);
    expect(xAt(hook)).toBeLessThan(xAt(straight) - 0.5);
    // A big enough curve lands the ball in a different column entirely.
    expect(slice.entry?.col).toBe(3);
    expect(hook.entry?.col).toBe(1);
  });

  test('a small slice drifts less than a big one', () => {
    const drift = (accuracy: number): number => {
      const r = simulateShot(emptyBoard(), { ...AT_C3_R0, accuracy });
      return pointAtStep(r.points, r.impactStep).x;
    };
    expect(drift(0.2)).toBeGreaterThan(0);
    expect(drift(0.6)).toBeGreaterThan(drift(0.2));
    expect(drift(-0.6)).toBeLessThan(drift(-0.2));
  });
});

describe('missing the board altogether', () => {
  test('a limp shot never gets there', () => {
    const result = simulateShot(emptyBoard(), { yaw: 0, loft: 0.3, power: 0.2, accuracy: 0 });
    expect(result.outcome).toBe('short');
    expect(result.impactStep).toBe(-1);
    expect(result.entry).toBeNull();
  });

  test('a wild slice sails out of play', () => {
    const result = simulateShot(emptyBoard(), {
      yaw: COURSE.maxYaw,
      loft: 0.35,
      power: 1,
      accuracy: 1,
    });
    expect(result.outcome).toBe('wide');
    expect(result.entry).toBeNull();
  });

  test('a shot over the top of the frame is wide, not a bounce', () => {
    const result = simulateShot(emptyBoard(), { yaw: 0, loft: 0.62, power: 0.95, accuracy: 0 });
    const probe = probeCrossing({ yaw: 0, loft: 0.62, power: 0.95, accuracy: 0 });
    expect(probe).not.toBeNull();
    expect(probe!.y).toBeGreaterThan(BOARD_MAX_Y);
    expect(result.outcome).toBe('wide');
  });

  test('every shot terminates well inside the step cap', () => {
    for (const params of [
      AT_C3_R0,
      { yaw: 0.3, loft: 0.5, power: 0.5, accuracy: 0.4 },
      { yaw: -0.4, loft: 0.9, power: 1, accuracy: -0.8 },
      { yaw: 0, loft: 0.05, power: 0.35, accuracy: 0 },
    ]) {
      const result = simulateShot(emptyBoard(), params);
      expect(result.steps).toBeLessThan(COURSE.maxSteps);
      expect(result.points.length).toBe((result.steps + 1) * 3);
    }
  });
});

describe('the AI probe matches the authoritative sim', () => {
  test('probeCrossing lands on exactly the same point as a full simulation', () => {
    const full: Board = new Array(42).fill(1); // every crossing becomes a bounce
    for (const params of [
      AT_C3_R0,
      AT_C0_R0,
      AT_C6_R2,
      AT_C2_R4,
      { yaw: 0.2, loft: 0.4, power: 0.85, accuracy: 0.3 },
      { yaw: -0.2, loft: 0.55, power: 0.62, accuracy: -0.15 },
    ]) {
      const probe = probeCrossing(params);
      const result = simulateShot(full, params);
      expect(probe).not.toBeNull();
      expect(onPanel(probe!.x, probe!.y)).toBe(true);
      expect(result.impactStep).toBe(probe!.step);
      const impact = pointAtStep(result.points, result.impactStep);
      // Bit-for-bit: the two share stepBall, so they cannot drift apart.
      expect(impact.x).toBe(probe!.x);
      expect(impact.y).toBe(probe!.y);
    }
  });
});

describe('geometry helpers', () => {
  test('cellForPoint inverts cellCenter', () => {
    for (let col = 0; col < 7; col++) {
      for (let row = 0; row < 6; row++) {
        const centre = cellCenter(col, row);
        expect(cellForPoint(centre.x, centre.y)).toEqual({ col, row });
        expect(onPanel(centre.x, centre.y)).toBe(true);
      }
    }
    expect(cellForPoint(20, 2)).toBeNull();
    expect(onPanel(20, 2)).toBe(false);
  });

  test('planeCrossing solves the swept intersection', () => {
    const hit = planeCrossing({ x: 0, y: 2, z: CONTACT_Z + 1 }, { x: 2, y: 4, z: CONTACT_Z - 1 });
    expect(hit?.t).toBeCloseTo(0.5, 12);
    expect(hit?.x).toBeCloseTo(1, 12);
    expect(hit?.y).toBeCloseTo(3, 12);
    expect(planeCrossing({ x: 0, y: 2, z: 5 }, { x: 0, y: 2, z: 4 })).toBeNull();
  });

  test('parameters are clamped to the course limits', () => {
    const clamped = clampShotParams({ yaw: 9, loft: -9, power: 4, accuracy: -8 });
    expect(clamped.yaw).toBe(COURSE.maxYaw);
    expect(clamped.loft).toBe(COURSE.minLoft);
    expect(clamped.power).toBe(1);
    expect(clamped.accuracy).toBe(-1);
  });

  test('launch velocity points down-range at the requested speed', () => {
    const velocity = launchVelocity({ yaw: 0, loft: 0, power: 1, accuracy: 0 });
    expect(velocity.z).toBeCloseTo(-COURSE.maxLaunchSpeed, 10);
    expect(velocity.x).toBeCloseTo(0, 12);
    const right = launchVelocity({ yaw: 0.3, loft: 0.2, power: 0.5, accuracy: 0 });
    expect(right.x).toBeGreaterThan(0);
    expect(right.y).toBeGreaterThan(0);
    expect(right.z).toBeLessThan(0);
    expect(Math.hypot(right.x, right.y, right.z)).toBeCloseTo(0.5 * COURSE.maxLaunchSpeed, 10);
  });
});
