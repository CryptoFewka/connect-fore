/**
 * Mute/volume persistence. `localStorage` can be missing (SSR, workers) or throw
 * outright (Safari private mode, blocked third-party storage), so every access
 * is guarded and failures fall back to the defaults rather than breaking boot.
 */

export const STORAGE_KEY = 'connect-fore:audio';

export interface AudioSettings {
  muted: boolean;
  /** 0..1. */
  volume: number;
}

export const DEFAULT_SETTINGS: AudioSettings = { muted: false, volume: 0.7 };

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.volume;
  return Math.min(1, Math.max(0, value));
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSettings(): AudioSettings {
  const store = storage();
  if (!store) return { ...DEFAULT_SETTINGS };
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
    const record = parsed as Record<string, unknown>;
    return {
      muted: typeof record.muted === 'boolean' ? record.muted : DEFAULT_SETTINGS.muted,
      volume:
        typeof record.volume === 'number'
          ? clampVolume(record.volume)
          : DEFAULT_SETTINGS.volume,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AudioSettings): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota or a blocked origin: the session just runs unpersisted.
  }
}
