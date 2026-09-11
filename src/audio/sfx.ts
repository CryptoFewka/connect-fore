/**
 * The sound effect bank. Every entry is a tiny score for the APU primitives:
 * a handful of pulse/triangle/noise voices scheduled against an absolute
 * AudioContext time, so effects can be queued slightly ahead without jitter.
 */
import type { SfxName } from './api';
import type { Apu } from './apu';
import { noteToFreq } from './apu';

type Voice = (apu: Apu, t: number, dest: AudioNode) => void;

/** Plays a run of notes on one pulse channel. */
function arpeggio(
  apu: Apu,
  t: number,
  dest: AudioNode,
  notes: readonly string[],
  step: number,
  hold: number,
  gain: number,
  duty: 0.125 | 0.25 | 0.5,
): void {
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (!note) continue;
    apu.pulse({
      time: t + i * step,
      duration: hold,
      freq: noteToFreq(note),
      duty,
      gain,
      env: { attack: 0.002, release: 0.02 },
      dest,
    });
  }
}

const BANK: Record<SfxName, Voice> = {
  'menu-move': (apu, t, dest) => {
    apu.pulse({
      time: t,
      duration: 0.035,
      freq: 523,
      slideTo: 784,
      slideTime: 0.03,
      duty: 0.25,
      gain: 0.16,
      env: { attack: 0.002, release: 0.025 },
      dest,
    });
  },

  'menu-select': (apu, t, dest) => {
    apu.pulse({
      time: t,
      duration: 0.045,
      freq: noteToFreq('G5'),
      duty: 0.25,
      gain: 0.18,
      env: { attack: 0.002, release: 0.02 },
      dest,
    });
    apu.pulse({
      time: t + 0.055,
      duration: 0.09,
      freq: noteToFreq('D6'),
      duty: 0.25,
      gain: 0.18,
      env: { attack: 0.002, decay: 0.06, sustain: 0.5, release: 0.05 },
      dest,
    });
  },

  // Fires ~20x a second while the power meter sweeps: one oscillator, one gain,
  // no filter, no LFO, and short enough that consecutive ticks never overlap.
  'meter-tick': (apu, t, dest) => {
    apu.pulse({
      time: t,
      duration: 0.008,
      freq: 1760,
      duty: 0.125,
      gain: 0.07,
      env: { attack: 0.001, release: 0.012 },
      dest,
    });
  },

  'meter-lock': (apu, t, dest) => {
    apu.pulse({
      time: t,
      duration: 0.08,
      freq: 440,
      slideTo: 110,
      slideTime: 0.08,
      duty: 0.5,
      gain: 0.2,
      env: { attack: 0.001, release: 0.03 },
      dest,
    });
    apu.noise({
      time: t,
      duration: 0.04,
      rate: 16000,
      metallic: true,
      gain: 0.1,
      env: { attack: 0.001, release: 0.03 },
      filter: { type: 'highpass', freq: 1200, q: 0.7 },
      dest,
    });
  },

  // Club strike: a filtered whoosh with a hard transient riding on top.
  swing: (apu, t, dest) => {
    apu.noise({
      time: t,
      duration: 0.1,
      rate: 7000,
      rateTo: 22000,
      gain: 0.26,
      env: { attack: 0.006, decay: 0.07, sustain: 0.35, release: 0.05 },
      filter: { type: 'bandpass', freq: 800, freqTo: 4200, q: 0.8 },
      dest,
    });
    apu.pulse({
      time: t + 0.055,
      duration: 0.05,
      freq: 1500,
      slideTo: 260,
      slideTime: 0.05,
      duty: 0.125,
      gain: 0.14,
      env: { attack: 0.001, release: 0.02 },
      dest,
    });
  },

  // The reward: a bright rising arpeggio blip when the ball threads the gap.
  thread: (apu, t, dest) => {
    arpeggio(apu, t, dest, ['C6', 'E6', 'G6', 'C7'], 0.042, 0.038, 0.17, 0.125);
    apu.pulse({
      time: t + 0.168,
      duration: 0.16,
      freq: noteToFreq('E7'),
      duty: 0.25,
      gain: 0.14,
      env: { attack: 0.002, decay: 0.1, sustain: 0.3, release: 0.09 },
      vibratoHz: 14,
      vibratoCents: 22,
      vibratoDelay: 0.05,
      dest,
    });
  },

  // Failure: the ball slaps the board and drops. Dull, low, no sparkle.
  thud: (apu, t, dest) => {
    apu.triangle({
      time: t,
      duration: 0.2,
      freq: 150,
      slideTo: 62,
      slideTime: 0.2,
      gain: 0.45,
      env: { attack: 0.002, decay: 0.12, sustain: 0.35, release: 0.07 },
      dest,
    });
    apu.noise({
      time: t,
      duration: 0.16,
      rate: 3200,
      rateTo: 1100,
      gain: 0.18,
      env: { attack: 0.001, decay: 0.1, sustain: 0.2, release: 0.06 },
      filter: { type: 'lowpass', freq: 620, freqTo: 260, q: 0.9 },
      dest,
    });
  },

  // An opponent's disc is destroyed: a long noise sweep for the blast, with the
  // triangle dropping out from under it so it lands in the chest.
  explode: (apu, t, dest) => {
    apu.noise({
      time: t,
      duration: 0.5,
      rate: 9000,
      rateTo: 400,
      gain: 0.5,
      env: { attack: 0.001, decay: 0.22, sustain: 0.35, release: 0.24 },
      filter: { type: 'lowpass', freq: 5200, freqTo: 300, q: 1.2 },
      dest,
    });
    apu.triangle({
      time: t,
      duration: 0.42,
      freq: 190,
      slideTo: 32,
      slideTime: 0.4,
      gain: 0.5,
      env: { attack: 0.002, decay: 0.2, sustain: 0.3, release: 0.18 },
      dest,
    });
    // A shard of the disc pinging away.
    apu.pulse({
      time: t + 0.04,
      duration: 0.16,
      freq: 880,
      slideTo: 220,
      slideTime: 0.15,
      duty: 0.125,
      gain: 0.16,
      env: { attack: 0.001, decay: 0.08, sustain: 0.2, release: 0.06 },
      dest,
    });
  },

  // Disc lands on the stack: short-mode LFSR gives it a plastic-on-plastic tick.
  clack: (apu, t, dest) => {
    apu.noise({
      time: t,
      duration: 0.035,
      rate: 24000,
      metallic: true,
      gain: 0.22,
      env: { attack: 0.001, decay: 0.025, sustain: 0.15, release: 0.025 },
      filter: { type: 'highpass', freq: 900, q: 0.8 },
      dest,
    });
    apu.pulse({
      time: t,
      duration: 0.018,
      freq: 1180,
      duty: 0.125,
      gain: 0.1,
      env: { attack: 0.001, release: 0.015 },
      dest,
    });
  },

  drop: (apu, t, dest) => {
    apu.pulse({
      time: t,
      duration: 0.18,
      freq: 880,
      slideTo: 210,
      slideTime: 0.18,
      duty: 0.5,
      gain: 0.13,
      env: { attack: 0.003, decay: 0.12, sustain: 0.45, release: 0.04 },
      dest,
    });
  },

  win: (apu, t, dest) => {
    const melody: readonly [string, number, number][] = [
      ['G5', 0, 0.1],
      ['C6', 0.11, 0.1],
      ['E6', 0.22, 0.1],
      ['G6', 0.33, 0.14],
      ['E6', 0.48, 0.09],
      ['G6', 0.58, 0.5],
    ];
    for (const entry of melody) {
      apu.pulse({
        time: t + entry[1],
        duration: entry[2],
        freq: noteToFreq(entry[0]),
        duty: 0.25,
        gain: 0.19,
        env: { attack: 0.003, decay: 0.2, sustain: 0.55, release: 0.09 },
        dest,
      });
    }
    const harmony: readonly [string, number, number][] = [
      ['E5', 0, 0.1],
      ['G5', 0.11, 0.1],
      ['C6', 0.22, 0.1],
      ['E6', 0.33, 0.14],
      ['C6', 0.48, 0.09],
      ['E6', 0.58, 0.5],
    ];
    for (const entry of harmony) {
      apu.pulse({
        time: t + entry[1],
        duration: entry[2],
        freq: noteToFreq(entry[0]),
        duty: 0.125,
        gain: 0.11,
        env: { attack: 0.004, decay: 0.2, sustain: 0.5, release: 0.09 },
        dest,
      });
    }
    const bass: readonly [string, number, number][] = [
      ['C3', 0, 0.2],
      ['G3', 0.22, 0.1],
      ['C4', 0.33, 0.22],
      ['C3', 0.58, 0.5],
    ];
    for (const entry of bass) {
      apu.triangle({
        time: t + entry[1],
        duration: entry[2],
        freq: noteToFreq(entry[0]),
        gain: 0.34,
        env: { attack: 0.004, release: 0.05 },
        dest,
      });
    }
    for (let i = 0; i < 4; i++) {
      apu.noise({
        time: t + 0.33 + i * 0.055,
        duration: 0.03,
        rate: 11000,
        gain: 0.11,
        env: { attack: 0.001, release: 0.03 },
        filter: { type: 'highpass', freq: 2000, q: 0.7 },
        dest,
      });
    }
  },

  lose: (apu, t, dest) => {
    const fall: readonly [string, number][] = [
      ['G4', 0],
      ['F#4', 0.13],
      ['F4', 0.26],
      ['E4', 0.39],
    ];
    for (const entry of fall) {
      const last = entry[1] > 0.3;
      apu.pulse({
        time: t + entry[1],
        duration: last ? 0.42 : 0.12,
        freq: noteToFreq(entry[0]),
        duty: 0.5,
        gain: 0.16,
        env: { attack: 0.004, decay: 0.25, sustain: 0.4, release: 0.12 },
        ...(last ? { vibratoHz: 5.5, vibratoCents: 30, vibratoDelay: 0.12 } : {}),
        dest,
      });
    }
    apu.triangle({
      time: t,
      duration: 0.78,
      freq: noteToFreq('E2'),
      slideTo: noteToFreq('A1'),
      slideTime: 0.78,
      gain: 0.32,
      env: { attack: 0.01, decay: 0.5, sustain: 0.45, release: 0.15 },
      dest,
    });
  },

  // Unresolved on purpose: two whole-tone steps that never land on a tonic.
  draw: (apu, t, dest) => {
    const pairs: readonly [string, string, number][] = [
      ['C5', 'F#5', 0],
      ['D5', 'G#5', 0.2],
    ];
    for (const pair of pairs) {
      const last = pair[2] > 0;
      apu.pulse({
        time: t + pair[2],
        duration: last ? 0.4 : 0.17,
        freq: noteToFreq(pair[0]),
        duty: 0.5,
        gain: 0.14,
        env: { attack: 0.004, release: 0.1 },
        dest,
      });
      apu.pulse({
        time: t + pair[2],
        duration: last ? 0.4 : 0.17,
        freq: noteToFreq(pair[1]),
        duty: 0.25,
        gain: 0.11,
        env: { attack: 0.004, release: 0.1 },
        dest,
      });
    }
    apu.triangle({
      time: t,
      duration: 0.6,
      freq: noteToFreq('C3'),
      gain: 0.26,
      env: { attack: 0.008, release: 0.12 },
      dest,
    });
  },

  join: (apu, t, dest) => {
    arpeggio(apu, t, dest, ['E5', 'B5'], 0.07, 0.06, 0.16, 0.25);
  },

  leave: (apu, t, dest) => {
    arpeggio(apu, t, dest, ['B5', 'E5'], 0.07, 0.06, 0.14, 0.25);
    apu.pulse({
      time: t + 0.14,
      duration: 0.1,
      freq: noteToFreq('E5'),
      slideTo: noteToFreq('B4'),
      slideTime: 0.1,
      duty: 0.5,
      gain: 0.1,
      env: { attack: 0.003, release: 0.06 },
      dest,
    });
  },
};

export const SFX_NAMES = Object.keys(BANK) as SfxName[];

/**
 * How long a given effect refuses to retrigger, in seconds. Keeps repeated
 * calls (notably the meter tick) from stacking into a distorted mush.
 */
const THROTTLE: Partial<Record<SfxName, number>> = {
  'meter-tick': 0.028,
  clack: 0.04,
  'menu-move': 0.05,
};

/** Slight lead so the graph never has to start a voice in the past. */
const LEAD = 0.005;

export class SfxBank {
  private readonly apu: Apu;
  private readonly last = new Map<SfxName, number>();

  constructor(apu: Apu) {
    this.apu = apu;
  }

  /** `when` defaults to "as soon as possible". */
  play(name: SfxName, dest: AudioNode, when?: number): void {
    const voice = BANK[name];
    const t = (when ?? this.apu.now) + LEAD;
    const gap = THROTTLE[name];
    if (gap !== undefined) {
      const previous = this.last.get(name);
      if (previous !== undefined && t - previous < gap) return;
      this.last.set(name, t);
    }
    voice(this.apu, t, dest);
  }

  reset(): void {
    this.last.clear();
  }
}
