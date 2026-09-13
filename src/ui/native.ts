/**
 * The thin seam between the game and a native shell.
 *
 * Everything here is a no-op on the web, so the browser build behaves exactly
 * as it always has and nothing below needs a `if (mobile)` at the call site.
 * The plugins are imported statically because Capacitor's web implementations
 * are themselves no-ops - it is the *platform check* that decides, not the
 * import.
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Share } from '@capacitor/share';

export type HapticWeight = 'light' | 'medium' | 'heavy';

export interface NativeBridge {
  /** True inside an app shell, false in a browser. */
  readonly isNative: boolean;
  /** A universal link or app link the shell was opened with. */
  onDeepLink(handler: (url: string) => void): Promise<void>;
  /** Android's hardware Back. Without this the default is to quit the app. */
  onBackButton(handler: () => void): Promise<void>;
  /** Foreground/background transitions, which the DOM's visibilitychange misses in a WebView. */
  onAppStateChange(handler: (active: boolean) => void): Promise<void>;
  /** A physical tap. Silently ignored where there is no Taptic engine. */
  haptic(weight: HapticWeight): void;
  /**
   * The system share sheet, or the clipboard on the web.
   * Resolves true when the link left the app one way or another.
   */
  shareLink(url: string, title: string): Promise<boolean>;
}

const IMPACT: Record<HapticWeight, ImpactStyle> = {
  light: ImpactStyle.Light,
  medium: ImpactStyle.Medium,
  heavy: ImpactStyle.Heavy,
};

function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function createNativeBridge(): NativeBridge {
  const native = isNativePlatform();

  return {
    isNative: native,

    async onDeepLink(handler): Promise<void> {
      if (!native) return;
      try {
        await App.addListener('appUrlOpen', (event) => handler(event.url));
      } catch {
        /* older shell without the plugin; links simply do not deep-link */
      }
    },

    async onBackButton(handler): Promise<void> {
      if (!native) return;
      try {
        await App.addListener('backButton', () => handler());
      } catch {
        /* nothing to bind to */
      }
    },

    async onAppStateChange(handler): Promise<void> {
      if (!native) return;
      try {
        await App.addListener('appStateChange', ({ isActive }) => handler(isActive));
      } catch {
        /* nothing to bind to */
      }
    },

    haptic(weight): void {
      if (!native) return;
      void Haptics.impact({ style: IMPACT[weight] }).catch(() => {
        /* no haptic hardware */
      });
    },

    async shareLink(url, title): Promise<boolean> {
      if (native) {
        try {
          await Share.share({ title, text: title, url });
          return true;
        } catch {
          return false;
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        return true;
      } catch {
        return false;
      }
    },
  };
}
