/**
 * NES APU-flavoured channel primitives on a single Web Audio graph.
 *
 * Four voice types, all synthesised at runtime:
 *   - two PULSE channels (12.5% / 25% / 50% duty `PeriodicWave`s from the
 *     closed-form Fourier series of a duty-cycled square),
 *   - a TRIANGLE channel built from the real NES 16-level staircase, so it
 *     buzzes like 2A03 bass instead of a clean synth triangle,
 *   - a NOISE channel driven by the 15-bit LFSR the NES actually uses, in both
 *     long (32767-step, white) and short (93-step, metallic) modes.
 *
 * Everything hangs off one master GainNode so mute/volume is a single node, and
 * a zero-latency soft-clipper sits between that and the destination so stacked
 * voices bend instead of clipping past 1.0.
 */

export type Duty = 0.125 | 0.25 | 0.5;

/** Linear ADSR, in seconds. `sustain` is a fraction of the peak. */
export interface Envelope {
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
}

interface VoiceBase {
  /** Absolute AudioContext time. */
  time: number;
  /** Time from attack to the start of the release, in seconds. */
  duration: number;
  gain?: number;
  env?: Envelope;
  dest?: AudioNode;
}

export interface ToneOptions extends VoiceBase {
  freq: number;
  /** Pitch glide target; reached at `time + (slideTime ?? duration)`. */
  slideTo?: number;
  slideTime?: number;
  vibratoHz?: number;
  vibratoCents?: number;
  /** Vibrato fades in over this long, the way a tracker delays it. */
  vibratoDelay?: number;
}

export interface PulseOptions extends ToneOptions {
  duty?: Duty;
}

export interface FilterSpec {
  type: BiquadFilterType;
  freq: number;
  /** Sweeps the cutoff to here across the note. */
  freqTo?: number;
  q?: number;
}

export interface NoiseOptions extends VoiceBase {
  /** LFSR clock in Hz — this is the noise channel's "pitch". */
  rate?: number;
  rateTo?: number;
  /** Short-mode LFSR: a 93-step loop that rings like metal. */
  metallic?: boolean;
  filter?: FilterSpec;
}

const DEFAULT_ENV: Required<Envelope> = {
  attack: 0.004,
  decay: 0,
  sustain: 1,
  release: 0.03,
};

/** Fills the gaps in a partial envelope, tolerating explicit `undefined`s. */
function mergeEnv(env: Envelope | undefined): Required<Envelope> {
  return {
    attack: env?.attack ?? DEFAULT_ENV.attack,
    decay: env?.decay ?? DEFAULT_ENV.decay,
    sustain: env?.sustain ?? DEFAULT_ENV.sustain,
    release: env?.release ?? DEFAULT_ENV.release,
  };
}

/** Harmonics kept in the generated PeriodicWaves. */
const HARMONICS = 48;
/** Sample count for the numeric Fourier transform of the triangle staircase. */
const DFT_POINTS = 1024;
/** Voices in flight are capped so a stuck caller cannot melt the graph. */
const MAX_VOICES = 32;
/** Below this the graph is effectively silent; used for exponential ramps. */
const EPSILON = 0.0001;

const LFSR_LONG_PERIOD = 32767;
const LFSR_SHORT_PERIOD = 93;

/**
 * Fourier series of a duty-cycled square wave, +1 for `t < duty` and -1 after.
 * Closed form, so the pulse waves cost nothing to build.
 */
function pulseCoefficients(duty: number, harmonics: number): [Float32Array, Float32Array] {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) {
    const theta = 2 * Math.PI * k * duty;
    real[k] = (2 * Math.sin(theta)) / (Math.PI * k);
    imag[k] = (-2 * (1 - Math.cos(theta))) / (Math.PI * k);
  }
  return [real, imag];
}

/** NES triangle: 32 steps per period walking 0..15 and back down. */
function triangleStep(t: number): number {
  const step = Math.floor(t * 32) % 32;
  const level = step < 16 ? step : 31 - step;
  return (level / 15) * 2 - 1;
}

/** Numeric Fourier transform of an arbitrary one-period shape. */
function coefficientsFromShape(
  shape: (t: number) => number,
  harmonics: number,
): [Float32Array, Float32Array] {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  const samples = new Float32Array(DFT_POINTS);
  for (let n = 0; n < DFT_POINTS; n++) samples[n] = shape(n / DFT_POINTS);
  for (let k = 1; k <= harmonics; k++) {
    let a = 0;
    let b = 0;
    for (let n = 0; n < DFT_POINTS; n++) {
      const v = samples[n] ?? 0;
      const angle = (2 * Math.PI * k * n) / DFT_POINTS;
      a += v * Math.cos(angle);
      b += v * Math.sin(angle);
    }
    real[k] = (2 / DFT_POINTS) * a;
    imag[k] = (-2 / DFT_POINTS) * b;
  }
  return [real, imag];
}

/**
 * The 2A03 noise generator: a 15-bit shift register seeded to 1, tapping bit 1
 * (long) or bit 6 (short). One output sample per LFSR clock; the caller pitches
 * it with `playbackRate`.
 */
function lfsrBuffer(ctx: BaseAudioContext, metallic: boolean): AudioBuffer {
  const period = metallic ? LFSR_SHORT_PERIOD : LFSR_LONG_PERIOD;
  const buffer = ctx.createBuffer(1, period, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let reg = 1;
  for (let i = 0; i < period; i++) {
    const other = metallic ? (reg >> 6) & 1 : (reg >> 1) & 1;
    const feedback = (reg & 1) ^ other;
    reg = (reg >> 1) | (feedback << 14);
    // The channel is muted while bit 0 is set, so bit 0 picks the level.
    data[i] = (reg & 1) === 0 ? 1 : -1;
  }
  return buffer;
}

/**
 * Soft-clip curve: unity below the knee, then a tanh bend that asymptotes at
 * 1.0. Zero latency (unlike a DynamicsCompressor) and never overshoots.
 */
function softClipCurve(knee: number, points: number) {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    const mag = Math.abs(x);
    const shaped =
      mag <= knee ? mag : knee + (1 - knee) * Math.tanh((mag - knee) / (1 - knee));
    curve[i] = Math.sign(x) * shaped;
  }
  return curve;
}

export class Apu {
  readonly ctx: BaseAudioContext;
  /** Mute and volume live here; it is also the default voice destination. */
  readonly master: GainNode;

  private readonly limiter: WaveShaperNode;
  private readonly waves = new Map<string, PeriodicWave>();
  private readonly noiseBuffers = new Map<string, AudioBuffer>();
  /** Start/stop times of scheduled voices, used for the polyphony cap. */
  private readonly voiceStarts: number[] = [];
  private readonly voiceStops: number[] = [];
  private disposed = false;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.limiter = ctx.createWaveShaper();
    this.limiter.curve = softClipCurve(0.6, 1024);
    this.limiter.oversample = '2x';
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Voices scheduled but not yet finished. Diagnostic only. */
  get activeVoices(): number {
    const now = this.ctx.currentTime;
    let live = 0;
    for (let i = 0; i < this.voiceStops.length; i++) {
      if ((this.voiceStops[i] ?? 0) > now) live++;
    }
    return live;
  }

  pulseWave(duty: Duty): PeriodicWave {
    const key = `p${duty}`;
    const cached = this.waves.get(key);
    if (cached) return cached;
    const [real, imag] = pulseCoefficients(duty, HARMONICS);
    const wave = this.ctx.createPeriodicWave(real, imag);
    this.waves.set(key, wave);
    return wave;
  }

  triangleWave(): PeriodicWave {
    const cached = this.waves.get('tri');
    if (cached) return cached;
    const [real, imag] = coefficientsFromShape(triangleStep, HARMONICS);
    const wave = this.ctx.createPeriodicWave(real, imag);
    this.waves.set('tri', wave);
    return wave;
  }

  noiseBuffer(metallic: boolean): AudioBuffer {
    const key = metallic ? 'short' : 'long';
    const cached = this.noiseBuffers.get(key);
    if (cached) return cached;
    const buffer = lfsrBuffer(this.ctx, metallic);
    this.noiseBuffers.set(key, buffer);
    return buffer;
  }

  /** Pre-builds every wavetable so the first note never stutters. */
  warm(): void {
    this.pulseWave(0.125);
    this.pulseWave(0.25);
    this.pulseWave(0.5);
    this.triangleWave();
    this.noiseBuffer(false);
    this.noiseBuffer(true);
  }

  pulse(opts: PulseOptions): void {
    this.tone(this.pulseWave(opts.duty ?? 0.5), opts);
  }

  triangle(opts: ToneOptions): void {
    this.tone(this.triangleWave(), opts);
  }

  noise(opts: NoiseOptions): void {
    const { ctx } = this;
    const t0 = Math.max(opts.time, ctx.currentTime);
    const env = mergeEnv(opts.env);
    const peak = opts.gain ?? 0.2;
    const stop = t0 + opts.duration + env.release + 0.01;
    if (!this.claimVoice(t0, stop)) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(opts.metallic ?? false);
    src.loop = true;
    const rate = (opts.rate ?? 12000) / ctx.sampleRate;
    src.playbackRate.setValueAtTime(Math.max(0.001, rate), t0);
    if (opts.rateTo !== undefined) {
      src.playbackRate.exponentialRampToValueAtTime(
        Math.max(0.001, opts.rateTo / ctx.sampleRate),
        t0 + opts.duration,
      );
    }

    const amp = ctx.createGain();
    applyEnvelope(amp.gain, t0, opts.duration, peak, env);

    const tail: AudioNode[] = [amp];
    let head: AudioNode = amp;
    if (opts.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = opts.filter.type;
      filter.Q.value = opts.filter.q ?? 1;
      filter.frequency.setValueAtTime(opts.filter.freq, t0);
      if (opts.filter.freqTo !== undefined) {
        filter.frequency.exponentialRampToValueAtTime(
          Math.max(20, opts.filter.freqTo),
          t0 + opts.duration,
        );
      }
      amp.connect(filter);
      tail.push(filter);
      head = filter;
    }
    src.connect(amp);
    head.connect(opts.dest ?? this.master);
    this.launch(src, t0, stop, tail);
  }

  /** Silences every voice immediately; used by `dispose`. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setValueAtTime(0, this.ctx.currentTime);
      this.master.disconnect();
      this.limiter.disconnect();
    } catch {
      // A closed context throws here; nothing left to clean up either way.
    }
    this.waves.clear();
    this.noiseBuffers.clear();
    this.voiceStarts.length = 0;
    this.voiceStops.length = 0;
  }

  private tone(wave: PeriodicWave, opts: ToneOptions): void {
    const { ctx } = this;
    const t0 = Math.max(opts.time, ctx.currentTime);
    const env = mergeEnv(opts.env);
    const peak = opts.gain ?? 0.2;
    const stop = t0 + opts.duration + env.release + 0.01;
    if (!this.claimVoice(t0, stop)) return;

    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.setValueAtTime(Math.max(1, opts.freq), t0);
    if (opts.slideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(1, opts.slideTo),
        t0 + (opts.slideTime ?? opts.duration),
      );
    }

    const amp = ctx.createGain();
    applyEnvelope(amp.gain, t0, opts.duration, peak, env);
    osc.connect(amp);
    amp.connect(opts.dest ?? this.master);

    const extras: AudioNode[] = [amp];
    let lfo: OscillatorNode | null = null;
    if (opts.vibratoHz && opts.vibratoCents) {
      lfo = ctx.createOscillator();
      lfo.frequency.value = opts.vibratoHz;
      const depth = ctx.createGain();
      const delay = opts.vibratoDelay ?? 0;
      depth.gain.setValueAtTime(delay > 0 ? 0 : opts.vibratoCents, t0);
      if (delay > 0) depth.gain.linearRampToValueAtTime(opts.vibratoCents, t0 + delay);
      lfo.connect(depth);
      depth.connect(osc.detune);
      lfo.start(t0);
      lfo.stop(stop);
      extras.push(depth);
    }

    this.launch(osc, t0, stop, extras, lfo);
  }

  /**
   * Polyphony cap. Counts voices that actually *overlap* the new note rather
   * than everything queued, so scheduling a long stretch ahead of the clock
   * (the lookahead sequencer, or an offline render) is never starved.
   */
  private claimVoice(start: number, stop: number): boolean {
    if (this.disposed) return false;
    const cutoff = Math.min(start, this.ctx.currentTime);
    let kept = 0;
    let overlapping = 0;
    for (let i = 0; i < this.voiceStops.length; i++) {
      const end = this.voiceStops[i] ?? 0;
      if (end <= cutoff) continue;
      const begin = this.voiceStarts[i] ?? 0;
      this.voiceStarts[kept] = begin;
      this.voiceStops[kept] = end;
      kept++;
      if (begin <= start && end > start) overlapping++;
    }
    this.voiceStarts.length = kept;
    this.voiceStops.length = kept;
    if (overlapping >= MAX_VOICES) return false;
    this.voiceStarts.push(start);
    this.voiceStops.push(stop);
    return true;
  }

  private launch(
    src: AudioScheduledSourceNode,
    start: number,
    stop: number,
    chain: AudioNode[],
    extraSource: AudioScheduledSourceNode | null = null,
  ): void {
    src.onended = () => {
      src.disconnect();
      if (extraSource) extraSource.disconnect();
      for (const node of chain) node.disconnect();
    };
    src.start(start);
    src.stop(stop);
  }
}

/**
 * Linear ADSR — the NES envelope unit steps its volume linearly, so ramps here
 * match the hardware's character better than exponential curves would.
 */
export function applyEnvelope(
  param: AudioParam,
  t0: number,
  duration: number,
  peak: number,
  env: Required<Envelope>,
): void {
  const level = Math.max(EPSILON, peak);
  const attack = Math.max(0.001, env.attack);
  const sustain = Math.max(EPSILON, level * env.sustain);
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(level, t0 + attack);
  let cursor = t0 + attack;
  if (env.decay > 0) {
    cursor = Math.min(t0 + duration, cursor + env.decay);
    param.linearRampToValueAtTime(sustain, cursor);
  }
  const holdEnd = Math.max(cursor, t0 + duration);
  param.setValueAtTime(env.decay > 0 ? sustain : level, holdEnd);
  param.linearRampToValueAtTime(0, holdEnd + env.release);
}

/** Equal temperament, A4 = 440 Hz. */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const NOTE_OFFSETS: Record<string, number> = {
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11,
};

/** `"A#3"` -> 233.08. Returns 0 for anything unparseable. */
export function noteToFreq(note: string): number {
  const match = /^([A-G]#?)(-?\d)$/.exec(note);
  if (!match) return 0;
  const step = NOTE_OFFSETS[match[1] ?? ''];
  if (step === undefined) return 0;
  const octave = Number(match[2]);
  return midiToFreq(step + (octave + 1) * 12);
}
