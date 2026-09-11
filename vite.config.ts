import { defineConfig, loadEnv } from 'vite';

/**
 * Two build targets.
 *
 *   bun run build       web  - no VITE_API_ORIGIN, so the game talks to whatever
 *                             origin served the page. This is what Cloudflare
 *                             Workers Builds runs on push.
 *   bun run build:app   app  - `--mode app` picks up .env.app, baking in the
 *                             absolute origin a bundled app must use.
 *
 * `vite build` is a production build whichever mode it is given; the mode only
 * selects which .env file is read.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  // An app build with no origin resolves to location.origin, which inside a
  // shell is capacitor://localhost - an app that cannot reach the server and
  // says nothing about why. Fail here instead, where the mistake is.
  if (mode === 'app' && !env.VITE_API_ORIGIN) {
    throw new Error(
      'An app build needs VITE_API_ORIGIN. Set it in .env.app, or pass it in the environment.',
    );
  }

  return {
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
      target: 'es2022',
      assetsInlineLimit: 0,
    },
    server: {
      proxy: {
        // `bun run dev` talks to a locally running `wrangler dev` for rooms.
        '/api': { target: 'http://127.0.0.1:8787', ws: true, changeOrigin: true },
      },
    },
  };
});
