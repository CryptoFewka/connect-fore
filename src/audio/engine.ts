/**
 * `createAudio()` — the only thing the game imports from this folder.
 *
 * The AudioContext is created lazily inside `unlock()` (browsers refuse to start
 * one outside a user gesture, and constructing it early just logs warnings), and
 * every entry point is defensive: if Web Audio is missing or the context refuses
 * to start, the engine quietly degrades to a no-op so the game still runs.
 */
import type { AudioEngine, MusicTrack, SfxName } from './api';
import { Apu } from './apu';
import { MusicPlayer } from './music';
import { SfxBank } from './sfx';
import type { AudioSettings } from './settings';
import { clampVolume, loadSettings, saveSettings } from './settings';

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** Seconds spent ramping the master gain, so mute/volume never clicks. */
const GAIN_RAMP = 0.05;

class WebAudioEngine implements AudioEngine {
  private settings: AudioSettings = loadSettings();
  private ctx: AudioContext | null = null;
  private apu: Apu | null = null;
  private player: MusicPlayer | null = null;
  private bank: SfxBank | null = null;
  private wanted: MusicTrack | null = null;
  private disposed = false;
  private readonly onStateChange = (): void => {
    if (this.ctx?.state === 'running') this.applyMusic();
  };

  async unlock(): Promise<void> {
    if (this.disposed) return;
    const ctx = this.ensure();
    if (!ctx) return;
    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch {
      // Autoplay policy said no; the next gesture gets another chance.
      return;
    }
    this.apu?.warm();
    this.applyMusic();
  }

  ready(): boolean {
    return !this.disposed && this.ctx?.state === 'running';
  }

  sfx(name: SfxName): void {
    if (!this.ready() || this.settings.muted) return;
    const apu = this.apu;
    const bank = this.bank;
    if (!apu || !bank) return;
    try {
      bank.play(name, apu.master);
    } catch {
      // A single bad note must never take the frame down.
    }
  }

  music(track: MusicTrack | null): void {
    if (this.disposed) return;
    this.wanted = track;
    this.applyMusic();
  }

  setMuted(muted: boolean): void {
    this.settings = { ...this.settings, muted };
    saveSettings(this.settings);
    this.applyGain();
    if (muted) this.bank?.reset();
  }

  isMuted(): boolean {
    return this.settings.muted;
  }

  setVolume(volume: number): void {
    this.settings = { ...this.settings, volume: clampVolume(volume) };
    saveSettings(this.settings);
    this.applyGain();
  }

  getVolume(): number {
    return this.settings.volume;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wanted = null;
    this.player?.dispose();
    this.apu?.dispose();
    const ctx = this.ctx;
    this.player = null;
    this.apu = null;
    this.bank = null;
    this.ctx = null;
    if (!ctx) return;
    try {
      ctx.removeEventListener('statechange', this.onStateChange);
      void ctx.close();
    } catch {
      // Already closed.
    }
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) return null;
    try {
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const apu = new Apu(ctx);
      this.ctx = ctx;
      this.apu = apu;
      this.bank = new SfxBank(apu);
      this.player = new MusicPlayer(apu, apu.master);
      ctx.addEventListener('statechange', this.onStateChange);
      this.applyGain();
      return ctx;
    } catch {
      return null;
    }
  }

  /** Mute and volume are the same node, so one ramp covers both. */
  private applyGain(): void {
    const apu = this.apu;
    if (!apu) return;
    const target = this.settings.muted ? 0 : this.settings.volume;
    try {
      const now = apu.now;
      const gain = apu.master.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(target, now + GAIN_RAMP);
    } catch {
      // Closed context.
    }
  }

  private applyMusic(): void {
    const player = this.player;
    if (!player || !this.ready()) return;
    try {
      if (this.wanted === null) player.stop();
      else player.play(this.wanted);
    } catch {
      // Never let the soundtrack break the caller.
    }
  }
}

/** Stand-in used when Web Audio is unavailable; still persists preferences. */
class SilentEngine implements AudioEngine {
  private settings: AudioSettings = loadSettings();

  async unlock(): Promise<void> {
    /* nothing to unlock */
  }

  ready(): boolean {
    return false;
  }

  sfx(): void {
    /* no-op */
  }

  music(): void {
    /* no-op */
  }

  setMuted(muted: boolean): void {
    this.settings = { ...this.settings, muted };
    saveSettings(this.settings);
  }

  isMuted(): boolean {
    return this.settings.muted;
  }

  setVolume(volume: number): void {
    this.settings = { ...this.settings, volume: clampVolume(volume) };
    saveSettings(this.settings);
  }

  getVolume(): number {
    return this.settings.volume;
  }

  dispose(): void {
    /* nothing to dispose */
  }
}

export function createAudio(): AudioEngine {
  try {
    if (!audioContextCtor()) return new SilentEngine();
    return new WebAudioEngine();
  } catch {
    return new SilentEngine();
  }
}
