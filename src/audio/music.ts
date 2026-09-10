/**
 * A tracker-shaped sequencer for the three in-game themes.
 *
 * Patterns are plain strings of whitespace-separated row tokens — `C5` starts a
 * note, `-` ties it into the next row, `.` rests — which keeps the songs compact
 * and readable. Playback uses the standard lookahead pattern: a 25 ms timer that
 * schedules every row falling inside the next 100 ms against
 * `AudioContext.currentTime`, so note timing is sample accurate and never rides
 * on `setTimeout` or `requestAnimationFrame` jitter.
 */
import type { MusicTrack } from './api';
import type { Apu, Duty, Envelope } from './apu';
import { noteToFreq } from './apu';

interface ToneLine {
  gain: number;
  duty?: Duty;
  env?: Envelope;
  /** Fraction of the slot the note actually sounds for. */
  legato?: number;
  bars: readonly string[];
}

interface DrumLine {
  gain: number;
  bars: readonly string[];
}

export interface TrackDef {
  bpm: number;
  /** Rows per quarter note; 4 means the patterns are written in 16ths. */
  rowsPerBeat: number;
  loop: boolean;
  pulse1?: ToneLine;
  pulse2?: ToneLine;
  triangle?: ToneLine;
  noise?: DrumLine;
}

type DrumKind = 'k' | 's' | 'h';

interface ToneEvent {
  freq: number;
  rows: number;
}

interface DrumEvent {
  kind: DrumKind;
  rows: number;
}

interface CompiledTone {
  line: ToneLine;
  events: readonly (ToneEvent | null)[];
}

interface CompiledDrums {
  line: DrumLine;
  events: readonly (DrumEvent | null)[];
}

interface CompiledTrack {
  def: TrackDef;
  rows: number;
  rowTime: number;
  pulse1: CompiledTone | null;
  pulse2: CompiledTone | null;
  triangle: CompiledTone | null;
  noise: CompiledDrums | null;
}

/** Splits `bars` into one token per row. */
function tokenize(bars: readonly string[]): string[] {
  const out: string[] = [];
  for (const bar of bars) {
    const trimmed = bar.trim();
    if (!trimmed) continue;
    for (const token of trimmed.split(/\s+/)) out.push(token);
  }
  return out;
}

function compileTone(line: ToneLine | undefined): CompiledTone | null {
  if (!line) return null;
  const tokens = tokenize(line.bars);
  const events: (ToneEvent | null)[] = new Array<ToneEvent | null>(tokens.length).fill(null);
  let open: ToneEvent | null = null;
  for (let row = 0; row < tokens.length; row++) {
    const token = tokens[row] ?? '.';
    if (token === '-') {
      if (open) open.rows++;
      continue;
    }
    open = null;
    if (token === '.') continue;
    const freq = noteToFreq(token);
    if (freq <= 0) continue;
    open = { freq, rows: 1 };
    events[row] = open;
  }
  return { line, events };
}

function compileDrums(line: DrumLine | undefined): CompiledDrums | null {
  if (!line) return null;
  const tokens = tokenize(line.bars);
  const events: (DrumEvent | null)[] = new Array<DrumEvent | null>(tokens.length).fill(null);
  let open: DrumEvent | null = null;
  for (let row = 0; row < tokens.length; row++) {
    const token = tokens[row] ?? '.';
    if (token === '-') {
      if (open) open.rows++;
      continue;
    }
    open = null;
    if (token !== 'k' && token !== 's' && token !== 'h') continue;
    open = { kind: token, rows: 1 };
    events[row] = open;
  }
  return { line, events };
}

function compile(def: TrackDef): CompiledTrack {
  const pulse1 = compileTone(def.pulse1);
  const pulse2 = compileTone(def.pulse2);
  const triangle = compileTone(def.triangle);
  const noise = compileDrums(def.noise);
  const rows = Math.max(
    pulse1?.events.length ?? 0,
    pulse2?.events.length ?? 0,
    triangle?.events.length ?? 0,
    noise?.events.length ?? 0,
  );
  return {
    def,
    rows,
    rowTime: 60 / def.bpm / def.rowsPerBeat,
    pulse1,
    pulse2,
    triangle,
    noise,
  };
}

function playDrum(
  apu: Apu,
  t: number,
  kind: DrumKind,
  gain: number,
  dest: AudioNode,
): void {
  if (kind === 'k') {
    apu.triangle({
      time: t,
      duration: 0.07,
      freq: 155,
      slideTo: 46,
      slideTime: 0.07,
      gain: gain * 3.2,
      env: { attack: 0.001, release: 0.035 },
      dest,
    });
    apu.noise({
      time: t,
      duration: 0.025,
      rate: 2600,
      rateTo: 1200,
      gain: gain * 1.1,
      env: { attack: 0.001, release: 0.02 },
      filter: { type: 'lowpass', freq: 420, q: 0.7 },
      dest,
    });
    return;
  }
  if (kind === 's') {
    apu.noise({
      time: t,
      duration: 0.055,
      rate: 9000,
      gain: gain * 1.5,
      env: { attack: 0.001, decay: 0.045, sustain: 0.25, release: 0.04 },
      filter: { type: 'bandpass', freq: 1800, q: 0.6 },
      dest,
    });
    return;
  }
  apu.noise({
    time: t,
    duration: 0.014,
    rate: 22000,
    gain: gain * 0.85,
    env: { attack: 0.001, release: 0.018 },
    filter: { type: 'highpass', freq: 4800, q: 0.7 },
    dest,
  });
}

/** Where playback has reached: the next row to schedule and its start time. */
export interface Cursor {
  row: number;
  time: number;
  /** Set once a non-looping track has scheduled its final row. */
  done: boolean;
}

/**
 * Schedules every row whose start time is before `until`, advancing the cursor.
 * Pure with respect to wall-clock time, so the same function drives both the
 * live lookahead loop and offline renders.
 */
export function scheduleWindow(
  apu: Apu,
  track: CompiledTrack,
  dest: AudioNode,
  cursor: Cursor,
  until: number,
): void {
  if (track.rows === 0) {
    cursor.done = true;
    return;
  }
  while (!cursor.done && cursor.time < until) {
    const row = cursor.row;
    const t = cursor.time;
    scheduleTone(apu, track.pulse1, row, t, track.rowTime, dest, true);
    scheduleTone(apu, track.pulse2, row, t, track.rowTime, dest, true);
    scheduleTone(apu, track.triangle, row, t, track.rowTime, dest, false);
    const drums = track.noise;
    if (drums) {
      const event = drums.events[row];
      if (event) playDrum(apu, t, event.kind, drums.line.gain, dest);
    }
    cursor.row = row + 1;
    cursor.time = t + track.rowTime;
    if (cursor.row >= track.rows) {
      if (track.def.loop) cursor.row = 0;
      else cursor.done = true;
    }
  }
}

function scheduleTone(
  apu: Apu,
  compiled: CompiledTone | null,
  row: number,
  t: number,
  rowTime: number,
  dest: AudioNode,
  isPulse: boolean,
): void {
  if (!compiled) return;
  const event = compiled.events[row];
  if (!event) return;
  const { line } = compiled;
  const duration = Math.max(0.02, event.rows * rowTime * (line.legato ?? 0.9));
  const options = {
    time: t,
    duration,
    freq: event.freq,
    gain: line.gain,
    env: line.env ?? { attack: 0.004, decay: 0.05, sustain: 0.7, release: 0.04 },
    dest,
  };
  if (isPulse) apu.pulse({ ...options, duty: line.duty ?? 0.5 });
  else apu.triangle(options);
}

const TITLE: TrackDef = {
  bpm: 150,
  rowsPerBeat: 4,
  loop: true,
  pulse1: {
    duty: 0.5,
    gain: 0.085,
    bars: [
      'C5 -  E5 -  G5 -  C6 -  B5 -  G5 -  E5 -  D5 - ',
      'E5 -  -  -  .  .  .  .  A5 -  C6 -  E6 -  D6 - ',
      'C6 -  -  -  B5 -  A5 -  G5 -  A5 -  B5 -  G5 - ',
      'E5 -  G5 -  C6 -  -  -  -  -  -  -  .  .  .  . ',
    ],
  },
  pulse2: {
    duty: 0.25,
    gain: 0.055,
    legato: 0.6,
    bars: [
      '.  E4 .  G4 .  E4 .  G4 .  E4 .  G4 .  E4 .  G4',
      '.  E4 .  A4 .  E4 .  A4 .  E4 .  A4 .  E4 .  A4',
      '.  D4 .  G4 .  D4 .  G4 .  D4 .  G4 .  D4 .  G4',
      '.  E4 .  G4 .  E4 .  G4 .  E4 .  G4 .  E4 .  G4',
    ],
  },
  triangle: {
    gain: 0.22,
    legato: 0.8,
    bars: [
      'C3 -  C3 -  G2 -  G2 -  C3 -  C3 -  G2 -  G2 - ',
      'A2 -  A2 -  E3 -  E3 -  A2 -  A2 -  E3 -  E3 - ',
      'G2 -  G2 -  D3 -  D3 -  G2 -  G2 -  D3 -  D3 - ',
      'C3 -  C3 -  G2 -  G2 -  C3 -  C3 -  G3 -  G3 - ',
    ],
  },
  noise: {
    gain: 0.07,
    bars: [
      'k .  h .  s .  h .  k .  h .  s .  h . ',
      'k .  h .  s .  h .  k .  h .  s .  h . ',
      'k .  h .  s .  h .  k .  h .  s .  h . ',
      'k .  h .  s .  h .  k .  h .  s  s  s  s',
    ],
  },
};

// Deliberately sparse: long pads and a half-time pulse so it can loop under a
// ten-minute match without wearing a hole in the player's patience.
const PLAY: TrackDef = {
  bpm: 96,
  rowsPerBeat: 4,
  loop: true,
  pulse1: {
    duty: 0.125,
    gain: 0.055,
    legato: 0.85,
    bars: [
      'A4 -  -  -  -  -  -  -  .  .  .  .  E5 -  -  - ',
      'D5 -  -  -  -  -  -  -  -  -  -  -  .  .  .  . ',
      'C5 -  -  -  -  -  -  -  .  .  .  .  A4 -  -  - ',
      'B4 -  -  -  -  -  -  -  -  -  -  -  .  .  .  . ',
    ],
  },
  pulse2: {
    duty: 0.5,
    gain: 0.038,
    legato: 0.95,
    env: { attack: 0.08, decay: 0.2, sustain: 0.7, release: 0.12 },
    bars: [
      'E4 -  -  -  -  -  -  -  -  -  -  -  -  -  -  - ',
      'F4 -  -  -  -  -  -  -  -  -  -  -  -  -  -  - ',
      'E4 -  -  -  -  -  -  -  -  -  -  -  -  -  -  - ',
      'G#4 - -  -  -  -  -  -  -  -  -  -  -  -  -  - ',
    ],
  },
  triangle: {
    gain: 0.26,
    legato: 0.7,
    bars: [
      'A2 -  -  -  -  -  E2 -  A2 -  -  -  E2 -  -  - ',
      'D3 -  -  -  -  -  A2 -  D3 -  -  -  A2 -  -  - ',
      'C3 -  -  -  -  -  G2 -  C3 -  -  -  G2 -  -  - ',
      'E3 -  -  -  -  -  B2 -  E3 -  -  -  B2 -  -  - ',
    ],
  },
  noise: {
    gain: 0.05,
    bars: [
      'h .  .  .  h .  .  .  h .  .  .  h .  .  . ',
      'h .  .  .  h .  .  .  h .  .  .  h .  .  . ',
      'h .  .  .  h .  .  .  h .  .  .  h .  .  . ',
      'h .  .  .  h .  .  .  h .  .  .  h .  s  . ',
    ],
  },
};

const VICTORY: TrackDef = {
  bpm: 180,
  rowsPerBeat: 4,
  loop: false,
  pulse1: {
    duty: 0.25,
    gain: 0.13,
    bars: [
      'G4 .  C5 .  E5 .  G5 .  C6 -  -  -  -  -  -  - ',
      'E5 .  G5 .  C6 .  E6 .  G6 -  -  -  -  -  -  - ',
      'F6 -  E6 -  D6 -  C6 -  -  -  -  -  -  -  -  - ',
    ],
  },
  pulse2: {
    duty: 0.125,
    gain: 0.08,
    bars: [
      'E4 .  G4 .  C5 .  E5 .  G5 -  -  -  -  -  -  - ',
      'C5 .  E5 .  G5 .  C6 .  E6 -  -  -  -  -  -  - ',
      'A5 -  G5 -  F5 -  E5 -  -  -  -  -  -  -  -  - ',
    ],
  },
  triangle: {
    gain: 0.32,
    legato: 0.8,
    bars: [
      'C3 -  -  -  C3 -  -  -  G2 -  -  -  G2 -  -  - ',
      'C3 -  -  -  C3 -  -  -  G3 -  -  -  G3 -  -  - ',
      'F2 -  -  -  G2 -  -  -  C3 -  -  -  -  -  -  - ',
    ],
  },
  noise: {
    gain: 0.09,
    bars: [
      's .  s .  s .  s .  k .  .  .  k .  .  . ',
      's .  s .  s .  s .  k .  .  .  k .  .  . ',
      'k .  .  .  k .  .  .  k  s  s  s  .  .  .  . ',
    ],
  },
};

export const TRACKS: Record<MusicTrack, TrackDef> = {
  title: TITLE,
  play: PLAY,
  victory: VICTORY,
};

const compiledCache = new Map<MusicTrack, CompiledTrack>();

export function compiledTrack(name: MusicTrack): CompiledTrack {
  const cached = compiledCache.get(name);
  if (cached) return cached;
  const built = compile(TRACKS[name]);
  compiledCache.set(name, built);
  return built;
}

/** Total loop length in seconds — handy for offline renders and tests. */
export function trackDuration(name: MusicTrack): number {
  const track = compiledTrack(name);
  return track.rows * track.rowTime;
}

/**
 * Renders one contiguous stretch of a track in a single call. Used by the
 * offline test harness; the live player calls `scheduleWindow` in slices.
 */
export function scheduleTrackAt(
  apu: Apu,
  name: MusicTrack,
  dest: AudioNode,
  startTime: number,
  duration: number,
): void {
  const track = compiledTrack(name);
  const cursor: Cursor = { row: 0, time: startTime, done: false };
  scheduleWindow(apu, track, dest, cursor, startTime + duration);
}

const TIMER_MS = 25;
const LOOKAHEAD = 0.1;
const CROSSFADE = 0.35;

interface Group {
  name: MusicTrack;
  track: CompiledTrack;
  gain: GainNode;
  cursor: Cursor;
}

/** Drives one track at a time, crossfading on change. */
export class MusicPlayer {
  private readonly apu: Apu;
  private readonly dest: AudioNode;
  private active: Group | null = null;
  private readonly retiring: { gain: GainNode; until: number }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(apu: Apu, dest: AudioNode) {
    this.apu = apu;
    this.dest = dest;
  }

  get current(): MusicTrack | null {
    return this.active?.name ?? null;
  }

  play(name: MusicTrack): void {
    if (this.active?.name === name) return;
    const now = this.apu.now;
    const wasPlaying = this.active !== null;
    this.retire(now, CROSSFADE);

    const gain = this.apu.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(1, now + (wasPlaying ? CROSSFADE : 0.05));
    gain.connect(this.dest);
    this.active = {
      name,
      track: compiledTrack(name),
      gain,
      cursor: { row: 0, time: now + 0.08, done: false },
    };
    this.tick();
    this.start();
  }

  stop(fade = CROSSFADE): void {
    this.retire(this.apu.now, fade);
    this.stopTimer();
  }

  dispose(): void {
    this.stopTimer();
    if (this.active) {
      this.active.gain.disconnect();
      this.active = null;
    }
    for (const entry of this.retiring) entry.gain.disconnect();
    this.retiring.length = 0;
  }

  private retire(now: number, fade: number): void {
    const group = this.active;
    if (!group) return;
    this.active = null;
    group.gain.gain.cancelScheduledValues(now);
    group.gain.gain.setValueAtTime(Math.max(0.0001, group.gain.gain.value), now);
    group.gain.gain.linearRampToValueAtTime(0, now + fade);
    this.retiring.push({ gain: group.gain, until: now + fade + 0.5 });
  }

  private start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), TIMER_MS);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = this.apu.now;
    for (let i = this.retiring.length - 1; i >= 0; i--) {
      const entry = this.retiring[i];
      if (entry && now >= entry.until) {
        entry.gain.disconnect();
        this.retiring.splice(i, 1);
      }
    }
    const group = this.active;
    if (!group) {
      if (this.retiring.length === 0) this.stopTimer();
      return;
    }
    scheduleWindow(this.apu, group.track, group.gain, group.cursor, now + LOOKAHEAD);
    if (group.cursor.done && now >= group.cursor.time) {
      this.active = null;
      const gain = group.gain;
      this.retiring.push({ gain, until: now + 1 });
    }
  }
}
