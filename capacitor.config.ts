import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The native shell.
 *
 * `webDir` is the ordinary Vite build: the whole game is one self-contained
 * bundle with no runtime fetches except the room WebSocket, so it embeds
 * directly. That matters for review as well as for loading - App Store
 * guideline 4.7 forbids an app downloading its own executable code, which rules
 * out pointing the shell at the deployed site.
 *
 * `bun run cap:sync` builds the app target - `vite build --mode app`, which
 * reads .env.app for the absolute origin a bundled shell must use - and copies
 * it in. `bun run build` stays the web target Cloudflare deploys.
 */
const config: CapacitorConfig = {
  appId: 'agency.automa.fore',
  appName: 'Fore!',
  webDir: 'dist/client',

  ios: {
    contentInset: 'never',
    // The game's own left-flick means "back". WKWebView's edge swipe means the
    // same thing to the WebView, and the two fight; the game wins.
    allowsLinkPreview: false,
    scrollEnabled: false,
  },

  // No `android` block on purpose. Capacitor defaults
  // webContentsDebuggingEnabled to the build's own debuggable flag
  // (CapConfig.java), which is exactly right: chrome://inspect works on the
  // debug APK CI produces for phone testing, and is off in release.

  server: {
    // Custom scheme rather than http://localhost, so storage and the secure
    // context behave consistently between the two platforms.
    androidScheme: 'https',
  },
};

export default config;
