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
- [ ] Create `fore.automa.agency` and point it at the Cloudflare Worker.

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

## 4. Generate the native projects

These cannot be produced in CI on Linux — `cap add ios` needs CocoaPods and macOS — so they are
generated on the developer machine and committed from there.

```sh
bun install
VITE_API_ORIGIN=https://fore.automa.agency bun run build
bunx cap add ios         # macOS only
bunx cap add android
bunx cap sync
```

- [ ] Generate both projects and commit them.
- [ ] Set **portrait** orientation in `Info.plist` and `AndroidManifest.xml`.
- [ ] iOS: disable `allowsBackForwardNavigationGestures` on the WKWebView — the system edge-swipe
      collides head-on with the game's own left-flick "back" gesture.
- [ ] iOS: add the Associated Domains entitlement `applinks:fore.automa.agency`.
- [ ] Android: add the app-link intent filter for the same host.

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
- [ ] On device, confirm the three things that cannot be proven in CI: a bundled build joining a
      live room; a challenge link opening the app from Messages; and Back mid-match raising the
      quit prompt rather than killing the app.
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

- **The Cloudflare Worker keeps the name `connect-fore`.** Renaming it deploys a *new* Worker at a
  new URL, orphaning the old one and breaking both the Cloudflare Builds connection and every
  challenge link already shared. Infrastructure identity is not branding.
- **The `connect-fore:` localStorage key namespace also stays**, for the same class of reason:
  renaming it would silently reset every existing player's name, difficulty and volume, and no one
  ever sees the key.
- **Apple's "repackaged website" rule (guideline 4.2)** is the main review risk for any WebView
  app. The defence here is unusually strong and should be stated in the review notes: the game
  ships no assets at all — geometry, textures, the bitmap font, every sound and all three music
  tracks are generated in code — so the tutorial, driving range and both local modes work fully
  offline. Haptics and the native share sheet are wired in as further native integration.
