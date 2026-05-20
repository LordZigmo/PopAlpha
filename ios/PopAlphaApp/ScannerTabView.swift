import Combine
import SwiftUI
import PopAlphaCore
import OSLog

// MARK: - Scanner Tab
//
// Minimal interface, intentionally. The previous version had a status
// badge, mode pill (single/multi), language pill, photos-picker
// button, eval-seeding button, animated tracking brackets around the
// detected card, and a multi-card scroll tray — all of which got
// stripped 2026-05-04 in favor of a clean viewfinder. The whole
// screen is now the shutter (full-screen tap = capture this frame),
// the only persistent surface is the camera preview, and the only
// transient overlay is an "Identifying…" toast. DEBUG builds add
// two compact corner buttons for the smoke test + premium override.
//
// Multi-scan mode (2026-05-15): a small toggle at the bottom-right of
// the viewfinder enters a continuous batch flow — HIGH/MEDIUM scans
// auto-append to a tray with thumbnail + price, and a single
// bulk-add commits the batch to portfolio. Use case: scanning a pack
// or binder. Single mode (auto-navigate to CardDetailView on HIGH)
// stays the default; the toggle is intentionally tight and out of
// the way so it doesn't compete with the viewfinder when off.

struct ScannerTabView: View {
    @State private var navigateToCard: MarketCard?
    @State private var showPickerSheet = false
    @State private var showPaywallSheet = false
    @State private var showMultiScanSheet = false
    @StateObject private var premiumGate = PremiumGate.shared
    @StateObject private var scanQuota = ScanQuota.shared
    @StateObject private var multiScanSession = MultiScanSession()

    // MARK: - Multi-scan flash overlay state
    //
    // 2026-05-16 redesign: replaced the persistent bottom tray bar
    // with a transient card-flash overlay. On each multi-mode append
    // the most-recent entry's image pops into the lower viewport with
    // its price floating in front; price fades at 1s, card at 1.8s.
    // Tap during the visible window opens the review sheet.
    //
    // `flashEntryId` drives the overlay's presence; `flashPriceVisible`
    // controls the price label's separate fade. `flashTask` owns the
    // staged-fade timer so consecutive scans can cancel the previous
    // schedule without leaving stale fade-out animations running.
    @State private var flashEntryId: UUID?
    @State private var flashPriceVisible: Bool = false
    /// Currently-correcting tray entry. Set when the user taps a row
    /// in the review sheet; drives a nested ScanPickerSheet that lets
    /// them swap the entry's matched card to a different candidate
    /// from the original top-K (or search the catalog for a custom
    /// pick). Cleared on dismiss or successful pick.
    @State private var correctingEntry: CorrectingMultiScanEntry?
    /// When true, the flash card animates toward the bottom-right
    /// toggle (offset + shrink + fade) instead of fading in place.
    /// Gives the user a visual cue that the scan is going INTO the
    /// stack at the toggle's location. Flipped in
    /// `triggerMultiScanFlash` near the end of the flash window.
    @State private var flashFlying: Bool = false
    @State private var flashTask: Task<Void, Never>?

    /// Tracks which scanner surface most recently flipped
    /// `showPaywallSheet`, so the paywall analytics carry the right
    /// `surface` property. Three triggers feed a single sheet — crown
    /// tap, scan quota wall (camera tap when at the limit), and the
    /// quota-approaching warning toast — and we want PostHog funnels
    /// to break them down separately.
    @State private var paywallSurface: String = "scanner_crown"

    // One-shot quota-approaching warning state. Fires once per day
    // when the user completes their 4th scan (remaining == 1), as a
    // soft-friction precursor to the hard wall on scan #5. Cross-
    // launch dedupe lives in ScanQuota (UserDefaults-backed via
    // markWarned / lastWarnedScansToday) so the toast doesn't re-
    // fire every cold launch when the user is sitting at remaining
    // == 1. Local @State here is just the in-flight visibility flag
    // for the slide-in/auto-dismiss animation.
    @State private var quotaWarningVisible = false
    #if DEBUG
    @State private var smokeReport: OfflineScannerSmokeReport?
    @State private var smokeRunning = false
    #endif

    // Package-backed recognition
    @StateObject private var scanner = ScannerHost()

    var body: some View {
        NavigationStack {
            ZStack {
                // Camera preview — fills the entire screen. Falls back
                // to solid black if the camera failed to initialize.
                if let viewModel = scanner.viewModel {
                    ScannerView(viewModel: viewModel)
                        .ignoresSafeArea()
                } else {
                    Color.black.ignoresSafeArea()
                }

                // Camera-startup placeholder. AVCaptureSession HAL
                // takes 1-3s on real device to produce the first
                // sample buffer; without this overlay, the user sees
                // pure black and assumes the app is broken (we
                // measured this as the main UX friction on cold
                // launch). Time Profiler 2026-05-05 confirmed the
                // delay is hardware-bound, not a CPU hang. Fades out
                // when ScannerViewModel.firstFrameRendered flips to
                // true (mirrored via ScannerHost). After the first
                // frame arrives, this view never reappears for the
                // rest of the session — the camera preview keeps its
                // last frame even during pauses.
                if scanner.viewModel != nil, !scanner.firstFrameRendered, scanner.initError == nil {
                    cameraStartingPlaceholder
                        .transition(.opacity)
                }

                // Full-screen tap = capture this frame. The whole
                // viewport IS the shutter. captureFrameAndIdentify
                // implicitly resumes scanning, so this single gesture
                // covers tap-to-restart too. The re-entry guard in
                // runIdentify drops mashed taps as no-ops while a
                // scan is mid-flight or a result is on screen.
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture {
                        PAHaptics.tap()
                        // Drop the tap if a scan is already in flight —
                        // ScannerHost has its own re-entry guard, but
                        // bypassing the quota counter here keeps mashed
                        // taps from over-spending the daily allowance.
                        guard !scanner.isIdentifying else { return }
                        if !premiumGate.isPro {
                            scanQuota.rolloverIfNewDay()
                            if !scanQuota.canScan {
                                paywallSurface = "scanner_quota_wall"
                                showPaywallSheet = true
                                return
                            }
                            scanQuota.recordScan()
                        }
                        Task { await scanner.captureFrameAndIdentify() }
                    }
                    .allowsHitTesting(scanner.initError == nil)

                // Init-error overlay (camera permission denied,
                // hardware failure, etc.). The only visible state
                // when we can't even show a viewfinder.
                if let initError = scanner.initError {
                    initErrorOverlay(message: initError)
                }

                // "Identifying…" toast pinned to the bottom-center
                // above the tab bar. Same toast renders identify
                // errors. Only persistent visual feedback for an
                // in-flight scan.
                if scanner.isIdentifying || scanner.identifyError != nil {
                    VStack {
                        Spacer()
                        identifyStatusToast
                            .padding(.bottom, 140)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                    .animation(.easeInOut(duration: 0.2), value: scanner.isIdentifying)
                    .animation(.easeInOut(duration: 0.2), value: scanner.identifyError)
                }

                // Quota-approaching warning toast. Only shows when
                // scansToday == dailyLimit - 1 (1 left), the user
                // isn't pro, no identify is in flight, and the
                // paywall isn't already open. Sits in the same
                // bottom-center slot as the identify toast — they're
                // mutually exclusive (the identify toast is up
                // during scans; this one fires after a scan settles
                // back to idle).
                if quotaWarningVisible {
                    VStack {
                        Spacer()
                        ScanQuotaWarningToast(
                            remaining: scanQuota.remaining,
                            onTap: handleQuotaWarningTap,
                        )
                        .padding(.horizontal, 24)
                        .padding(.bottom, 140)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                    .animation(.easeInOut(duration: 0.25), value: quotaWarningVisible)
                }

                // Top-right corner buttons. Crown is always visible
                // (taps open the paywall, long-press toggles the DEBUG
                // override). The smoke-test button is DEBUG-only and
                // compile-stripped from release builds.
                VStack {
                    HStack {
                        Spacer()
                        VStack(spacing: 6) {
                            crownButton
                            if !premiumGate.isPro {
                                scanQuotaIndicator
                            }
                            languagePill
                            #if DEBUG
                            offlineSmokeButton
                            #endif
                        }
                        .padding(.top, 60)
                        .padding(.trailing, 16)
                    }
                    Spacer()
                }

                // Bottom-right multi-scan toggle. Pinned 92pt above
                // the absolute viewport bottom so it clears the home
                // indicator AND the iOS 26 liquid-glass tab bar with
                // visual margin. The scanner ZStack uses
                // `.ignoresSafeArea()` so we manually inset here —
                // there's no safeAreaInset doing it for us.
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        multiScanToggle
                            .padding(.trailing, 16)
                    }
                    .padding(.bottom, 92)
                }

                // Multi-scan flash overlay (2026-05-16 redesign).
                // Renders the most-recent appended card's image with
                // its price overlaid — pops in on append, price fades
                // at ~1s, card fades at ~1.8s. Tap → review sheet.
                if scanner.multiScanMode, let flashId = flashEntryId {
                    MultiScanFlashCard(
                        session: multiScanSession,
                        entryId: flashId,
                        priceVisible: flashPriceVisible,
                        flying: flashFlying,
                        onTap: {
                            flashTask?.cancel()
                            withAnimation(.easeOut(duration: 0.2)) {
                                flashEntryId = nil
                                flashFlying = false
                            }
                            showMultiScanSheet = true
                        },
                    )
                    .transition(.scale(scale: 0.85).combined(with: .opacity))
                    .allowsHitTesting(true)
                }
                #if DEBUG
                // Path-source indicator — sticky display of the last
                // scan's routing (offline vs network), winning_path,
                // and confidence. Lets us verify "is this scan hitting
                // the offline catalog or falling through to the server"
                // without tailing logs while testing on-phone.
                // Compile-stripped from release builds.
                lastScanDebugBanner
                #endif
            }
            .ignoresSafeArea()
            .navigationBarHidden(true)
            // Drives the cameraStartingPlaceholder fade-out when the
            // first sample buffer arrives. 0.25s easeOut feels like
            // "the camera just turned on" rather than a UI dissolve.
            .animation(.easeOut(duration: 0.25), value: scanner.firstFrameRendered)
            .navigationDestination(item: $navigateToCard) { card in
                CardDetailView(
                    card: card,
                    scanImageHash: scanner.lastImageHash,
                    scanImage: scanner.lastScanImage,
                )
                    .onDisappear {
                        // Belt: re-arm scanner when CardDetailView
                        // pops. SwiftUI's .navigationDestination(item:)
                        // sometimes misses the .onDisappear hook on
                        // back-swipe / tab-switch round-trips; the
                        // .onChange watcher below is the brace.
                        resetToIdle()
                    }
            }
            // Braces: when SwiftUI's .onDisappear misses, this watcher
            // catches the binding transition from non-nil → nil
            // (which IS the pop event) and re-arms. Both hooks call
            // `resetToIdle` which is idempotent — double-fire is harmless.
            .onChange(of: navigateToCard) { oldValue, newValue in
                if oldValue != nil, newValue == nil {
                    resetToIdle()
                }
            }
            // SwiftUI-level onDismiss fires for ANY dismissal — swipe-
            // down, tap-outside, programmatic. The `onDismiss:` we pass
            // into ScanPickerSheet only fires when the sheet's own X
            // button is tapped. Without this top-level onDismiss, swipe-
            // down dismissals leave `lastMatch` non-nil, and the
            // re-entry guard in `runIdentify` permanently blocks new
            // scans until the app restarts. Real-device 2026-05-04:
            // user dismissed a Snover picker by swipe and was then
            // unable to scan any other card — runIdentify produced 24+
            // "dropped — lastMatch=space-time-smackdown-44-snover"
            // log lines before they gave up. clearLastMatch is
            // idempotent, so the pick path (which already clears
            // lastMatch in handlePickerSelection) double-clears
            // harmlessly.
            .sheet(
                isPresented: $showPickerSheet,
                onDismiss: handlePickerDismiss,
            ) {
                ScanPickerSheet(
                    matches: scanner.lastMatches,
                    imageHash: scanner.lastImageHash,
                    scanImage: scanner.lastScanImage,
                    scanLanguage: scanner.scanLanguage,
                    ocrCardNumber: scanner.lastOCR.cardNumber,
                    ocrSetHint: scanner.lastOCR.setHint,
                    winningPath: scanner.lastWinningPath,
                    onPick: handlePickerSelection,
                    onDismiss: handlePickerDismiss,
                    onCorrectionSubmitted: {
                        // Anchor sync — the just-submitted user_correction
                        // should reach the offline catalog before the
                        // user's next scan. Non-blocking.
                        scanner.syncOfflineAnchorsInBackground()
                    },
                )
            }
            #if DEBUG
            .sheet(isPresented: smokeSheetBinding) {
                if let report = smokeReport {
                    OfflineSmokeReportSheet(report: report)
                }
            }
            #endif
            .sheet(isPresented: $showPaywallSheet) {
                // All three routes that flip showPaywallSheet from this
                // view (crown tap, scan-quota exhaustion, quota-warning
                // banner tap) are scanner-contextual frictions, so the
                // paywall hero copy leads with scanner value. The
                // specific entry point is captured separately in
                // `paywallSurface` for PostHog analytics.
                PaywallView(context: .scanner, surface: paywallSurface)
            }
            .sheet(isPresented: $showMultiScanSheet) {
                MultiScanReviewSheet(
                    session: multiScanSession,
                    onDismiss: { showMultiScanSheet = false },
                    onSubmit: submitMultiScanBatch,
                    onCorrect: { entryId in
                        correctingEntry = CorrectingMultiScanEntry(id: entryId)
                    },
                )
                // Nested correction picker. Reuses the single-mode
                // ScanPickerSheet so the disambiguation UX is
                // consistent across modes. The picker is sheeted off
                // the review sheet (not the scanner) so dismissing it
                // returns to the review list rather than jumping all
                // the way back to the viewfinder.
                .sheet(item: $correctingEntry) { ref in
                    correctionPickerSheet(for: ref.id)
                }
            }
            .onChange(of: scanner.lastMatch) { _, newValue in
                handleIdentifyResult(newValue)
            }
            // Quota-warning trigger: evaluate when a scan settles back
            // to idle (isIdentifying true → false), at which point
            // remaining reflects the just-completed scan and the
            // toast can show without overlapping the identify toast.
            // Day-rollover dedupe is handled inside ScanQuota — its
            // markWarned/lastWarnedScansToday APIs are persisted in
            // UserDefaults and reset by rolloverIfNewDay, so we don't
            // need a manual reset here.
            .onChange(of: scanner.isIdentifying) { _, identifying in
                if !identifying { evaluateQuotaWarning() }
            }
            // Pause Vision detection while the review sheet is open.
            // Otherwise the camera keeps detecting cards behind the
            // modal and the multi-mode branch in handleIdentifyResult
            // keeps appending to the tray — racing both the user's
            // review and submit()'s snapshot/clear cycle. The user is
            // explicitly reviewing or bulk-adding; that's the
            // exclusive activity until the sheet dismisses. (Codex
            // P2 review on PR #83.)
            .onChange(of: showMultiScanSheet) { _, isPresented in
                if isPresented {
                    scanner.viewModel?.pauseForExternalCapture()
                } else if scanner.multiScanMode {
                    scanner.resumeScanning()
                }
            }
            // Pause Vision detection for the paywall's lifetime when
            // we're in multi-mode. Without this, a quota-wall paywall
            // triggered by an auto-detect could be re-triggered by
            // the next auto-detect while the modal is open — burning
            // server calls and stacking up identify firings the user
            // can't see. Single-mode paywalls (crown tap, tap-quota
            // wall) don't need this because auto-detect doesn't add
            // tray entries there and tap is gated up front. (Codex
            // P2 review on PR #83.)
            .onChange(of: showPaywallSheet) { _, isPresented in
                guard scanner.multiScanMode else { return }
                if isPresented {
                    scanner.viewModel?.pauseForExternalCapture()
                } else {
                    scanner.resumeScanning()
                }
            }
            // Multi-scan flash trigger. Watches the session's entries
            // array via its identifier (last entry's id) — fires on
            // every append, including consecutive scans of different
            // cards. Same-id repeats won't trigger (dedupe-drop
            // doesn't append). Uses the entry-id rather than count to
            // re-flash correctly when a submit clears the tray and
            // the user immediately scans another card (count goes 0
            // → 1 just like the very first scan, but the id is new).
            .onChange(of: multiScanSession.entries.last?.id) { _, newId in
                guard scanner.multiScanMode, let id = newId else { return }
                triggerMultiScanFlash(for: id)
            }
            .onAppear {
                // Wire the auto-detect quota-blocked callback so
                // ScannerHost's installNetworkIdentifier can surface
                // the paywall sheet without direct access to our
                // @State. Idempotent — re-assignment on tab-switch
                // / view-reappear is fine. (Codex P2 review on PR
                // #83: pre-identify quota gate.)
                scanner.onAutoDetectQuotaBlocked = {
                    paywallSurface = "scanner_quota_wall_multi"
                    showPaywallSheet = true
                }
                #if DEBUG
                runSmokeTestIfRequested()
                #endif
            }
        }
    }

    // MARK: - Quota-approaching warning (4th-of-5 scan trigger)
    //
    // Fires once per day for free users when remaining hits 1. The
    // toast is presentation-only (ScanQuotaWarningToast); this method
    // gates trigger conditions and schedules auto-dismiss after 4s
    // of being on screen so it doesn't camp.

    private func evaluateQuotaWarning() {
        guard !premiumGate.isPro,
              scanQuota.remaining == 1,
              !showPaywallSheet,
              !scanner.isIdentifying,
              scanQuota.lastWarnedScansToday != scanQuota.scansToday
        else { return }

        scanQuota.markWarned()
        withAnimation { quotaWarningVisible = true }

        Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            // Re-check: if the user already tapped + opened the
            // paywall, or navigated away, don't bother animating out.
            if quotaWarningVisible {
                withAnimation { quotaWarningVisible = false }
            }
        }
    }

    private func handleQuotaWarningTap() {
        PAHaptics.tap()
        quotaWarningVisible = false
        paywallSurface = "scanner_quota_warning"
        showPaywallSheet = true
    }

    // MARK: - Camera-starting placeholder
    //
    // Shown until ScannerHost.firstFrameRendered flips to true (i.e.,
    // until the AVCaptureSession produces its first sample buffer).
    // The HAL takes 1-3s on real device for cold launch — we don't
    // try to make that faster (battery + privacy cost; see
    // Option 2 evaluation 2026-05-05), we just communicate that
    // something is loading.
    //
    // Visual is intentionally restrained: a viewfinder symbol,
    // "Starting camera…" label, and a small spinner. Matches the
    // scanner's stripped-down aesthetic — no pulsing borders or
    // animated brackets that the user explicitly didn't want
    // (commit 997445c).

    private var cameraStartingPlaceholder: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 14) {
                Image(systemName: "viewfinder")
                    .font(.system(size: 56, weight: .light))
                    .foregroundStyle(.white.opacity(0.45))
                Text("Starting camera…")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.white.opacity(0.6))
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(.white.opacity(0.55))
                    .padding(.top, 6)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Starting camera")
    }

    // MARK: - Init-error overlay

    private func initErrorOverlay(message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 32))
                .foregroundStyle(PA.Colors.negative)
            Text("Scanner unavailable")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white.opacity(0.85))
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.55))
                .multilineTextAlignment(.center)
                .lineLimit(3)
                .padding(.horizontal, 28)
        }
    }

    // MARK: - Free-tier scan-quota indicator
    //
    // Tiny pill below the crown showing "X left" today. Hidden for
    // pro users (they're unlimited). Lets the user see why a tap
    // got intercepted into the paywall sheet on their 6th attempt.

    private var scanQuotaIndicator: some View {
        let remaining = scanQuota.remaining
        return Text(remaining > 0 ? "\(remaining) left" : "Daily limit")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(remaining > 0 ? PA.Colors.hairline(0.75) : Color.yellow.opacity(0.95))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(.ultraThinMaterial.opacity(0.5))
            .clipShape(Capsule())
    }

    // MARK: - Crown button (paywall entry + DEBUG override toggle)
    //
    // Tap: open the paywall sheet (always — production + DEBUG).
    // Long-press: in DEBUG builds only, flip PremiumGate's override
    // so QA can exercise the pro path without a real StoreKit purchase.
    // Filled crown = currently pro (real or override), hollow = free.
    //
    // We can't use a SwiftUI Button + simultaneousGesture(LongPress)
    // here — the Button still fires its tap action on touch-up after
    // a long press completes, so the paywall sheet pops up alongside
    // the override toggle. Using a plain Image + ExclusiveGesture
    // (LongPress before Tap) makes the two mutually exclusive: held
    // ≥0.6s recognizes long-press and cancels tap; released earlier
    // falls through to tap.

    private var crownButton: some View {
        Image(systemName: premiumGate.isPro ? "crown.fill" : "crown")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(
                premiumGate.isPro ? Color.yellow.opacity(0.9) : .white.opacity(0.5)
            )
            .frame(width: 32, height: 32)
            .background(.ultraThinMaterial.opacity(0.5))
            .clipShape(Circle())
            .contentShape(Circle())
            .gesture(crownGesture)
            .accessibilityLabel(premiumGate.isPro ? "PopAlpha Pro" : "Upgrade to PopAlpha Pro")
    }

    private var crownGesture: some Gesture {
        let tap = TapGesture().onEnded {
            PAHaptics.tap()
            paywallSurface = "scanner_crown"
            showPaywallSheet = true
        }
        #if DEBUG
        let longPress = LongPressGesture(minimumDuration: 0.6).onEnded { _ in
            PAHaptics.tap()
            premiumGate.debugOverrideEnabled.toggle()
        }
        return longPress.exclusively(before: tap)
        #else
        return tap
        #endif
    }

    // MARK: - Offline smoke-test button + sheet plumbing (DEBUG only)

    #if DEBUG
    private var smokeSheetBinding: Binding<Bool> {
        Binding(
            get: { smokeReport != nil },
            set: { if !$0 { smokeReport = nil } }
        )
    }

    private var offlineSmokeButton: some View {
        Button {
            PAHaptics.tap()
            guard !smokeRunning else { return }
            smokeRunning = true
            Task.detached(priority: .userInitiated) {
                let report = await OfflineScannerSmokeTest.run()
                await MainActor.run {
                    smokeReport = report
                    smokeRunning = false
                }
            }
        } label: {
            ZStack {
                if smokeRunning {
                    ProgressView()
                        .progressViewStyle(CircularProgressViewStyle(tint: .white))
                        .scaleEffect(0.6)
                } else {
                    Image(systemName: "wifi.slash")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                }
            }
            .frame(width: 32, height: 32)
            .background(.ultraThinMaterial.opacity(0.5))
            .clipShape(Circle())
        }
        .disabled(smokeRunning)
    }

    /// DEBUG-only sticky banner showing the last scan's routing.
    /// Bottom-left of the scanner, small enough not to obscure the
    /// viewfinder. Goes blank until the first scan completes, then
    /// stays visible (sticky) until the next scan replaces it. Lets
    /// the operator verify "this scan went offline / this scan went
    /// to the server" while iterating on accuracy work without having
    /// to tail logs from a connected Mac.
    @ViewBuilder
    private var lastScanDebugBanner: some View {
        if let source = scanner.lastSource {
            VStack {
                Spacer()
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Circle()
                                .fill(source == "offline" ? Color.green : Color.orange)
                                .frame(width: 6, height: 6)
                            Text(source.uppercased())
                                .font(.system(size: 10, weight: .bold, design: .monospaced))
                                .foregroundStyle(.white)
                        }
                        if let path = scanner.lastWinningPath {
                            Text("path=\(path)")
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.85))
                        }
                        if let conf = scanner.lastConfidence {
                            Text("conf=\(conf)")
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.85))
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 6))
                    Spacer()
                }
                .padding(.leading, 16)
                .padding(.bottom, 100)
            }
            .allowsHitTesting(false)
        }
    }

    private func runSmokeTestIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains("-runOfflineSmoke")
            || ProcessInfo.processInfo.arguments.contains("-debugOfflineIdentifier")
        else {
            return
        }
        guard !smokeRunning, smokeReport == nil else { return }
        smokeRunning = true
        Task.detached(priority: .userInitiated) {
            let report = await OfflineScannerSmokeTest.run()
            // Log each check on its own line so the unified-logging
            // backend doesn't truncate a single multi-line message
            // (which would hide the failure mode of any specific
            // check). Header + footer wrap the per-check entries so
            // log filters can easily scope.
            Logger.scan.notice("=== OFFLINE_SMOKE_BEGIN ===")
            Logger.scan.notice("catalog: \(report.catalogPath)")
            Logger.scan.notice("model:   \(report.modelPath)")
            for check in report.checks {
                Logger.scan.notice("\(check.line)")
            }
            Logger.scan.notice("=== OFFLINE_SMOKE_END (\(report.allPassed ? "ALL PASSED" : "SOME FAILED")) ===")

            // Tier 6: orchestrator end-to-end. Lives in PopAlphaApp
            // (which has the adapter logic) so it can't sit inside
            // PopAlphaCore's smoke test, but we run it under the
            // same launch flag to keep one debug entry point.
            let orch = await MainActor.run { OfflineScanOrchestrator() }
            let img = Self.makeOrchestratorTestImage()
            Logger.scan.debug("=== ORCH_SMOKE_BEGIN ===")
            do {
                let t0 = Date()
                let response = try await orch.identify(
                    image: img,
                    cardNumber: nil,
                    setHint: nil,
                    language: .en,
                    limit: 5,
                )
                let elapsed = Date().timeIntervalSince(t0) * 1000
                let top = response.matches.first
                Logger.scan.debug("elapsed=\(String(format: "%.1f", elapsed))ms confidence=\(response.confidence) winning_path=\(response.winningPath ?? "nil") matches=\(response.matches.count)")
                if let top {
                    Logger.scan.debug("top-1 slug=\(top.slug) name=\"\(top.canonicalName)\" set=\"\(top.setName ?? "nil")\" num=\"\(top.cardNumber ?? "nil")\" sim=\(String(format: "%.4f", top.similarity)) imgURL=\(top.mirroredPrimaryImageUrl ?? "nil")")
                }
                Logger.scan.debug("imageHash=\(response.imageHash ?? "nil")")
                let plumbingOk = top != nil
                    && top?.canonicalName.isEmpty == false
                    && top?.mirroredPrimaryImageUrl != nil
                    && response.imageHash != nil
                Logger.scan.debug("\(plumbingOk ? "ALL ORCH PASSED ✅" : "ORCH FAILED ❌")")
            } catch {
                Logger.scan.debug("error: \(error.localizedDescription)")
                Logger.scan.debug("ORCH FAILED ❌")
            }
            Logger.scan.debug("=== ORCH_SMOKE_END ===")

            await MainActor.run {
                smokeReport = report
                smokeRunning = false
            }
        }
    }

    /// Synthesizes a 384×384 deterministic-noise image for the
    /// orchestrator end-to-end check. `nonisolated` because pure
    /// pixel synthesis touches no actor state — without it, Swift 6
    /// rejects the call from the smoke-test runner closure (which
    /// is not @MainActor) even though it's safe.
    nonisolated private static func makeOrchestratorTestImage() -> UIImage {
        let side = 384
        let bytesPerPixel = 4
        let bytesPerRow = side * bytesPerPixel
        var pixels = [UInt8](repeating: 0, count: side * bytesPerRow)
        var state: UInt32 = 1234567 &* 1103515245 &+ 12345
        for i in 0..<(side * side) {
            state = state &* 1103515245 &+ 12345
            let r = UInt8((state >> 16) & 0xFF)
            state = state &* 1103515245 &+ 12345
            let g = UInt8((state >> 16) & 0xFF)
            state = state &* 1103515245 &+ 12345
            let b = UInt8((state >> 16) & 0xFF)
            let off = i * bytesPerPixel
            pixels[off + 0] = r
            pixels[off + 1] = g
            pixels[off + 2] = b
            pixels[off + 3] = 255
        }
        let cs = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue
            | CGImageAlphaInfo.premultipliedLast.rawValue
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        let cg = CGImage(
            width: side,
            height: side,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: bytesPerRow,
            space: cs,
            bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent,
        )!
        return UIImage(cgImage: cg)
    }
    #endif

    // MARK: - Removed UI helpers (idleBackground, topBar, statusBadge,
    //         modePill, languagePill, libraryPickerButton,
    //         evalSeedingButton, scannerFrame, trackingBrackets,
    //         multiCardTray, multiCardChip, chipPlaceholder,
    //         loadAndIdentifyLibraryPhoto)
    //
    // Stripped 2026-05-04 in favor of a clean viewfinder. See top-of-
    // file comment. Searchable trace for git blame: this stub block
    // is intentionally left so a curious future reader sees what's
    // gone, not just an empty space between two unrelated views.

    // MARK: - Language Pill (top-right toggle, EN ↔ JP)
    //
    // Two-segment capsule. Tapping a segment flips
    // ScannerHost.scanLanguage, which propagates to:
    //   - OCRService.extractCardIdentifiersMulti: switches Vision's
    //     recognitionLanguages from ["en-US"] to ["ja-JP", "en-US"]
    //   - ScanService.identify (server route): sends language=JP query
    //   - The offline-vs-server gate: JP forces server (the bundled
    //     .papb has no JP rows yet)
    //   - ScanPickerSheet: language threads into eval-promote and
    //     user-correction submission so the right
    //     captured_language gets recorded.
    //
    // Designed to vanish into the chrome on EN (the common case): a
    // dim "EN | JP" pill where only the active segment is filled.
    @ViewBuilder
    private var languagePill: some View {
        HStack(spacing: 0) {
            languagePillSegment(.en)
            languagePillSegment(.jp)
        }
        .background(Color.black.opacity(0.5))
        .clipShape(Capsule())
        .overlay(languagePillBorder)
    }

    @ViewBuilder
    private func languagePillSegment(_ lang: ScanLanguage) -> some View {
        let isActive = scanner.scanLanguage == lang
        let fg: Color = isActive ? .white : Color.white.opacity(0.55)
        let bg: Color = isActive ? PA.Colors.accent : Color.clear
        Text(lang.shortLabel)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(fg)
            .frame(width: 28, height: 22)
            .background(bg)
            .contentShape(Rectangle())
            .onTapGesture { scanner.scanLanguage = lang }
    }

    private var languagePillBorder: some View {
        Capsule().strokeBorder(Color.white.opacity(0.2), lineWidth: 0.5)
    }

    // MARK: - Identify Status Toast (bottom-center of screen)

    @ViewBuilder
    private var identifyStatusToast: some View {
        if let error = scanner.identifyError {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.negative)
                Text(error)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(2)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial.opacity(0.9))
            .clipShape(Capsule())
            .overlay(
                Capsule().stroke(PA.Colors.negative.opacity(0.5), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)
        } else {
            HStack(spacing: 8) {
                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: PA.Colors.accent))
                    .scaleEffect(0.7)
                Text("Identifying…")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.92))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial.opacity(0.9))
            .clipShape(Capsule())
            .overlay(
                Capsule().stroke(PA.Colors.accent.opacity(0.5), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)
        }
    }

    // MARK: - Recognition handling

    private func handleIdentifyResult(_ match: ScanMatch?) {
        guard let match else { return }

        // Multi-scan mode short-circuits the single-mode routing for
        // HIGH/MEDIUM: every confident-enough scan appends to the tray
        // and the scanner re-arms immediately. LOW continues to re-arm
        // silently — letting LOW into the tray would dilute the signal
        // of HIGH/MED rows. The single-mode picker is suppressed; per-
        // row re-pick from the tray is a future iteration.
        if scanner.multiScanMode {
            switch scanner.lastConfidence {
            case "high", "medium":
                // Auto-detect dedupe (Codex P2 review on PR #83,
                // fourth pass). The Vision engine fires on every new
                // stable rectangle, but a card lingering in the
                // viewfinder while the user reaches for the next one
                // can produce another stable window for the SAME card
                // and append it again. Drop repeat-slug auto-detect
                // results inside a short window so the pack/binder
                // flow doesn't inflate the tray or burn quota for the
                // same physical card. Tap/library entries are
                // deliberate user actions — they bypass this guard
                // (the same user might genuinely want to scan two
                // copies of the same card via tap).
                if scanner.lastTriggerSource == "auto",
                   multiScanSession.shouldDedupeAutoDetect(slug: match.slug) {
                    // The upstream gate charged a quota unit before
                    // this server call; refund it now since the
                    // duplicate is being dropped from the tray.
                    // Without this refund a card lingering in the
                    // viewfinder eats quota on every re-fire even
                    // though the stack doesn't grow. Premium users
                    // didn't charge upstream, so don't refund.
                    if !premiumGate.isPro {
                        scanQuota.refundScan()
                    }
                    scanner.clearLastMatch()
                    scanner.resumeScanning()
                    return
                }
                // Quota was already charged upstream in
                // ScannerHost.installNetworkIdentifier — every server
                // call deserves a quota tick regardless of result
                // tier. LOW/error results land in the default branch
                // below and don't append, but the charge stays
                // (consistent with "you used a server call"). Only
                // same-slug auto-detect duplicates are refunded
                // (block above). Tap and library are charged at
                // their own entry points. (Codex P2 review on PR
                // #83, eleventh pass.)
                PAHaptics.tap()
                multiScanSession.append(
                    match: match,
                    candidates: scanner.lastMatches,
                    confidence: scanner.lastConfidence ?? "medium",
                    imageHash: scanner.lastImageHash,
                    // Pin scanLanguage per-row so a later correction
                    // submits under the row's ORIGINAL language, not
                    // the scanner's current pill state (which auto-
                    // flips on CJK and updates on every new scan).
                    // Codex P2 on PR #101.
                    scanLanguage: scanner.scanLanguage,
                    // Retain the source JPEG (offline OR network-
                    // routed) so per-row correction can submit a
                    // server-side user_correction anchor via
                    // ScanPickerSheet's bytes-gated promote path.
                    // Uses `lastSourceImage` (multi-mode-only,
                    // always-set) rather than `lastScanImage`
                    // (offline-only) so network-routed corrections
                    // also fire. Codex P2 on PR #101 flagged the
                    // network-routed gap.
                    scanImage: scanner.lastSourceImage,
                )
                scanner.clearLastMatch()
                scanner.resumeScanning()
            default:
                scanner.clearLastMatch()
                scanner.resumeScanning()
            }
            return
        }

        switch scanner.lastConfidence {
        case "high":
            // Zero-tap auto-navigate on high confidence.
            PAHaptics.tap()
            navigateToCard = match.toMarketCard()

        case "medium":
            // Present the top-3 picker so the user can tap the right
            // card. ~58% top-5 accuracy on the eval corpus means the
            // picker almost always contains the correct answer; silent
            // re-arm would throw that away.
            if !scanner.lastMatches.isEmpty {
                PAHaptics.selection()
                showPickerSheet = true
            } else {
                scanner.clearLastMatch()
                scanner.resumeScanning()
            }

        default:
            // Low confidence (or unknown tier) → silent re-arm.
            scanner.clearLastMatch()
            scanner.resumeScanning()
        }
    }

    // MARK: - Multi-scan helpers

    /// Small, unobtrusive bottom-right toggle. Sits alone in single mode
    /// and re-anchors above the tray bar when multi-mode is on. The
    /// filled-vs-outlined icon plus an optional count badge gives an
    /// at-a-glance sense of mode + tray depth without taking up
    /// viewfinder real estate.
    private var multiScanToggle: some View {
        Button(action: handleMultiScanToggleTap) {
            let active = scanner.multiScanMode
            ZStack(alignment: .topTrailing) {
                Image(systemName: active ? "square.stack.fill" : "square.stack")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(active ? .black : .white)
                    .frame(width: 44, height: 44)
                    .background(
                        Circle().fill(active ? Color.white : Color.black.opacity(0.45)),
                    )
                    .overlay(
                        Circle().stroke(Color.white.opacity(0.15), lineWidth: 0.5),
                    )
                if active, multiScanSession.entries.count > 0 {
                    Text("\(multiScanSession.entries.count)")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.red))
                        .offset(x: 6, y: -4)
                }
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            // Long-press / right-click menu so the user can ALWAYS
            // explicitly exit multi-mode regardless of stack state.
            // Direct tap is context-sensitive (see
            // handleMultiScanToggleTap) — when the stack has entries,
            // tap opens the review sheet; the menu is the unambiguous
            // way to leave the mode without first emptying or
            // bulk-adding.
            if scanner.multiScanMode {
                Button(role: .destructive) {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        scanner.multiScanMode = false
                    }
                    AnalyticsService.shared.captureRaw(
                        "scanner_multi_mode_toggled",
                        properties: [
                            "now_active": false,
                            "tray_count": multiScanSession.entries.count,
                            "source": "context_menu_exit",
                        ],
                    )
                } label: {
                    Label("Exit batch mode", systemImage: "xmark.circle")
                }
            }
        }
        .accessibilityLabel(toggleAccessibilityLabel)
    }

    /// Three-state tap behavior on the multi-scan toggle (Codex P1 on
    /// PR #97 made this necessary — with the bottom tray bar removed,
    /// the flash overlay was the only entry point to the review
    /// sheet, leaving the user stuck if the flash faded with a
    /// non-empty stack):
    ///   - Off              → enter multi-scan mode
    ///   - On, 0 entries    → exit multi-scan mode
    ///   - On, ≥ 1 entries  → open the review sheet (mode stays on)
    /// To exit mode while the stack is non-empty, long-press the
    /// toggle for the contextual "Exit batch mode" menu item.
    private func handleMultiScanToggleTap() {
        PAHaptics.selection()
        if !scanner.multiScanMode {
            withAnimation(.easeInOut(duration: 0.2)) {
                scanner.multiScanMode = true
            }
            AnalyticsService.shared.captureRaw(
                "scanner_multi_mode_toggled",
                properties: [
                    "now_active": true,
                    "tray_count": multiScanSession.entries.count,
                    "source": "toggle",
                ],
            )
        } else if multiScanSession.entries.isEmpty {
            withAnimation(.easeInOut(duration: 0.2)) {
                scanner.multiScanMode = false
            }
            AnalyticsService.shared.captureRaw(
                "scanner_multi_mode_toggled",
                properties: [
                    "now_active": false,
                    "tray_count": 0,
                    "source": "toggle",
                ],
            )
        } else {
            // Non-empty stack — opening the review sheet is the most
            // useful action. Keep multi-mode on.
            flashTask?.cancel()
            flashEntryId = nil
            showMultiScanSheet = true
            AnalyticsService.shared.captureRaw(
                "scanner_multi_mode_review_opened",
                properties: [
                    "tray_count": multiScanSession.entries.count,
                    "source": "toggle",
                ],
            )
        }
    }

    private var toggleAccessibilityLabel: String {
        if !scanner.multiScanMode { return "Enter multi-scan mode" }
        if multiScanSession.entries.isEmpty { return "Exit multi-scan mode" }
        return "Open multi-scan stack (\(multiScanSession.entries.count))"
    }

    /// Submits the current tray to /api/holdings/bulk-import. Returns
    /// nil on full success (sheet closes), or a user-facing error
    /// string when the network call throws or any rows fail. The
    /// Builds the ScanPickerSheet used for per-row correction inside
    /// the review sheet. Reuses the single-mode picker UI (top-K
    /// candidates + "None of these" catalog search) so the
    /// disambiguation UX is consistent across single and multi modes.
    /// On pick: re-assigns the entry's match via session.reassign
    /// (which also re-fetches price for the new slug) and triggers
    /// the same anchor-sync the single-mode picker uses.
    ///
    /// `scanImage` is the offline-scan source JPEG retained on
    /// MultiScanEntry. Server-routed scans (where lastScanImage was
    /// nil at append time) pass nil here — for those, the existing
    /// scan-uploads/<hash>.jpg path is the eval-promote target.
    /// Without retaining bytes here, ScanPickerSheet's correction-
    /// promote path (gated on `if let bytes = scanImage`) would
    /// silently skip the user_correction anchor submission. Codex
    /// P2 on PR #101 flagged that miss.
    @ViewBuilder
    private func correctionPickerSheet(for entryId: UUID) -> some View {
        if let entry = multiScanSession.entries.first(where: { $0.id == entryId }) {
            ScanPickerSheet(
                matches: entry.candidates,
                imageHash: entry.imageHash,
                scanImage: entry.scanImage,
                // Use the row's pinned language (set at append time)
                // not scanner.scanLanguage (which would reflect the
                // CURRENT pill state, possibly flipped by a later
                // scan or manual toggle). Codex P2 on PR #101.
                scanLanguage: entry.scanLanguage,
                ocrCardNumber: nil,
                ocrSetHint: nil,
                winningPath: nil,
                onPick: { picked in
                    multiScanSession.reassign(entryId: entryId, to: picked)
                    correctingEntry = nil
                    AnalyticsService.shared.captureRaw(
                        "scanner_multi_mode_row_corrected",
                        properties: [
                            "from_slug": entry.match.slug,
                            "to_slug": picked.slug,
                            "confidence": entry.confidence,
                            "tray_count": multiScanSession.entries.count,
                        ],
                    )
                },
                onDismiss: { correctingEntry = nil },
                onCorrectionSubmitted: {
                    scanner.syncOfflineAnchorsInBackground()
                },
            )
        }
    }

    /// Schedule the multi-scan flash overlay's three-stage exit for
    /// the just-appended entry. Cancels any in-flight schedule from a
    /// prior scan so consecutive captures replace cleanly without
    /// leaving stale animations running. Timings:
    ///   - t = 0:     overlay appears (spring pop, price visible)
    ///   - t = 1.0s:  price label fades over 250ms
    ///   - t = 1.4s:  card flies toward bottom-right toggle (offset +
    ///                shrink + opacity → 0 over 500ms)
    ///   - t = 1.9s:  overlay removed; flying state reset
    /// A tap any time during the window opens the review sheet via the
    /// overlay's onTap (cancels the remaining schedule).
    private func triggerMultiScanFlash(for entryId: UUID) {
        flashTask?.cancel()
        // Reset flying instantly so the entering card doesn't inherit
        // the "flown" position from a previous scan that didn't fully
        // clean up. The reset has to happen WITHOUT an enclosing
        // withAnimation, otherwise the card would animate from the
        // toggle position back to center on the way in.
        flashFlying = false
        withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
            flashEntryId = entryId
            flashPriceVisible = true
        }
        flashTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled, flashEntryId == entryId else { return }
            withAnimation(.easeOut(duration: 0.25)) {
                flashPriceVisible = false
            }
            // t=1.4s: start the fly-to-toggle animation. .easeIn
            // gives a "sucked toward the stack" feel — slow start,
            // accelerating into the toggle position.
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled, flashEntryId == entryId else { return }
            withAnimation(.easeIn(duration: 0.5)) {
                flashFlying = true
            }
            // t=1.9s: remove the overlay entirely. Flying state
            // cleared so the next scan's enter animation starts from
            // origin instead of the flown-out offset.
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, flashEntryId == entryId else { return }
            flashEntryId = nil
            flashFlying = false
        }
    }

    /// returned string is rendered inline in the review sheet's
    /// footer so a tapped Add button never silently no-ops — was a
    /// Codex P2 bug in the initial version of this PR (returned
    /// `Void` and only logged failures, leaving the user with a
    /// visually-unchanged tray and no explanation).
    private func submitMultiScanBatch() async -> String? {
        do {
            let summary = try await multiScanSession.submit()
            AnalyticsService.shared.captureRaw(
                "scanner_multi_mode_bulk_added",
                properties: [
                    "inserted": summary.inserted,
                    "errors": summary.errors.count,
                ],
            )
            if summary.hadAnyFailures {
                PAHaptics.selection()
                let plural = summary.errors.count == 1 ? "row" : "rows"
                return "Added \(summary.inserted) — \(summary.errors.count) \(plural) failed. Try again or swipe to remove."
            }
            PAHaptics.tap()
            showMultiScanSheet = false
            return nil
        } catch {
            Logger.scan.debug("multi-scan submit failed: \(error.localizedDescription)")
            PAHaptics.selection()
            return "Couldn't add — \(error.localizedDescription)"
        }
    }

    /// User picked a card from the ScanPickerSheet. Navigate to it.
    /// The promote-to-eval call is fired from inside the sheet so we
    /// don't need to repeat it here.
    private func handlePickerSelection(_ match: ScanMatch) {
        let marketCard = match.toMarketCard()
        // Defer navigation one tick so the sheet's dismiss animation
        // starts before the nav push — avoids the "sheet still visible
        // as the detail view slides in" UI glitch.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            navigateToCard = marketCard
            scanner.clearLastMatch()
        }
    }

    /// User dismissed the sheet without picking — re-arm the scanner.
    private func handlePickerDismiss() {
        scanner.clearLastMatch()
        scanner.resumeScanning()
    }

    private func resetToIdle() {
        scanner.clearLastRecognized()
        scanner.clearLastMatch()
        scanner.resumeScanning()
    }
}

// MARK: - Correcting-entry wrapper
//
// `.sheet(item:)` requires Identifiable; UUID doesn't conform on its
// own. This thin wrapper makes the "currently-correcting entry" state
// presentable via item-driven sheet, where the `id` field doubles as
// both the SwiftUI-identity key AND the MultiScanEntry lookup key.

struct CorrectingMultiScanEntry: Identifiable {
    let id: UUID
}

// MARK: - Scanner Host
// Wraps PopAlphaCore's ScannerViewModel in an @ObservableObject the SwiftUI view can bind to.
// Keeps init-error handling + simulator fallback in one place.

@MainActor
final class ScannerHost: ObservableObject {
    @Published private(set) var lastRecognized: PopAlphaCard?
    @Published private(set) var isScanning: Bool = true
    @Published private(set) var initError: String?
    @Published private(set) var candidateBoundingBox: CGRect?

    /// Multi-scan mode toggle. When true, post-identify routing
    /// appends HIGH/MEDIUM scans to a tray and re-arms instead of
    /// auto-navigating; LOW continues to silently re-arm. The view
    /// layer reads this from `handleIdentifyResult` to branch routing.
    /// Reset on app launch — users opt in to batch mode per session.
    @Published var multiScanMode: Bool = false

    /// Called from the auto-detect hook when a free-tier user in
    /// multi-scan mode runs out of daily quota. Lets ScannerTabView
    /// surface the paywall sheet without ScannerHost needing direct
    /// access to its @State. Wired in `.onAppear`. Pre-runIdentify
    /// quota gate (Codex P2 review on PR #83) — replaces the earlier
    /// post-identify gate in handleIdentifyResult.
    var onAutoDetectQuotaBlocked: (@MainActor () -> Void)?

    /// Mirrors `ScannerViewModel.firstFrameRendered`. Drives the
    /// "Starting camera…" placeholder in ScannerTabView's body so the
    /// user sees motion + text instead of pure black during the
    /// 1-3s AVCaptureSession HAL startup on cold launch.
    @Published private(set) var firstFrameRendered: Bool = false

    // MARK: - Zero-tap identify state

    @Published private(set) var lastMatch: ScanMatch?
    @Published private(set) var lastConfidence: String?
    @Published private(set) var isIdentifying: Bool = false
    @Published private(set) var identifyError: String?
    /// sha256 hash of the most recently-uploaded scan JPEG. Threaded
    /// through so CardDetailView can fire "this is the wrong card"
    /// corrections against the exact image the identifier saw.
    @Published private(set) var lastImageHash: String?
    /// Full match list from the last identify call. Surfaced so the
    /// picker sheet (shown on medium confidence) can display top-3
    /// candidates for the user to tap-select instead of silently
    /// re-arming. Populated alongside lastMatch; cleared in lockstep.
    @Published private(set) var lastMatches: [ScanMatch] = []

    /// The UIImage that fed the most recent OFFLINE scan, retained
    /// so the eval-promote correction flow can re-upload bytes via
    /// `promoteEvalFromBytes` when scan-uploads doesn't have them.
    /// Online scans set this to nil because /api/scan/identify
    /// already uploaded the JPEG to scan-uploads/<hash>.jpg and the
    /// existing hash-based promote flow can find it server-side.
    @Published private(set) var lastScanImage: UIImage?

    /// Always-retained source UIImage during multi-scan mode
    /// (regardless of online/offline). `lastScanImage` deliberately
    /// drops bytes for online scans to save memory — fine for the
    /// single-shot picker, but the multi-scan correction picker
    /// needs bytes on EVERY entry because ScanPickerSheet's
    /// correction-promote path is gated on
    /// `if let bytes = scanImage`. Set only when `multiScanMode`
    /// is true so single-mode's memory profile is unchanged. Codex
    /// P2 on PR #101 flagged the missing network-routed correction
    /// submission.
    @Published private(set) var lastSourceImage: UIImage?

    /// What on-device OCR pulled from the last captured frame
    /// (collector number and/or set-name hint). Surfaced so the
    /// debug overlay in ScanPickerSheet can show what Vision
    /// extracted vs. what the system identified — answers "did
    /// OCR fail or did the route ignore my hints?" during sprint
    /// real-device testing. Compile-stripped in release builds.
    @Published private(set) var lastOCR: (cardNumber: String?, setHint: String?) = (nil, nil)

    /// Which Day 2 retrieval path resolved the most recent scan
    /// (`ocr_direct_unique`, `ocr_intersect_unique`, etc.). Surfaced
    /// in the DEBUG overlay so the operator can see which signal
    /// won — direct DB lookup vs CLIP+OCR intersection vs CLIP-only
    /// fallback.
    @Published private(set) var lastWinningPath: String?

    /// "offline" (matched against the bundled .papb catalog on-device)
    /// or "network" (POSTed to /api/scan/identify). DEBUG-only overlay
    /// surfaces this so the operator can verify routing while iterating
    /// on scanner accuracy work — without it, an offline-only fix
    /// could look like it shipped when the scan actually fell through
    /// to the server.
    @Published private(set) var lastSource: String?

    /// Entry point the most recent runIdentify call came from —
    /// "auto" (Vision rectangle stable-fire), "tap" / "tap_multiframe"
    /// (manual tap-to-capture), or "library" (photo picker). Read by
    /// the multi-scan quota gate to decide whether to charge quota
    /// for the result: tap-path scans were already charged at the
    /// tap handler (lines ~97-104) and library scans bypass quota
    /// in single mode, so multi-mode should only newly-charge
    /// auto-detect results to avoid double-spending.
    @Published private(set) var lastTriggerSource: String?

    /// Language hint passed to /api/scan/identify. Defaults to EN; the
    /// scanner UI exposes a pill toggle so the user can flip to JP.
    /// `@Published` so the languagePill in the scanner overlay
    /// re-renders when the user taps to flip.
    @Published var scanLanguage: ScanLanguage = .en

    let viewModel: ScannerViewModel?
    let isUsingMockData: Bool

    /// Vision-normalized → view-space converter installed by the package's
    /// `ScannerCameraViewController` once its preview layer has laid out.
    var convertNormalizedRect: ((CGRect) -> CGRect?)? {
        viewModel?.normalizedRectConverter
    }

    private var observers: [NSKeyValueObservation] = []
    private var cancellable: AnyObject?
    /// Lazily-built offline orchestrator. Only constructed once
    /// PremiumGate.shared.offlineScannerEnabled flips true — keeps
    /// free-tier launches from incurring the model-load cost.
    private var offlineOrchestrator: OfflineScanOrchestrator?

    init() {
        #if targetEnvironment(simulator)
        let useMock = true
        #else
        let useMock = false
        #endif
        self.isUsingMockData = useMock

        do {
            let vm = try ScannerViewModel(useMockData: useMock)
            self.viewModel = vm
            self.initError = nil
            // Mirror VM published state. Simple polling via Combine sink.
            self.bind(vm)
            self.installNetworkIdentifier(vm)
        } catch {
            self.viewModel = nil
            self.initError = error.localizedDescription
        }

        // Fire-and-forget pre-warm. Real-device 2026-05-05 measured
        // 7.7s for the first scan after launch (vs 226ms steady state)
        // because the orchestrator was lazy-instantiated on first tap
        // — runSetup() (catalog + CoreML model load), the first
        // ensureFp16Scratch (17.7M Float16→Float in Swift), and Vision
        // text recognition warmup all stacked onto the user's first
        // capture. Doing the work here at ScannerHost-init time means
        // the scanner is warm before the user ever taps. Gated on the
        // premium toggle so free-tier users don't pay the model-load
        // cost.
        //
        // Priority: .utility (background-tier). Earlier we used
        // default priority and the user reported a 5s black scanner
        // page on launch — camera-session startup was contending for
        // compute with prewarm's CoreML inference and catalog parse.
        // Dropping to .utility lets iOS scheduler give camera setup
        // priority so frames arrive faster, even if prewarm itself
        // takes slightly longer wall-clock. Net UX win: black screen
        // shorter, first scan still warm by the time user taps.
        //
        // Idempotent: prewarm internally calls ensureReady which is
        // idempotent, and the dummy-embed + dummy-knn pass is cheap.
        // If the user starts scanning before prewarm completes, the
        // first scan will block on the in-flight setupTask the same
        // way it does today — strictly no worse than before.
        Task(priority: .utility) { [weak self] in
            await self?.prewarmIfPossible()
        }
    }

    /// Background prewarm of the offline pipeline. The heavy work
    /// (orchestrator + OCR) is done at App.body.task — see
    /// OfflineScannerWarmup.startIfNeeded(). This entry point is
    /// retained as a fallback (in case App-level wasn't called yet)
    /// AND to fire the Vision rectangle prewarm, which needs the
    /// engine from the view model and therefore can only run after
    /// the scanner tab activates.
    ///
    /// `nonisolated` so the child tasks ACTUALLY run in parallel.
    /// ScannerHost is @MainActor; without nonisolated, the async-let
    /// tasks would inherit main-actor isolation and queue serially.
    nonisolated private func prewarmIfPossible() async {
        let enabled = await MainActor.run { PremiumGate.shared.offlineScannerEnabled }
        guard enabled else { return }
        // Read the engine off main once so the rest runs nonisolated.
        let engine: PopAlphaVisionEngine? = await MainActor.run { self.viewModel?.visionEngine }
        // Two parallel warm tasks:
        //   - App-level warmup (orchestrator + OCR). Idempotent — if
        //     PopAlphaApp.body.task already fired this, second call
        //     is a no-op via the dispatchOnce-style guard inside
        //     OfflineScannerWarmup. Belt-and-braces.
        //   - Vision rectangle: VNDetectRectanglesRequest. Real-device
        //     2026-05-05 saw the FIRST tap_detect call take 672ms vs
        //     ~10-20ms steady state. Pre-warming absorbs that cost.
        //     This stays in ScannerHost because the engine isn't
        //     available until the scanner tab activates.
        async let warmApp: Void = OfflineScannerWarmup.startIfNeeded()
        async let warmVision: Void = Self.prewarmVisionRectangle(engine: engine)
        _ = await (warmApp, warmVision)
    }

    /// One-time OCR warmup. Vision's VNRecognizeTextRequest does
    /// internal JIT/state allocation on first invocation that adds
    /// ~200ms to scan_e2e on the user's first scan. Running it once
    /// against a tiny synthetic image during prewarm absorbs that
    /// cost off the user's critical path.
    nonisolated private static func prewarmOCR() async {
        let t0 = Date()
        // Synthetic image just needs to drive Vision through one full
        // recognition pass. Mid-gray 256×256 is enough — Vision sees
        // no text but still goes through detector init.
        let size = CGSize(width: 256, height: 256)
        let renderer = UIGraphicsImageRenderer(size: size)
        let dummy = renderer.image { ctx in
            UIColor.gray.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
        _ = await OCRService.extractCardIdentifiersMulti(from: dummy)
        let elapsed = Date().timeIntervalSince(t0) * 1000
        Logger.scan.debug("prewarm_ocr: total=\(String(format: "%.1f", elapsed))ms")
    }

    /// One-time Vision rectangle detection warmup. The same detector
    /// that powers continuous auto-detect is also called via
    /// `engine.detectAndCrop` on every tap-to-capture. Real-device
    /// 2026-05-05 the first tap_detect call (cold) measured 672ms;
    /// running detection once on a synthetic image during prewarm
    /// brings the steady-state ~15ms timing onto the user's first
    /// real tap.
    ///
    /// Static + nonisolated + engine-as-parameter so this can run
    /// off the main actor in true parallel with the orchestrator and
    /// OCR warmups (vs the prior instance method which serialized on
    /// the main actor and added ~7s of fake work).
    nonisolated private static func prewarmVisionRectangle(engine: PopAlphaVisionEngine?) async {
        guard let engine else { return }
        let t0 = Date()
        // 1280×720 mid-gray. Vision won't find a card-shaped
        // rectangle (no edges in a solid color), but the framework
        // still walks its full detector pipeline once to allocate
        // internal state. That's all we need.
        let size = CGSize(width: 1280, height: 720)
        let renderer = UIGraphicsImageRenderer(size: size)
        let dummy = renderer.image { ctx in
            UIColor.gray.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
        _ = engine.detectAndCrop(dummy)
        let elapsed = Date().timeIntervalSince(t0) * 1000
        Logger.scan.debug("prewarm_vision_rect: total=\(String(format: "%.1f", elapsed))ms")
    }

    private func bind(_ vm: ScannerViewModel) {
        // Observe via Combine on the VM's objectWillChange — pull current values each tick.
        // (ScannerViewModel is an ObservableObject with @Published properties.)
        let c = vm.objectWillChange.sink { [weak self, weak vm] _ in
            guard let self, let vm else { return }
            // objectWillChange fires before the change, so dispatch to next runloop tick.
            DispatchQueue.main.async {
                self.isScanning = vm.isScanning
                if self.lastRecognized?.id != vm.recognizedCard?.id {
                    self.lastRecognized = vm.recognizedCard
                }
                if self.candidateBoundingBox != vm.candidateBoundingBox {
                    self.candidateBoundingBox = vm.candidateBoundingBox
                }
                if self.firstFrameRendered != vm.firstFrameRendered {
                    self.firstFrameRendered = vm.firstFrameRendered
                }
            }
        }
        self.cancellable = c
    }

    /// Replaces the package's on-device CoreML classifier with a
    /// network call to /api/scan/identify. Scanner remains paused for
    /// the duration; SwiftUI listens to `lastMatch` + `lastConfidence`
    /// to auto-navigate on "high" confidence results.
    private func installNetworkIdentifier(_ vm: ScannerViewModel) {
        vm.onStableCardCaptured = { [weak self] image, perspectiveCorrection, triggerKind in
            guard let self else { return }

            // Pre-identify quota gate for multi-scan auto-detect
            // (Codex P2 review on PR #83). Without this, a free-tier
            // user with no scans left still uploads the JPEG and
            // hits /api/scan/identify on every stable auto-capture —
            // the server-side cost is wasted, and dismissing the
            // paywall lets the loop continue. Gating here intercepts
            // before runIdentify ever fires. Single-mode auto-detect
            // doesn't gate here (existing back-compat behavior); the
            // tap path has its own quota check before
            // captureFrameAndIdentify, and library imports bypass
            // intentionally.
            let blocked = await MainActor.run {
                guard self.multiScanMode, !PremiumGate.shared.isPro else {
                    return false
                }
                ScanQuota.shared.rolloverIfNewDay()
                if !ScanQuota.shared.canScan {
                    self.onAutoDetectQuotaBlocked?()
                    return true
                }
                // canScan check happens here (pre-identify) so a user
                // at the wall never makes a server call. recordScan
                // does NOT happen here — it lives inside runIdentify,
                // AFTER the re-entry guard, so the daily counter
                // doesn't tick for callbacks that the guard drops
                // (in-flight identify, result waiting on screen).
                // Codex P2 on PR #83 (twelfth pass) caught the over-
                // charge from charging at this layer. The dedupe-
                // drop branch in handleIdentifyResult still refunds
                // for same-card auto-re-fires.
                return false
            }
            if blocked { return }

            // triggerKind plumbed through from the engine: "auto" for
            // the rectangle stability-gate path, "auto_saliency" for
            // the full-art fallback path (2026-05-16). Forwarded as
            // triggerSource so we can segment hit-rate in PostHog and
            // scan_identify_events.
            await self.runIdentify(
                image: image,
                triggerSource: triggerKind,
                perspectiveCorrection: perspectiveCorrection,
            )
        }
    }

    /// Returns the offline orchestrator. Always the app-wide shared
    /// instance — see OfflineScanOrchestrator.shared docstring for
    /// why we don't per-scanner-tab instantiate. Idempotent: same
    /// instance every call, prewarm work done once at App-task time.
    /// Local `offlineOrchestrator` cache is retained so callers that
    /// previously checked `offlineOrchestrator != nil` (e.g.,
    /// syncOfflineAnchorsInBackground) keep behaving correctly.
    private func makeOrchestrator() -> OfflineScanOrchestrator {
        let shared = OfflineScanOrchestrator.shared
        if offlineOrchestrator !== shared {
            offlineOrchestrator = shared
        }
        return shared
    }

    /// Triggers a non-blocking anchor sync against /api/catalog/anchors-since.
    /// Called from the picker after a correction lands so the just-
    /// submitted user_correction anchor reaches the offline catalog
    /// before the user's next scan. Always uses the shared
    /// orchestrator now (see makeOrchestrator above) so this fires
    /// even before the user has opened the Scanner tab.
    func syncOfflineAnchorsInBackground() {
        OfflineScanOrchestrator.shared.syncAnchorsInBackground()
    }

    /// `image` is the input the embedder will see — typically the
    /// 0.85 center-crop produced by the camera frame capturer.
    /// `ocrImage`, when supplied, is used for OCR instead of `image`.
    /// The tap-anywhere path passes the FULL uncropped frame here so
    /// the bottom-edge collector number stays in scope (the embed
    /// crop trims it). When `ocrImage` is nil, OCR runs on `image` —
    /// preserves prior behavior for the photo-picker and Vision
    /// auto-detect paths, where the input is already untruncated.
    /// `triggerSource` tags the entry path for telemetry — "auto"
    /// (Vision rectangle stable-fire), "tap" (manual tap-to-capture),
    /// or "library" (Photos picker). Surfaces in scan_e2e log lines
    /// so a baseline can compare auto-detect fire rate vs manual.
    private func runIdentify(
        image: UIImage,
        ocrImage: UIImage? = nil,
        additionalOCRFrames: [UIImage] = [],
        triggerSource: String = "unknown",
        // Phase 0d (2026-05-15): perspective-correction geometry captured
        // during the auto-detect / tap detection step. Nil for library
        // imports and for tap-detect that fell back to center-crop (no
        // CIPerspectiveCorrection ran). Flows through to PostHog (offline
        // path), `/api/scan/identify` query params (server-routed path),
        // and the DEBUG ScanDebugCapture banner.
        perspectiveCorrection: PerspectiveCorrectionDiagnostics? = nil,
    ) async {
        // RE-ENTRY GUARD. PopAlphaVisionEngine.reset() clears the
        // current stability candidate but does NOT stop frame
        // analysis. So while we're inside an identify call, Vision
        // can detect another stable rectangle and re-fire
        // onStableCardCaptured. Without this guard, that produces
        // concurrent runIdentify calls — and the second one's HIGH
        // result yanks the picker out from under the user when the
        // first one returned MEDIUM.
        //
        // Two reasons to skip:
        //   - isIdentifying: we're already mid-flight.
        //   - lastMatch != nil: a result is sitting on screen waiting
        //     for the user (HIGH navigated to detail, MEDIUM picker
        //     shown). Either way, fresh scans should not steal focus
        //     until the user re-arms via dismiss / detail-view-back /
        //     low-confidence silent re-arm.
        if self.isIdentifying || self.lastMatch != nil {
            Logger.scan.debug("runIdentify dropped — isIdentifying=\(self.isIdentifying) lastMatch=\(self.lastMatch?.slug ?? "nil")")
            return
        }
        self.isIdentifying = true
        self.identifyError = nil

        // Multi-scan auto-detect quota charge (Codex P2 review on PR
        // #83, twelfth pass). Lives BEHIND the re-entry guard above
        // because the upstream onStableCardCaptured hook can fire
        // for frames that this guard then drops (a previous identify
        // is in flight or a result is waiting on screen). Charging
        // before the guard would tick the daily counter for those
        // suppressed callbacks even though no server call ran.
        // Scoped to auto-detect triggers ("auto" or "auto_saliency" —
        // the latter is the 2026-05-16 full-art fallback) — tap is
        // charged at the tap handler, library bypasses by convention.
        // Premium skips. The dedupe-drop branch in handleIdentifyResult
        // refunds same-card auto-re-fires; LOW results stay charged
        // because the server call actually ran.
        if (triggerSource == "auto" || triggerSource == "auto_saliency"),
           self.multiScanMode,
           !PremiumGate.shared.isPro {
            ScanQuota.shared.recordScan()
        }
        // Belt-and-braces: clear Vision's stability buffer so the
        // next post-arm re-detection requires a fresh stable window.
        self.viewModel?.pauseForExternalCapture()
        self.isScanning = self.viewModel?.isScanning ?? false

        // Telemetry — wall-clock t0 for the end-to-end scan_e2e log.
        // Captures everything from "we have an image" to "we have a
        // result ready for the UI": OCR, embedder, kNN, Path A/B,
        // network fallback, reranker. Used as the baseline against
        // any future detector swap (RFDETR vs the current Vision
        // rectangle path). Per-stage breakdowns come from
        // `orch_timing` (embed + identify) and `knn_timing` (kNN
        // alone) inside the offline pipeline.
        let scanT0 = Date()

        // Multi-candidate OCR via Vision's beam search (topCandidates(3))
        // PLUS a second pass on the bicubic-upscaled bottom strip —
        // recovers tiny collector-number text the full pass misses
        // under blur. Only the top candidate is sent to the server
        // (legacy single-candidate API); the offline path uses the
        // full list via Path B trial.
        //
        // OCR sees `ocrImage` when provided (full uncropped frame from
        // tap-anywhere capture), else falls back to the embedder's
        // `image`. Routing the wider frame to OCR was needed because
        // the embed crop strips the bottom 7.5% of the camera view —
        // exactly where the collector number prints on a card held
        // filling the viewfinder. Real-device 2026-05-04: White Flare
        // Hydreigon ex repeatedly produced cardNumbers=[] not because
        // the regex was rejecting "161/091" but because the image
        // never contained that text in the first place.
        let imageForOCR = ocrImage ?? image
        let ocrT0 = Date()
        // Multi-frame consensus on the tap path (Phase 2): when the
        // caller provided additional OCR frames captured ~200ms apart,
        // run OCR in parallel across all of them and vote on
        // card_number candidates by frequency. Single-frame callers
        // (auto-detect, library) pass [] and behave identically to
        // pre-Phase-2.
        //
        // Embedding still uses `image` (the first frame) — the card
        // hasn't moved in the ~400ms capture window, so first-frame
        // embedding matches the multi-frame OCR consensus to within
        // sub-pixel motion. Avoids the embedding-averaging complexity
        // for v1.
        let ocrMulti: (
            cardNumbers: [String],
            setHint: String?,
            detectedLanguage: ScanLanguage,
            pass2FallbackFired: Bool,
            spatialFilterRejectedCount: Int
        )
        if additionalOCRFrames.isEmpty {
            ocrMulti = await OCRService.extractCardIdentifiersMulti(from: imageForOCR)
        } else {
            ocrMulti = await OCRService.extractCardIdentifiersMultiFrame(
                from: [imageForOCR] + additionalOCRFrames,
            )
        }
        // Zero-tap language detection: extractCardIdentifiersMulti
        // always runs Vision with both ja-JP and en-US loaded and
        // detects the card's language by scanning the recognized text
        // for CJK characters. Update the published scanLanguage so
        // (a) downstream identify uses the right language filter,
        // (b) the picker sheet records the right captured_language
        //     when a user corrects a scan,
        // (c) the languagePill in the scanner overlay reflects the
        //     detected language as a status indicator.
        // The user can still tap the pill to manually override; the
        // override is per-scan (next scan re-detects).
        let detectedLanguage = ocrMulti.detectedLanguage
        if self.scanLanguage != detectedLanguage {
            self.scanLanguage = detectedLanguage
        }
        let ocrMs = Date().timeIntervalSince(ocrT0) * 1000
        let ocr = (cardNumber: ocrMulti.cardNumbers.first, setHint: ocrMulti.setHint)
        self.lastOCR = ocr
        Logger.scan.debug("ocr frameSize=\(Int(imageForOCR.size.width))x\(Int(imageForOCR.size.height)) cardNumbers=\(ocrMulti.cardNumbers) setHint=\(ocrMulti.setHint ?? "nil") ms=\(String(format: "%.1f", ocrMs))")

        // Offline-first when premium gate is open. On any offline
        // failure (catalog not downloaded, model load error, embed
        // error, identify error) we silently fall back to the
        // network path — free-tier behavior never regresses when
        // premium turns on.
        let offlineEnabled = await MainActor.run { PremiumGate.shared.offlineScannerEnabled }
        // JP scans bypass the offline orchestrator — the bundled .papb
        // catalog has zero JP rows (it's built from EN siglip2 rows
        // only). Routing JP through the offline path would either
        // return zero matches or, worse, force a JP card's embedding
        // through the EN catalog and surface incorrect EN top-1s. The
        // server route at /api/scan/identify handles language=JP
        // correctly against the 379 JP siglip2 rows in
        // card_image_embeddings (Supabase). When we eventually bundle
        // a multilingual .papb, this guard becomes the single line to
        // remove.
        //
        // We use `detectedLanguage` from the OCR pass (rather than
        // self.scanLanguage) so the gate is correct on the FIRST
        // scan after launch — self.scanLanguage starts at .en and
        // only updates after this detection landed. The two will
        // be equal by this line because we set self.scanLanguage =
        // detectedLanguage above, but reading the local makes the
        // intent unambiguous.
        let useOffline = offlineEnabled && detectedLanguage == .en
        var response: ScanIdentifyResponse?
        var usedOffline = false

        if useOffline {
            let orchestrator = await MainActor.run { self.makeOrchestrator() }
            do {
                let r = try await orchestrator.identifyMulti(
                    image: image,
                    cardNumberCandidates: ocrMulti.cardNumbers,
                    setHint: ocrMulti.setHint,
                    language: self.scanLanguage,
                )
                response = r
                usedOffline = true
                Logger.scan.debug("offline winning_path=\(r.winningPath ?? "nil") confidence=\(r.confidence) tried_candidates=\(ocrMulti.cardNumbers)")
            } catch {
                #if DEBUG
                Logger.scan.debug("failed; falling back to network: \(error.localizedDescription)")
                #endif
            }
        }

        do {
            if response == nil {
                response = try await ScanService.identify(
                    image: image,
                    language: self.scanLanguage,
                    cardNumber: ocr.cardNumber,
                    setHint: ocr.setHint,
                    ocrCardNumberExtracted: !ocrMulti.cardNumbers.isEmpty,
                    ocrPass2FallbackFired: ocrMulti.pass2FallbackFired,
                    ocrSpatialFilterRejectedCount: ocrMulti.spatialFilterRejectedCount,
                    ocrPerspectiveCorrectedExtent: perspectiveCorrection,
                )
            }
            guard let response else {
                throw ScanServiceError.imageEncodingFailed  // unreachable — keeps the optional checked
            }

            let reranked = ScanMatchReranker.rerank(
                matches: response.matches,
                originalConfidence: response.confidence,
                ocrCardNumber: ocr.cardNumber
            )

            self.lastMatch = reranked.matches.first
            self.lastMatches = reranked.matches
            self.lastConfidence = reranked.confidence
            self.lastImageHash = response.imageHash
            self.lastWinningPath = response.winningPath
            self.lastSource = usedOffline ? "offline" : "network"
            self.lastTriggerSource = triggerSource
            // Retain JPEG-source UIImage only for offline scans —
            // online scans already uploaded to scan-uploads/<hash>.jpg
            // so the correction-via-hash path works without it.
            self.lastScanImage = usedOffline ? image : nil
            // Multi-scan correction needs bytes for every row (the
            // picker's correction-promote path is gated on
            // `if let bytes = scanImage`). Retain regardless of
            // online/offline when multi-mode is active so the next
            // multiScanSession.append captures them. Cleared back to
            // nil when not in multi-mode so single-mode memory
            // profile stays unchanged.
            self.lastSourceImage = self.multiScanMode ? image : nil
            self.isIdentifying = false

            Logger.scan.debug("path source=\(usedOffline ? "offline" : "network") winning_path=\(response.winningPath ?? "nil") confidence=\(reranked.confidence)")

            // End-to-end timing — the user-facing latency number. This
            // includes everything: OCR (Vision text recognition over
            // the full + bottom-strip pass) + offline identify (embed +
            // kNN + path routing) OR network identify (HTTPS round-trip
            // + server kNN) + reranker + UI state propagation. Use this
            // as the apples-to-apples baseline against any future
            // detector / pipeline change. trigger= tells us whether the
            // scan came from auto-detect (Vision rectangle stable-fire)
            // or manual tap — combined over many scans, this gives the
            // auto-detect fire rate.
            let scanMs = Date().timeIntervalSince(scanT0) * 1000
            Logger.scan.debug("scan_e2e: trigger=\(triggerSource) source=\(usedOffline ? "offline" : "network") confidence=\(reranked.confidence) ocr_ms=\(String(format: "%.1f", ocrMs)) total_ms=\(String(format: "%.1f", scanMs))")

            // Phase 0c — emit card_scanned event with the dimensions
            // that diagnose real-device first-time HIGH rate. Server-
            // routed scans also write these to scan_identify_events
            // via query params (Phase 0b), but offline scans (the
            // dominant path for premium users) live ONLY here. PostHog
            // is queryable for "what % of scans returned HIGH on first
            // try?" + "what fraction had cardNumbers=[]?" within a day
            // of usage.
            //
            // Property naming mirrors scan_identify_events column
            // names where they overlap so the two surfaces can be
            // joined in PostHog if/when we ship the warehouse pipe.
            //
            // Phase 0d (2026-05-15): perspective-correction geometry
            // expanded out as flat keys for aggregate queries. The
            // server-routed surface carries the same data as a nested
            // jsonb on scan_identify_events; the flat form here makes
            // it queryable as PostHog properties without nested-key
            // path expressions.
            var props: [String: Any] = [
                "trigger_source": triggerSource,
                "source": usedOffline ? "offline" : "network",
                "language": self.scanLanguage.rawValue,
                "confidence": reranked.confidence,
                "winning_path": response.winningPath ?? "nil",
                "top_match_slug": reranked.matches.first?.slug ?? "nil",
                "top_similarity": reranked.matches.first?.similarity ?? 0,
                "ocr_card_number_extracted": !ocrMulti.cardNumbers.isEmpty,
                "ocr_card_numbers_count": ocrMulti.cardNumbers.count,
                "ocr_pass2_fallback_fired": ocrMulti.pass2FallbackFired,
                "ocr_spatial_filter_rejected_count": ocrMulti.spatialFilterRejectedCount,
                "ocr_set_hint_present": ocrMulti.setHint != nil,
                "ocr_frames_used": 1 + additionalOCRFrames.count,
                "ocr_ms": Int(ocrMs),
                "scan_total_ms": Int(scanMs),
                "model_version": response.modelVersion,
            ]
            let perspectivePostHogProps: [String: Any] = perspectiveCorrection?.postHogProperties
                ?? ["ocr_perspective_corrected": false]
            for (k, v) in perspectivePostHogProps { props[k] = v }
            AnalyticsService.shared.capture(.cardScanned, properties: props)
            #if DEBUG
            // Save the EXACT frame the embedder saw to Photos for EVERY
            // scan, including HIGH. HIGH-but-wrong is the worst-case
            // failure (auto-navigate to wrong card with no picker
            // recovery) — pre-2026-05-02 we skipped saving HIGH and
            // lost diagnostic data on those cases. Self-documenting:
            // banner overlay carries the result, top-5, OCR.
            let rerankedResponse = ScanIdentifyResponse(
                ok: response.ok,
                confidence: reranked.confidence,
                matches: reranked.matches,
                languageFilter: response.languageFilter,
                modelVersion: response.modelVersion,
                imageHash: response.imageHash,
                winningPath: response.winningPath,
            )
            ScanDebugCapture.capture(
                image: image,
                response: rerankedResponse,
                source: usedOffline ? .offline : .network,
                ocrCardNumbers: ocrMulti.cardNumbers,
                ocrSetHint: ocrMulti.setHint,
                triggerSource: triggerSource,
                framesUsed: 1 + additionalOCRFrames.count,
                pass2FallbackFired: ocrMulti.pass2FallbackFired,
                spatialFilterRejectedCount: ocrMulti.spatialFilterRejectedCount,
                perspectiveCorrection: perspectiveCorrection,
            )
            // Phase 0d auto-promote: HIGH scans are presumed correct
            // and silently land in scan_eval_images so the 100-card
            // ship test grows the eval corpus with real-device frames.
            // MEDIUM/LOW skipped here — picker-pick path handles
            // MEDIUM with the actual ground-truth slug. See
            // ScanDebugCapture.autoPromoteToEval header for full rules.
            //
            // 2026-05-13 (Codex P2 fix): pass `image` so offline scans
            // route through promoteEvalFromBytes. Without this, every
            // offline HIGH auto-promote 404'd (no scan-uploads object
            // exists for offline-computed hashes) and the eval corpus
            // captured 0 offline cases. Online scans tolerate nil but
            // we pass the bytes uniformly — re-encode cost is trivial.
            if reranked.confidence == "high",
               let hash = response.imageHash,
               let topSlug = reranked.matches.first?.slug {
                ScanDebugCapture.autoPromoteToEval(
                    imageHash: hash,
                    canonicalSlug: topSlug,
                    capturedSource: .userPhoto,
                    notesTag: "auto_high_test:\(triggerSource)",
                    scanImage: image,
                )
            }
            #endif

            // Low-confidence → auto-resume so the user can try again
            // without tapping. High/medium results are handled by the
            // view which navigates (high) or displays matches (medium).
            if reranked.confidence == "low" {
                self.lastMatch = nil
                self.resumeScanning()
            }
        } catch {
            self.isIdentifying = false
            self.identifyError = error.localizedDescription
            // Phase 0c — count error scans against the same event so
            // the HIGH-rate denominator is "all attempted scans" not
            // "successful scans only." Mirrors server emitScanFailureEvent.
            var errorProps: [String: Any] = [
                "trigger_source": triggerSource,
                "source": usedOffline ? "offline" : "network",
                "language": self.scanLanguage.rawValue,
                "confidence": "error",
                "error_message": error.localizedDescription,
                "ocr_card_number_extracted": !ocrMulti.cardNumbers.isEmpty,
                "ocr_card_numbers_count": ocrMulti.cardNumbers.count,
                "ocr_pass2_fallback_fired": ocrMulti.pass2FallbackFired,
                "ocr_spatial_filter_rejected_count": ocrMulti.spatialFilterRejectedCount,
                "ocr_set_hint_present": ocrMulti.setHint != nil,
                "ocr_frames_used": 1 + additionalOCRFrames.count,
            ]
            let errorPerspectiveProps: [String: Any] = perspectiveCorrection?.postHogProperties
                ?? ["ocr_perspective_corrected": false]
            for (k, v) in errorPerspectiveProps { errorProps[k] = v }
            AnalyticsService.shared.capture(.cardScanned, properties: errorProps)
            #if DEBUG
            ScanDebugCapture.capture(
                image: image,
                response: nil,
                source: usedOffline ? .offline : .network,
                ocrCardNumbers: ocrMulti.cardNumbers,
                ocrSetHint: ocrMulti.setHint,
                triggerSource: triggerSource,
                framesUsed: 1 + additionalOCRFrames.count,
                pass2FallbackFired: ocrMulti.pass2FallbackFired,
                spatialFilterRejectedCount: ocrMulti.spatialFilterRejectedCount,
                perspectiveCorrection: perspectiveCorrection,
            )
            #endif
            self.resumeScanning()
        }
    }

    /// Identifies a card from the user's photo library (or any already-
    /// captured UIImage) by feeding it straight through the server
    /// identify pipeline, skipping the Vision rectangle stability gate.
    /// `runIdentify` itself now handles the camera pause + re-entry
    /// guard, so the previous explicit pause here was redundant.
    func runIdentifyFromLibrary(image: UIImage) async {
        await runIdentify(image: image, triggerSource: "library")
    }

    /// Manual-capture path. Snapshots the most recent video frame from
    /// the camera and runs identify on it, bypassing Vision's rectangle
    /// detector entirely. The escape hatch for full-art / VMax / ex
    /// cards whose artwork bleeds to the card border — Vision can't
    /// find an edge gradient on those, so the auto-capture path
    /// silently never fires.
    ///
    /// Returns immediately if the camera hasn't produced a frame yet
    /// (e.g., the session is still warming up) or if the simulator
    /// stub is in use (no frameCapturer hook installed there).
    func captureFrameAndIdentify() async {
        guard let capturer = viewModel?.frameCapturer,
              let primaryFrame = capturer() else {
            return
        }
        // Phase 0d (2026-05-15): the primary frame's perspective-
        // correction geometry is stashed on the engine by
        // `croppedToCard` as a side effect of `detectAndCrop` (which
        // `frameCapturer` calls internally). Read immediately after the
        // primary capturer() call, BEFORE the multi-frame loop below
        // overwrites it with subsequent frames' diagnostics — only the
        // primary frame is what reaches the embedder, so only its
        // perspective geometry is the one we want to attach to this
        // scan. Nil when tap-detect fell back to center-crop (no
        // CIPerspectiveCorrection ran).
        let primaryPerspective = await MainActor.run { self.viewModel?.visionEngine.lastPerspectiveCorrection }
        // Path A (2026-05-05): OCR runs on the same image the embedder
        // sees (the 0.85 center-crop, via frameCapturer) — NOT the full
        // uncropped frame previously routed via captureFullFrame.
        // Real-device data showed Vision text-recognition was
        // dramatically better on the tight crop (100% card_number hit
        // rate vs 33% on the full frame), so we never reverted.
        // captureFullFrame is still installed on the view model but
        // unused.
        //
        // Phase 2 multi-frame consensus (2026-05-08): capture
        // additional frames spaced ~200ms apart so OCR has multiple
        // shots at the card_number under different motion-blur / glare
        // conditions. Video pipeline writes a fresh pixelBuffer at
        // ~60fps, so successive captureCurrentFrame calls return
        // distinct frames. Vote-based card_number selection across the
        // bundle is what closes the single-frame-fragility gap that
        // drove "first-time HIGH felt low" on real device. Auto-detect
        // path keeps single-frame (already async + low-friction;
        // multi-frame would slow it past noticeable).
        let additionalFrameCount = 2  // total = primary + 2 additional = 3
        let interFrameNanos: UInt64 = 200_000_000
        var additionalFrames: [UIImage] = []
        Logger.scan.debug("multiframe BEGIN primary=ok target_additional=\(additionalFrameCount)")
        for i in 0..<additionalFrameCount {
            try? await Task.sleep(nanoseconds: interFrameNanos)
            let frame = capturer()
            if let f = frame {
                additionalFrames.append(f)
                Logger.scan.debug("multiframe iter=\(i) capture=ok size=\(Int(f.size.width))x\(Int(f.size.height))")
            } else {
                Logger.scan.debug("multiframe iter=\(i) capture=NIL — capturer returned nil after \(interFrameNanos / 1_000_000)ms sleep")
            }
        }
        Logger.scan.debug("multiframe END additional_frames=\(additionalFrames.count) of \(additionalFrameCount)")
        await runIdentify(
            image: primaryFrame,
            additionalOCRFrames: additionalFrames,
            triggerSource: additionalFrames.isEmpty ? "tap" : "tap_multiframe",
            perspectiveCorrection: primaryPerspective,
        )
    }

    func resumeScanning() {
        viewModel?.resumeScanning()
        isScanning = viewModel?.isScanning ?? true
    }

    func clearLastRecognized() {
        lastRecognized = nil
    }

    func clearLastMatch() {
        lastMatch = nil
        lastMatches = []
        lastConfidence = nil
        identifyError = nil
        lastImageHash = nil
        lastScanImage = nil
        lastOCR = (nil, nil)
        lastWinningPath = nil
        lastSource = nil
    }
}

// MARK: - ScanMatch → MarketCard converter
// The scan identify response has just enough fields to seed the
// CardDetailView; the view's own .task loads profile + metrics from
// the canonical slug so the zero-tap flow reaches full detail
// fidelity without extra iOS-side work.

// Visibility note: dropped `private` so MultiScanReviewSheet can push
// the same MarketCard-bridged CardDetailView when the user taps a
// tray row. Toplevel extension on a file-scope ScanMatch keeps the
// helper out of the public PopAlphaCore module's surface.
extension ScanMatch {
    func toMarketCard() -> MarketCard {
        MarketCard(
            id: slug,
            name: canonicalName,
            setName: setName ?? "Unknown",
            cardNumber: cardNumber ?? "",
            price: 0,
            changePct: nil,
            changeWindow: "24H",
            rarity: .common,
            sparkline: [0],
            imageGradient: [
                GradientStop(r: 0.1, g: 0.05, b: 0.15),
                GradientStop(r: 0.2, g: 0.1, b: 0.3)
            ],
            imageURL: mirroredPrimaryImageUrl.flatMap { URL(string: $0) },
            confidenceScore: Int((similarity * 100).rounded())
        )
    }
}

// MARK: - Previews

#Preview("Scanner") {
    ScannerTabView()
}
