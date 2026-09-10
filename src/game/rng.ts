/**
 * Deterministic pseudo-randomness for the simulation.
 *
 * `src/game/**` must never call `Math.random`: the Durable Object replays the
 * exact same code the browsers run, so every random draw has to come from a
 * seed both ends already agree on. `createRng` is mulberry32 — small, fast, and
 * identical across engines because every step stays in 32-bit integer land.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  nextRange(min: number, max: number): number;
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** Standard normal (mean 0, sigma 1) via Box-Muller with a cached spare. */
  nextGaussian(): number;
  /** A fresh independent stream derived from this one's seed plus `salt`. */
  fork(salt: number): Rng;
  /** Current internal state, so a match can be snapshotted and resumed. */
  state(): number;
}

/** FNV-1a, so a room code or player name can seed a match reproducibly. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministically blends two seeds (integer avalanche, no clock, no entropy). */
export function mixSeeds(a: number, b: number): number {
  let h = (a ^ Math.imul(b ^ (b >>> 16), 0x45d9f3b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  let spare: number | null = null;

  const next = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    nextRange: (min: number, max: number): number => min + (max - min) * next(),
    nextInt: (maxExclusive: number): number => {
      if (maxExclusive <= 0) return 0;
      return Math.min(maxExclusive - 1, Math.floor(next() * maxExclusive));
    },
    nextGaussian: (): number => {
      if (spare !== null) {
        const value = spare;
        spare = null;
        return value;
      }
      // (0, 1] so the log is always finite.
      const u1 = 1 - next();
      const u2 = next();
      const radius = Math.sqrt(-2 * Math.log(u1));
      const angle = 2 * Math.PI * u2;
      spare = radius * Math.sin(angle);
      return radius * Math.cos(angle);
    },
    fork: (salt: number): Rng => createRng(mixSeeds(s, salt)),
    state: (): number => s >>> 0,
  };
  return rng;
}
