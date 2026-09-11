/**
 * Player preferences that outlive a session. Audio owns its own volume/mute
 * keys; this is everything else.
 */

/**
 * Note: the `connect-fore:` key namespace predates the rename and stays put.
 * Renaming it would silently reset every existing player's saved settings for
 * no visible benefit - the key is never shown to anyone.
 */
const KEY = 'connect-fore:settings:v1';

/** Shown until a player picks a handle of their own. */
export const DEFAULT_NAME = 'PLAYER';

export interface Settings {
  name: string;
  difficulty: 'easy' | 'normal' | 'hard';
  /** Remembered so a returning player keeps their handle in online matches. */
  lastRoom: string | null;
}

const DEFAULTS: Settings = {
  name: DEFAULT_NAME,
  difficulty: 'normal',
  lastRoom: null,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name.slice(0, 8).toUpperCase() : DEFAULTS.name,
      difficulty:
        parsed.difficulty === 'easy' || parsed.difficulty === 'hard' || parsed.difficulty === 'normal'
          ? parsed.difficulty
          : DEFAULTS.difficulty,
      lastRoom: typeof parsed.lastRoom === 'string' ? parsed.lastRoom : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or a full quota — preferences simply don't persist.
  }
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
