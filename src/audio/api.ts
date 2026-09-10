/**
 * Contract for the WebAudio NES APU: two pulse channels, a triangle, and noise.
 * Every sound is synthesised at runtime — the game ships no audio files.
 */

export type SfxName =
  | 'menu-move'
  | 'menu-select'
  | 'meter-tick'
  | 'meter-lock'
  | 'swing'
  | 'thread'
  | 'thud'
  | 'clack'
  | 'drop'
  | 'win'
  | 'lose'
  | 'draw'
  | 'join'
  | 'leave';

export type MusicTrack = 'title' | 'play' | 'victory';

export interface AudioEngine {
  /** Must be called from a user gesture; resumes the AudioContext. */
  unlock(): Promise<void>;
  ready(): boolean;
  sfx(name: SfxName): void;
  /** `null` stops music. */
  music(track: MusicTrack | null): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** 0..1, persisted. */
  setVolume(volume: number): void;
  getVolume(): number;
  dispose(): void;
}
