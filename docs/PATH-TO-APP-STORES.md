# Path to the app stores

Everything the release needs that **does not live in this repo**: accounts, identifiers,
paperwork and submissions. The code side is done in ordinary PRs; this file is the checklist for
the rest, so the two can be tracked together.

Working name: **Fore! — Four in a Row Golf**
Bundle identifier: **`agency.automa.fore`** (valid on both platforms; a bundle id does not have to
begin with `com.`, and this correctly reverses the deep-link domain)
Deep-link domain: **`fore.automa.agency`**

---

## 1. Blocked on nothing — do these first

- [ ] **Request the D-U-N-S number.** Free. Use Apple's own request form rather than going to
      Dun & Bradstreet directly; it is usually faster. **This is the only item that cannot be
      parallelised — both stores queue behind it**, so it sets the whole schedule.
- [ ] Decide the final public name and run it through the free USPTO and EUIPO trademark searches,
      plus a search of both stores for an existing app of that name. "Fore! — Four in a Row Golf"
      is the working name, not a cleared one.
- [x] Create `fore.automa.agency` and point it at the Cloudflare Worker. **Done** - it serves the
      game and `/api/health` answers.

## 2. Apple

- [ ] Apple ID with two-factor authentication enabled (enrolment is refused without it).
- [ ] Enrol in the Apple Developer Program as an **Organization** — $99/year.
      Needs the D-U-N-S, the legal entity name matching the D&B record, a public website, and
      someone legally authorised to bind the entity. **Apple verifies by telephone.**
- [ ] Accept the agreements in App Store Connect. Banking and tax details are *not* needed: a free
      app skips the Paid Applications agreement entirely.
- [ ] Note the **Team ID** from the membership page and paste it into `worker/deep-links.ts`
      (`TEAM_ID`), replacing the placeholder. Universal links do not work until this is real.
- [ ] Create an App Store Connect API key for CI.
- [ ] Register the bundle id `agency.automa.fore` and enable the **Associated Domains** capability.

## 3. Google

- [ ] Register a Play Console account as an **Organization** — $25 once, same D-U-N-S record.
      Registering as an organization is what exempts the account from the **12-testers-for-14-days**
      closed test that new *personal* accounts must serve before they may apply for production
      access, and it publishes the company's address rather than a home address.
- [ ] Generate the upload keystore, back it up somewhere that is not a laptop, and enrol in
      **Play App Signing**.
- [ ] Copy the **SHA-256 certificate fingerprint** from Play Console → Setup → App integrity into
      `worker/deep-links.ts` (`ANDROID_SHA`). Note this is *Google's* signing key under Play App
      Signing, not your local upload key — using the upload key is the usual reason app links
      silently fail to verify.

## 4. Native projects

**Android is generated, committed and built by CI.** `android/` is in the repo, and the
`workflow_dispatch`-only **Android APK** workflow produces a debug-signed `app-debug.apk` you can
sideload. Rebuild locally with `bun run cap:sync`.

**iOS is not**, and cannot be: `cap add ios` needs CocoaPods and macOS. Generate and commit it from
the Mac when one is available.

- [x] Android project generated and committed, with the Capacitor 8 pins left alone
      (Gradle 8.14.3, AGP 8.13.0, minSdk 24, compile/target SDK 36 - which is why CI uses JDK 21).
- [x] Android: **portrait** locked in `AndroidManifest.xml`.
- [x] Android: app-link intent filter for `fore.automa.agency`. It claims the bare host rather than
      a path prefix, because the room code travels in the *fragment*
      (`https://fore.automa.agency/#/r/ABCDE`) and an Android intent filter cannot match one.
- [x] Android: CI job producing an APK (`.github/workflows/android.yml`).
- [ ] **A stable test keystore.** Every CI run generates a fresh debug key, so `autoVerify` can
      never succeed on a test build and a tester has to enable *Open by default* by hand. Fixing it
      means putting a keystore in repository secrets and listing its fingerprint as a second entry
      in `sha256_cert_fingerprints`. Not needed to test gameplay; needed to test *links*.
- [ ] Release signing and an `.aab` for Play - blocked on §3.
- [ ] Replace the stock Capacitor launcher icon and splash with real artwork (see §5).
- [ ] iOS: `bunx cap add ios` on a Mac, then commit.
- [ ] iOS: portrait in `Info.plist`.
- [ ] iOS: disable `allowsBackForwardNavigationGestures` on the WKWebView - the system edge-swipe
      collides head-on with the game's own left-flick "back" gesture.
- [ ] iOS: add the Associated Domains entitlement `applinks:fore.automa.agency`.

## 5. Store assets

- [ ] App icon: 1024×1024 (iOS), 512×512 plus an adaptive icon (Android).
- [ ] Screenshots: required iPhone sizes, plus phone and tablet for Play. The in-repo Playwright
      harnesses already drive the game to good framing and can capture these.
- [ ] Play feature graphic, 1024×500.
- [ ] Short and long descriptions. **Describe the game as "four in a row" and never use the
      trademark**, including in keywords — see §7.
- [ ] Privacy policy, published at a stable URL. There are no accounts and no analytics, but online
      play does send a display name and a room code to the Worker, so say so plainly.

## 6. Paperwork

- [ ] iOS: age rating questionnaire, App Privacy answers, and a `PrivacyInfo.xcprivacy` manifest —
      mandatory, and required here because Capacitor touches `UserDefaults`, a "required reason" API.
- [ ] Android: content rating questionnaire and the Data Safety form.
- [ ] Both: confirm the trader/business details the EU Digital Services Act requires.

## 7. Legal watch-outs

- **The name.** "Connect Four" is a Hasbro trademark and the blue board with red and yellow discs
  is their trade dress. Both have been removed from this repo — the board is now slate with bone
  and violet discs. Keep the trademark out of the store listing, the keywords and the screenshots.
- **The old name is also taken.** "Connect Fore!" is in live commercial use by
  [Putter Mayhem](https://puttermayhem.co.uk/garden-games/connect-fore-putting-golf-game/) for a
  physical putting game, and was used by an
  [Arduino project](https://blog.arduino.cc/2021/04/27/playing-connect-four-against-a-mini-golfing-ai-opponent/)
  of the same concept. That is a second party with an interest, independent of Hasbro.
- **The mechanic is not the risk.** Hasbro sell *Connect 4 Shots* — you launch balls into the grid
  — so the concept is plainly not exclusive. Names and trade dress are what get enforced.
- None of this is legal advice. For a commercial release it is worth an hour of a solicitor's time.

## 8. Submission

- [ ] TestFlight build installed on real hardware.
- [ ] Play internal-testing build installed on real hardware.
- [ ] On device, confirm the four things that cannot be proven in CI: the offline modes (tutorial,
      driving range, 1P, 2P hot-seat) running with sound; a bundled build joining a live room
      against `https://fore.automa.agency`; a challenge link opening the app; and Back mid-match
      raising the quit prompt rather than killing the app. The last one is the predictive-back
      check - `@capacitor/app` goes through `OnBackPressedDispatcher`, which should survive
      `targetSdk 36`, but only a device proves it.
      All four can be checked on the debug APK from the Android APK workflow, well before any
      store account exists.
- [ ] Submit for review. Apple typically turns round in 24–48 hours; Google takes days to about a
      week on a first submission.

---

## Costs

| Item | Cost |
|---|---|
| Apple Developer Program | $99 / year |
| Google Play Console | $25 once |
| Domain (already owned) | — |
| Cloudflare | $0–5 / month |
| **Year one** | **~$124–190**, excluding a Mac |

A Mac is required for iOS: Xcode is macOS-only. Failing one, GitHub Actions macOS runners or a
hosted Mac at roughly $50–100/month.

## Notes on decisions already taken

- **Everything is renamed except the Cloudflare Worker, which keeps the name `connect-fore`.** Renaming it deploys a *new* Worker at a
  new URL, orphaning the old one and breaking both the Cloudflare Builds connection and every
  challenge link already shared. Infrastructure identity is not branding.
- **The Android SDK and Gradle versions are Capacitor's, not ours.** `variables.gradle` and the
  wrapper come from the Capacitor 8 template and are what Capacitor tests against. Bumping AGP or
  the wrapper independently is how a Capacitor project breaks; let a Capacitor upgrade move them.
- **Apple's "repackaged website" rule (guideline 4.2)** is the main review risk for any WebView
  app. The defence here is unusually strong and should be stated in the review notes: the game
  ships no assets at all — geometry, textures, the bitmap font, every sound and all three music
  tracks are generated in code — so the tutorial, driving range and both local modes work fully
  offline. Haptics and the native share sheet are wired in as further native integration.
