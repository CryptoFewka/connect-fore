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
 * Build a bundle for the app with the server it should talk to:
 *
 *   VITE_API_ORIGIN=https://fore.automa.agency bun run build && bunx cap sync
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

  android: {
    // Pixel art, so never smooth-scale the WebView surface.
    webContentsDebuggingEnabled: false,
  },

  server: {
    // Custom scheme rather than http://localhost, so storage and the secure
    // context behave consistently between the two platforms.
    androidScheme: 'https',
  },
};

export default config;
