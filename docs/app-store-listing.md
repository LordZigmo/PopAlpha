# PopAlpha iOS — App Store Connect Listing

Drafts for every App Store Connect text field for the v1.0.0 submission. Paste sections directly; tweak anywhere they don't match the final brand voice. Character counts are noted — Apple enforces them.

> **Quick note on the v1 scope**: UGC surfaces (Feed tab, comments, follows, public profiles) are gated off behind `FeatureFlags.isSocialEnabled = false`. The privacy labels and age rating below assume that v1 ships *without* user-visible UGC. If you flip the flag back on before submission, age rating becomes 12+ and "User Content" needs to be added to the privacy labels.

---

## 1. App Information

| Field | Value | Char count |
|---|---|---|
| **App Name** | `PopAlpha` | 8 / 30 |
| **Subtitle** | `Pokémon card prices & scanner` | 30 / 30 |
| **Bundle ID** | `ai.popalpha.ios` | — |
| **SKU** | `popalpha-ios-v1` (any unique string) | — |
| **Primary Language** | English (U.S.) | — |
| **Primary Category** | Shopping (matches `INFOPLIST_KEY_LSApplicationCategoryType = "public.app-category.shopping"`) | — |
| **Secondary Category** | Reference *or* Finance — pick whichever matches your positioning best. Reference reads more honest; Finance is more discoverable but invites scrutiny. | — |
| **Content Rights** | See §9 — Pokémon trademark answer | — |

**Subtitle alternatives if "Pokémon" can't be used in metadata** (Apple sometimes flags trademarked franchise names):
- `Card prices, signals & scanner` (32 — over)
- `Card market data & scanner` (26)
- `Trading card prices & scanner` (29)

---

## 2. Description

**Above the fold (first 3 lines visible without "more" tap)**:

```
PopAlpha is the market-data app for trading-card collectors.
Scan a card with your camera, see live prices and historical
trends, and track what your collection is worth — all in one place.
```

**Full description** (under 4000 chars):

```
PopAlpha is the market-data app for trading-card collectors.
Scan a card with your camera, see live prices and historical
trends, and track what your collection is worth — all in one place.

WHAT YOU GET WITH POPALPHA

• Camera scanner — point at any English Pokémon card; PopAlpha
  identifies it and pulls up the latest prices in seconds.

• Live market prices — aggregated from public sources and
  refreshed throughout the day. Raw and graded prices, with
  variant breakdowns where available.

• Price history charts — see how a card has moved over the last
  week, month, year, or its full history. Switch between raw and
  graded conditions to compare.

• Daily AI brief — a short summary of what's moving in the
  market each morning, written for collectors who don't have
  time to read fifty Twitter threads.

• Portfolio tracking — log what you own, what you paid, and
  watch your collection's value change with the market.

• Wishlist — save the cards you're hunting and see when they
  drop in price.

• Set browsing — drill into any set and see every card with its
  current price, completion percentage, and movers.

FREE TO START
Browse prices, chart history, scan a few cards a day, and track
a small portfolio without an account. Sign up to save more, sync
across devices, and get the full daily AI brief.

POPALPHA PRO
Unlock the offline scanner — instant on-device card identification
that works in patchy connectivity (e.g. card shows, the back of a
binder pile at home). Pro is available as a monthly or annual
subscription; cancel anytime in iOS Settings.

PRIVACY
We don't track you across other apps or websites. We don't sell
your data. The only things we collect are what's necessary to
run the app — your account info, what you save, and anonymized
usage signals to fix bugs. Full details in our privacy policy.

PopAlpha is an informational tool, not a financial advisor.
Card prices are aggregated estimates that may not reflect what
you'll pay or receive in any specific transaction. Always do
your own research.
```

---

## 3. Keywords

100 char total budget; comma-separated, **no spaces after commas** (Apple counts spaces against the budget).

**Recommended set** (~95 chars):

```
pokemon,card,prices,scanner,collector,tcg,trading,pricing,portfolio,charts,market,wishlist,values
```

**Notes**:
- Don't repeat words from the App Name / Subtitle — Apple already indexes those.
- Don't include competitor app names (gradedex, tcgplayer, cardvault, etc.) — Apple actively rejects this.
- "pokemon" in keywords is allowed as long as you have the rights to identify the franchise (see Content Rights §9). Apple has rejected "pokemon" in the *App Name* before but generally allows it in keywords for legitimate apps.

---

## 4. Promotional Text

≤170 chars, can be updated without resubmission. Use for limited-time messaging post-launch.

```
Scan any Pokémon card with your camera and see live prices, full history charts, and what your collection's worth — instantly.
```

(127 chars — leaves room.)

---

## 5. What's New in This Version

For v1.0.0 — first submission. Apple's hint: keep it short and meaningful.

```
Welcome to PopAlpha! Scan cards with your camera, track prices
and portfolio value, and get the daily AI market brief — all
free to start.
```

---

## 6. URLs

| Field | URL | Notes |
|---|---|---|
| **Support URL** | `https://popalpha.ai/support` | Required. Make sure it resolves before submitting. |
| **Marketing URL** | `https://popalpha.ai` | Optional but recommended. |
| **Privacy Policy** | `https://popalpha.ai/privacy` | Required. Already live. |
| **Terms of Service** | `https://popalpha.ai/terms` | Live; linked from in-app Settings. |

**If `popalpha.ai/support` doesn't exist yet, use** `mailto:contact@popalpha.app` or set the URL to `popalpha.ai/contact`.

---

## 7. Age Rating

Apple's wizard, with the v1 (UGC-hidden) answers:

| Question | Answer | Notes |
|---|---|---|
| Cartoon or Fantasy Violence | None | — |
| Realistic Violence | None | — |
| Sexual Content / Nudity | None | — |
| Profanity / Crude Humor | None | — |
| Alcohol / Tobacco / Drug Use | None | — |
| Mature / Suggestive Themes | None | — |
| Horror / Fear Themes | None | — |
| Prolonged Graphic Violence | None | — |
| Gambling | None | Trading cards aren't gambling. |
| Contests | None | — |
| **Unrestricted Web Access** | **No** | We don't load arbitrary web pages. Universal links only. |
| **User-Generated Content** | **No** | UGC is flag-gated off in v1. **If you flip the flag back on, change this to Yes — and rating becomes 12+.** |
| Medical / Treatment Info | No | — |

**Resulting rating: 4+**

---

## 8. App Privacy (Nutrition Labels)

Mirrors `ios/PopAlphaApp/PrivacyInfo.xcprivacy`, scoped to v1's UGC-hidden state. Apple flags mismatches between this and the manifest.

### Data Used to Track You
**None.** (`NSPrivacyTracking = false` in the manifest.)

### Data Linked to You
For each below: **Linked to identity = Yes**.

| Data Type | Purposes | Why |
|---|---|---|
| **Email Address** | App Functionality | Clerk auth |
| **Name** | App Functionality | Profile display name |
| **User ID** | App Functionality, Analytics | Clerk user_id, our internal handle |
| **Photos or Videos** | App Functionality | Camera scanner uploads card image to identify |
| **Product Interaction** | Analytics, Personalization | Tap events, card views, scans |
| **Search History** | App Functionality, Personalization | Card search queries |
| **Other Diagnostic Data** | App Functionality | Token rotation diagnostics |

### Data Not Linked to You
| Data Type | Purposes | Why |
|---|---|---|
| **Crash Data** | App Functionality | PLCrashReporter |
| **Performance Data** | App Functionality | PostHog session perf |

### NOT collecting in v1
- **User Content** (comments, posts, profile bios) — UGC is flag-gated off. Add this category back if you flip `FeatureFlags.isSocialEnabled = true` before submission.
- **Location** — none.
- **Contacts** — none.
- **Browsing History** — none.
- **Health & Fitness, Financial Info, Sensitive Info** — none.

### Third-party SDKs to disclose
| SDK | What it sees | Mitigation |
|---|---|---|
| **Clerk** (`ClerkKit`) | Email, name, user_id during auth flow | OAuth provider; required for sign-in |
| **PostHog** | Anonymous analytics events | We do not enable cross-app tracking |
| **PLCrashReporter** | Stack traces only | No PII in payload |
| **Nuke** | Image cache (client-side, no telemetry) | No data leaves device |
| **PhoneNumberKit** | Local-only number formatting | No network |

---

## 9. Content Rights — Pokémon Trademark Answer

> ⚠️ **Run this past whoever owns legal risk before submitting.** This is the highest-risk question Apple asks. Apple won't adjudicate IP claims itself, but a takedown notice from The Pokémon Company / TPCi will pull the app from the store immediately.

**Question**: Does your app contain, show, or access third-party content?

**Recommended answer**: **Yes**, with this disclosure:

```
PopAlpha is a market-data and price-tracking application for the
collectible-card hobby. The app references and displays trading-card
imagery and metadata sourced from public catalogs and licensed data
providers. Card names, set names, and artwork are owned by their
respective rights holders (including The Pokémon Company
International, Wizards of the Coast, etc.). PopAlpha makes nominative
fair use of these names and images to identify the cards being priced
and discussed — analogous to a financial-news app referencing the
ticker symbol and brand name of a company it covers.

We respond to takedown notices at contact@popalpha.app within 24
hours of receipt.
```

**Things NOT to do**:
- Don't put "official Pokémon" or anything implying endorsement in the description.
- Don't use The Pokémon Company logo in screenshots, app icon, or anywhere visible.
- Don't claim partnership unless you actually have one.
- Don't use card-name slang that's trademark-adjacent ("Charizard ex" is fine; "PokéTracker" is not).

---

## 10. App Review Information

App Store Connect splits this across two fields. Paste each into the matching one:

**Sign-In Information** (separate, secure field — Apple stores this with the build):
```
Username:  review.popalpha@proton.me
Password:  [TODO: paste mailbox password]
```
*The username is the inbox the reviewer signs into to fetch the verification code. The password is the **Proton Mail mailbox password**, not a PopAlpha password (PopAlpha doesn't have one — sign-in is passwordless email-code via Clerk).*

**Notes / Review Information** (freeform field — visible to the reviewer alongside the build):

```
PopAlpha is a market-data and portfolio app for trading-card
collectors. Most of the app is browsable without an account; the
demo creds above unlock the signed-in surface (portfolio + wishlist).

— HOW TO SIGN IN (passwordless email code):
   1. On any sign-in CTA in the app, tap "Continue with Email".
   2. Enter the username from the Sign-In Information field above
      (review.popalpha@proton.me).
   3. Tap "Send Code".
   4. Open Safari → mail.proton.me → sign in with the same
      credentials from the Sign-In Information field. There will be
      a Clerk verification email titled "Your sign-in code" with a
      6-digit number.
   5. Switch back to PopAlpha; type or paste the 6-digit code. The
      app auto-submits at 6 digits.
   The demo account is pre-seeded with a sample holding + a wishlist
   item so the signed-in experience renders meaningfully on first
   sign-in.

— TO TEST THE PAYWALL: tap the Scan tab, run a few scans to hit
   the free quota, and the paywall sheet will appear. The
   subscription is "Pro Monthly" or "Pro Yearly" — both unlock the
   on-device offline scanner. Restore Purchases works from the
   paywall and from Settings.

— TO TEST ACCOUNT DELETION: Settings → Delete My Account →
   Confirm. The account is removed from our auth provider (Clerk)
   AND all data is purged from our database. Re-trying sign-in
   with the same email will fail.

— OFFLINE BEHAVIOR: every screen shows a top "You're offline"
   banner when network drops, and each fetch path has a Retry
   button (e.g. on the card-detail price chart). Try toggling
   airplane mode to see this.

— PUSH NOTIFICATIONS: after sign-in, an in-app sheet explains
   what notifications we send before the system permission
   prompt fires. Tap "Not Now" to dismiss without burning the
   one-shot system prompt. Tap "Enable Notifications" to grant.

— CAMERA: triggered when you tap the Scan tab. We use the
   camera ONLY to identify cards — frames are uploaded to our
   server for visual matching, the result is the matched card,
   and we don't retain the user image beyond the matching
   pipeline.

— PHOTO LIBRARY: NOT requested. Reviewers will not see a photo-
   library permission prompt anywhere in v1.

— LOCATION: NOT requested.

— UGC: Comments, public profiles, and following other users are
   currently disabled in v1 (no in-app discovery surface yet).
   Will be re-enabled in a future version with full moderation
   tools (Report, Block, server-side filtering, 24h SLA).
   See https://popalpha.ai/community-guidelines.

Contact for review questions:
   Name:  [TODO: your name]
   Email: contact@popalpha.app
   Phone: [TODO: your phone]
```

**Pre-submission checklist for the demo account itself**:
- [ ] Proton Mail 2FA disabled (otherwise the reviewer can't fetch the code)
- [ ] Once signed in to PopAlpha with this account, seeded a holding + wishlist item
- [ ] Verified the Clerk verification email actually arrives at this inbox (Clerk Dashboard → Logs → Emails to confirm delivery, or just send a test code via the iOS UI)
- [ ] Confirmed Phone identifier is OFF in Clerk Dashboard so sign-up doesn't loop on a phone prompt for the reviewer
- [ ] Confirmed Password strategy is OFF in Clerk Dashboard (otherwise the signup completes with status .missingRequirements and the reviewer sees "needs another step" error)

---

## 11. In-App Purchase Descriptions

For each subscription. Apple requires per-IAP review notes + a screenshot of the IAP screen. Both products are in subscription group "Pro" — upgrades/downgrades between them happen on the same group.

### `ai.popalpha.premium.pro.monthly`

| Field | Value |
|---|---|
| **Reference Name** | `Pro Monthly` |
| **Display Name** | `PopAlpha Pro` |
| **Subscription Duration** | 1 Month |
| **Description** | `Unlock instant on-device card scanning that works without a network connection. Pro Monthly is an auto-renewing subscription billed monthly. Cancel anytime in iOS Settings.` |
| **Review Notes** | `Pro unlocks the on-device offline scanner. Triggered by tapping the Scan tab and running scans past the free quota. To test, use the demo account credentials and run scans until the paywall appears.` |

### `ai.popalpha.premium.pro.yearly`

| Field | Value |
|---|---|
| **Reference Name** | `Pro Yearly` |
| **Display Name** | `PopAlpha Pro (Yearly)` |
| **Subscription Duration** | 1 Year |
| **Description** | `Unlock instant on-device card scanning that works without a network connection. Pro Yearly is an auto-renewing subscription billed annually at a discount vs. monthly. Cancel anytime in iOS Settings.` |
| **Review Notes** | `Same entitlement as Pro Monthly with annual billing. Defaults to ~16% savings vs 12 × monthly. Subscription group "Pro".` |

### Subscription group localization (one entry, English)

| Field | Value |
|---|---|
| **Display Name** | `PopAlpha Pro` |
| **App Name** | `PopAlpha` |

---

## 12. Encryption / Export Compliance

| Question | Answer |
|---|---|
| Does your app use encryption? | **Yes** (HTTPS / TLS via URLSession) |
| Does your app qualify for any of the [export exemptions](https://www.apple.com/legal/export-control/)? | **Yes** — uses only standard system encryption + HTTPS |
| Does your app meet the criteria of Note 4? | **Yes** (mass-market exemption) |

This matches `ITSAppUsesNonExemptEncryption = false` in `Info.plist` — Apple won't ask the question every build because we've declared the answer in-binary.

---

## 13. Advertising Identifier

| Question | Answer |
|---|---|
| Does this app use the Advertising Identifier (IDFA)? | **No** |

Matches `NSPrivacyTracking = false` in the manifest. We don't request `ATTrackingManager` authorization.

---

## 14. Screenshots Checklist

Apple needs screenshots for:

| Display class | Required for v1? | Resolution | Notes |
|---|---|---|---|
| **6.7" iPhone (iPhone 14 Pro Max class)** | ✅ Required | 1290 × 2796 | Primary screenshot tier — what most reviewers see |
| **6.5" iPhone** | Optional but auto-scaled from 6.7" | — | Apple usually doesn't reject if missing |
| **5.5" iPhone (iPhone 8 Plus)** | Apple is deprecating this; only required if you target older devices | 1242 × 2208 | We support iOS 17+, so probably skip |
| **12.9" iPad Pro** | Required IF the app declares iPad support | 2048 × 2732 | We currently target iPhone + iPad (`TARGETED_DEVICE_FAMILY = "1,2"`). **Decide: take iPad screenshots OR drop iPad to skip the work.** |

**Suggested screenshot lineup** (5–7 screens telling the story top-to-bottom):
1. **Hero** — Scanner identifying a card mid-scan with the matched card sliding up
2. **Card detail** — chart + price tile + condition tabs (light mode preferred since UI just got light/dark — show off the new mode!)
3. **Daily AI brief** — Marketplace home with the AI summary card
4. **Portfolio** — value chart + holdings list
5. **Set browse** — set page with movers + completion %
6. **Wishlist** — alert badges
7. *(optional)* **Pro paywall** — clean show of the offline scanner pitch

**Caption guidance** (Apple allows captions overlaid on screenshots; the captions are NOT translated and aren't searchable, but they massively improve conversion):

| Slot | Caption |
|---|---|
| 1 | `Scan any card. Get the price.` |
| 2 | `Live market data & history` |
| 3 | `Daily AI market brief` |
| 4 | `Track what your collection's worth` |
| 5 | `Drill into any set` |
| 6 | `Get notified when wishlist cards drop` |
| 7 | `Pro: instant offline scanning` |

---

## 15. Submission Checklist

Run through this before tapping **Submit for Review**:

- [ ] Bundle version `MARKETING_VERSION = 1.0.0`, `CURRENT_PROJECT_VERSION = 1` (already set)
- [ ] Demo account credentials seeded + pasted into App Review Information
- [ ] Privacy nutrition labels filled out (§8)
- [ ] Age rating wizard completed → 4+ (§7)
- [ ] Content rights answer entered (§9)
- [ ] All screenshots uploaded for declared device classes (§14)
- [ ] Both IAP products created in App Store Connect with descriptions + review notes (§11)
- [ ] Subscription group "Pro" exists and contains both products
- [ ] Pricing tier selected for both IAPs (Tier 1 = $0.99 monthly, etc. — consult product on price)
- [ ] Support URL resolves to a contact path
- [ ] TestFlight internal build run for 24-48h with no crash spikes
- [ ] Xcode → Product → Archive → Validate App passes all checks
- [ ] Final on-device sanity pass:
  - [ ] Cold launch with no account works
  - [ ] Sign-in flow → soft-prompt push sheet → system permission
  - [ ] Camera prompt fires only on first scan; deny path shows graceful Settings deep-link
  - [ ] Airplane-mode → offline banner visible, retry buttons work
  - [ ] Light + dark mode both readable end-to-end
  - [ ] Account deletion → can't sign back in afterwards

---

## 16. Things that would defer or block submission

| Item | Status |
|---|---|
| `NSPhotoLibraryUsageDescription` removed from `Info.plist` (release builds don't trigger photo prompt) | ✅ Done (commit `11cd43d`) |
| `INFOPLIST_KEY_UIUserInterfaceStyle = Dark` removed (light + dark supported) | ✅ Done (commit `b61e127`) |
| Account deletion endpoint actually wired up | ✅ Done (commit `eb19cc7`) |
| Soft pre-prompt before push permission | ✅ Done (commit `617a59a`) |
| Global offline banner for airplane-mode test | ✅ Done (commit `3bb206f`) |
| CardDetailView chart error retry | ✅ Done (commit `969ce6a`) |
| UGC moderation built but hidden behind flag | ✅ Done (commit `f1f23be`) |
| Demo account created + seeded | ⏳ **You** |
| ASC privacy labels filled | ⏳ **You** |
| Screenshots taken in light mode | ⏳ **You** |
| Pokémon trademark Content Rights answer reviewed by counsel | ⏳ **You** |
| Support URL `popalpha.ai/support` exists | ⏳ **Verify** |
| iPad layout audit OR drop iPad support | ⏳ **Decide** |

---

*Generated 2026-05-07 alongside the App Review readiness work for v1.0.0.*
