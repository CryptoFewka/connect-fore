/**
 * Domain association files, so a challenge link opens the app instead of the
 * browser.
 *
 * Both platforms fetch these from the domain itself, which is why they are
 * served by the Worker rather than shipped inside the app. Neither can be
 * finished until the stores hand over an identifier that does not exist yet:
 *
 *   TEAM_ID      Apple Developer Team ID, visible in the membership details
 *                page once organization enrolment completes.
 *   ANDROID_SHA  SHA-256 fingerprint of the *signing* certificate. With Play
 *                App Signing this is Google's key, from Play Console ->
 *                Setup -> App integrity, not the local upload keystore.
 *
 * Until both are filled in, the files are served with the placeholders intact
 * so the routing can be tested; the links themselves will not associate.
 */

export const BUNDLE_ID = 'agency.automa.fore';

/** TODO: replace once Apple organization enrolment completes. */
const TEAM_ID = 'TEAMID0000';

/** TODO: replace with the Play App Signing certificate fingerprint. */
const ANDROID_SHA = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

/** iOS universal links. Must be served as JSON, with no file extension. */
export function appleAppSiteAssociation(): Response {
  const body = {
    applinks: {
      details: [
        {
          appIDs: [`${TEAM_ID}.${BUNDLE_ID}`],
          // Only challenge links are claimed; the rest of the site stays in the
          // browser, which is what you want for a marketing page.
          components: [{ '/': '/', fragment: '/r/*', comment: 'challenge links' }],
        },
      ],
    },
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    },
  });
}

/** Android app links. */
export function assetLinks(): Response {
  const body = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: BUNDLE_ID,
        sha256_cert_fingerprints: [ANDROID_SHA],
      },
    },
  ];
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    },
  });
}
