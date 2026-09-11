/**
 * Where the game's server lives.
 *
 * On the web that is simply wherever the page came from. Inside a native shell
 * it cannot be: the page is served from `capacitor://localhost` (iOS) or
 * `http://localhost` (Android), and neither has a room endpoint behind it. So a
 * bundled build is given the real origin at build time, and the web build
 * carries on deriving it from the page exactly as before.
 *
 *   VITE_API_ORIGIN=https://fore.automa.agency bun run build
 */

/** The public origin of the deployed Worker, or the page's own. */
export function apiOrigin(): string | undefined {
  const configured = import.meta.env?.VITE_API_ORIGIN;
  if (typeof configured === 'string' && configured.length > 0) {
    return configured.replace(/\/+$/, '');
  }
  // Undefined rather than `location.origin`: the net client already falls back
  // to the page origin, and in a non-browser context (tests) there is no page.
  return undefined;
}

/** True when the build was pointed at a server other than its own origin. */
export function hasConfiguredOrigin(): boolean {
  return apiOrigin() !== undefined;
}

/**
 * The origin a shareable challenge link should be built against. A link minted
 * inside the app must point at the public web address, never `capacitor://`.
 */
export function shareOrigin(): string {
  return apiOrigin() ?? (typeof location === 'undefined' ? '' : location.origin);
}
