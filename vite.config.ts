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
    plugins: [
      // App builds emit a tiny manifest naming the server they were pointed at.
      //
      // The alternative - grepping the bundle for the origin - is not stable:
      // whether the substituted value comes out as "https://..." or
      // `https://...` is up to whichever minifier the current Vite ships, and
      // the roomSocketUrl error message mentions the origin in both targets
      // anyway. This is an explicit statement instead, it travels into the APK
      // with the rest of dist/client, and it is emitted only for `--mode app`,
      // so the deployed website is byte-for-byte what it was.
      mode === 'app' && {
        name: 'fore:build-target',
        generateBundle(): void {
          this.emitFile({
            type: 'asset',
            fileName: 'build-target.json',
            source: `${JSON.stringify({ target: 'app', apiOrigin: env.VITE_API_ORIGIN }, null, 2)}\n`,
          });
        },
      },
    ],

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
