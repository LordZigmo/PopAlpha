import SwiftUI

// MARK: - AI Brief Card
//
// Editorial anchor at the top of the Market tab. Renders the daily AI
// brief with a 3-step expanded body (What's happening / Why it matters /
// What to watch) and a "Matters most for: …" tertiary line that
// personalizes when the reader's style label is known.
//
// Extracted from SignalBoardView.swift so the brief can be rendered
// directly by MarketplaceView in either the guest or authed sequence,
// independently of the rest of the signal-board surface.

struct AIBriefCard: View {
    let brief: HomepageAIBriefDTO?
    let fallbackAsOf: String?
    /// Personalization profile's dominant style label, when known.
    /// Drives the "Your collector style" line in the personalization
    /// strip so the brief feels aimed at the reader, not the whole
    /// market. Nil for guests and for authed users who haven't yet hit
    /// the minimum-event threshold for a profile.
    let styleLabel: String?

    /// In-place expansion state. Tapping "Read more" un-truncates the
    /// summary and reveals the 3-step labeled body without pushing a
    /// new screen. Preserves home-screen context.
    @State private var isExpanded = false

    /// Debug metadata (model, source, generated-at) is hidden by
    /// default to keep the homepage feeling like a product — not a
    /// model-card. A small "About this brief" toggle in the expanded
    /// state reveals it on demand.
    @State private var isMetadataVisible = false

    private var auth: AuthService { AuthService.shared }

    /// Defensive opt-in: AIBriefCard renders in both EN and JP mode.
    /// Reading `\.market` keeps the border/accent aligned with the
    /// active market while the API payload provides the market-specific
    /// copy.
    @Environment(\.market) private var market

    // Placeholder copy used only when the /api/homepage/ai-brief cache is
    // empty (e.g. fresh deploy, cron hasn't run yet). Real briefs come
    // from Gemini via the hourly cron.
    private static let placeholderSummary = "Your AI market brief shows up here once today's data is ready. It tells you which cards and sets are moving, why it matters, and what to watch next."
    private static let placeholderTakeaway = "Updating shortly"

    private var summary: String { brief?.summary ?? Self.placeholderSummary }
    private var takeaway: String { brief?.takeaway ?? Self.placeholderTakeaway }
    private var isLive: Bool { brief != nil && brief?.source != "fallback" }

    /// Returns the 3-step trio iff all three labeled fields are present
    /// on the current brief. Older v1 briefs don't have them yet, so we
    /// fall back to the single `summary` blob in those cases.
    private var threeStep: (whats: String, why: String, watch: String)? {
        guard
            let h = brief?.whatsHappening, !h.isEmpty,
            let w = brief?.whyItMatters,   !w.isEmpty,
            let n = brief?.whatToWatch,    !n.isEmpty
        else { return nil }
        return (h, w, n)
    }
    // MARK: - Personalization strip copy
    //
    // Replaces the old single-line "Matters most for: …" footer. Two
    // short rows make personalization read as a product feature rather
    // than a footnote: a style label and an action hint. Copy adapts
    // to auth + profile state:
    //
    //   • Guest:                 example style + sign-in CTA
    //   • Authed, no profile:    "Building your collector profile"
    //   • Authed, profile known: "<style>" + "Check <focusSet> movers"

    private struct PersonalizationCopy {
        let styleLabel: String       // first row's label
        let styleValue: String       // first row's bold value
        let actionLabel: String      // second row's label
        let actionValue: String      // second row's bold value
        /// True for guests, where the first row should read as an
        /// example rather than a real profile.
        let isExample: Bool
    }

    private var personalizationCopy: PersonalizationCopy {
        let focusSet = brief?.focusSet?.trimmingCharacters(in: .whitespaces)
        let actionValue: String
        if let focusSet, !focusSet.isEmpty {
            actionValue = "Check \(focusSet) movers"
        } else {
            actionValue = "Browse today's movers"
        }

        if !auth.isAuthenticated {
            return PersonalizationCopy(
                styleLabel: "Example style",
                styleValue: "Modern-focused",
                actionLabel: "Personalize",
                actionValue: "Sign in to make this yours",
                isExample: true
            )
        }
        if let styleLabel, !styleLabel.isEmpty {
            return PersonalizationCopy(
                styleLabel: "Your style",
                styleValue: styleLabel,
                actionLabel: "Best next",
                actionValue: actionValue,
                isExample: false
            )
        }
        return PersonalizationCopy(
            styleLabel: "Your style",
            styleValue: "Building profile",
            actionLabel: "Best next",
            actionValue: "Tap cards you like to teach the model",
            isExample: false
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header row
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(market.accent)
                        .accessibilityHidden(true)
                    Text("POPALPHA BRIEF")
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(2.0)
                        .foregroundStyle(market.accent)
                        .accessibilityAddTraits(.isHeader)
                }
                Circle()
                    .fill(isLive ? PA.Colors.positive : PA.Colors.muted)
                    .frame(width: 5, height: 5)
                Text(timestampLabel)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
                Spacer()
            }

            // Body summary. Collapsed → preview the full single-blob
            // summary, line-limited. Expanded → if the brief has labeled
            // 3-step content, render it as three captioned sections; if
            // not (older v1 cached briefs), fall back to the full summary.
            if isExpanded, let trio = threeStep {
                threeStepSummary(trio.whats, trio.why, trio.watch)
            } else {
                // Types the summary out like a typewriter on first
                // appearance. Live briefs only — placeholder/fallback copy
                // appears instantly so a degraded state isn't dressed up.
                BriefTypewriterText(
                    text: summary,
                    lineLimit: isExpanded ? nil : 3,
                    animate: isLive
                )
            }

            // Takeaway chip + toggle (read more ↔ show less)
            HStack(spacing: 10) {
                HStack(spacing: 6) {
                    Text("🔥")
                        .font(.system(size: 11))
                    Text(takeaway)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(market.accent.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(market.accent.opacity(0.2), lineWidth: 0.5)
                )

                Spacer()

                Button {
                    let willExpand = !isExpanded
                    withAnimation(.easeInOut(duration: 0.25)) {
                        isExpanded.toggle()
                    }
                    PAHaptics.tap()
                    // Fire the personalization event only on expansion —
                    // collapsing back doesn't carry intent. Best-effort:
                    // PersonalizationService.track is debounced + batched.
                    if willExpand {
                        Task {
                            await PersonalizationService.shared.track(
                                PersonalizedEvent(type: .aiBriefReadMoreTapped)
                            )
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(isExpanded ? "Show less" : "Read more")
                            .font(.system(size: 12, weight: .semibold))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 10, weight: .bold))
                            .rotationEffect(.degrees(isExpanded ? 180 : 0))
                            .accessibilityHidden(true)
                    }
                    .foregroundStyle(market.accent)
                }
                .buttonStyle(.plain)
                .accessibilityHint(isExpanded ? "Collapses the PopAlpha Brief" : "Expands the full PopAlpha Brief")
            }

            // Personalization proof strip — replaces the old single
            // "Matters most for: …" footer. Always visible so the
            // homepage shows the reader that PopAlpha is adapting to
            // them, not just publishing a generic market readout.
            personalizationStrip

            // Expanded-only "About this brief" disclosure. Reveals the
            // model / source / freshness metadata on demand — not by
            // default. The homepage shouldn't read like a model card.
            if isExpanded {
                aboutThisBriefSection
                    .transition(
                        .opacity.combined(with: .move(edge: .top))
                    )
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .liquidGlassSurface(accent: market.accent)
    }

    // MARK: - Three-step summary (expanded body)
    // Renders the labeled "What's happening / Why it matters / What to
    // watch" trio as three captioned sections. Used when the brief has
    // the 3-step fields populated and the card is expanded.

    private func threeStepSummary(_ whats: String, _ why: String, _ watch: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            threeStepRow(label: "What's happening", text: whats, icon: "dot.circle.fill")
            threeStepRow(label: "Why it matters",   text: why,   icon: "scope")
            threeStepRow(label: "What to watch",    text: watch, icon: "binoculars.fill")
        }
    }

    private func threeStepRow(label: String, text: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(market.accent)
                    .accessibilityHidden(true)
                Text(label.uppercased())
                    .font(.system(size: 10, weight: .bold))
                    .tracking(1.2)
                    .foregroundStyle(market.accent)
            }
            Text(text)
                .font(.system(size: 14))
                .foregroundStyle(PA.Colors.text)
                .lineSpacing(3)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        // Voiceover reads the label and body as a single sentence so
        // screen-reader users don't hear the caption read separately.
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label). \(text)")
    }

    // MARK: - Personalization proof strip
    //
    // Compact 2-row block: a style label and an action hint. Background
    // is a subtle accent tint so the strip reads as a distinct
    // "personalization" surface inside the brief card without becoming
    // a separate panel. Layout stays tight (under 50pt total height).

    private var personalizationStrip: some View {
        let copy = personalizationCopy
        return VStack(alignment: .leading, spacing: 6) {
            personalizationRow(
                eyebrow: copy.styleLabel,
                value: copy.styleValue,
                icon: "scope",
                isMuted: copy.isExample
            )
            personalizationRow(
                eyebrow: copy.actionLabel,
                value: copy.actionValue,
                icon: "arrow.right.circle.fill",
                isMuted: copy.isExample
            )
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(market.accent.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func personalizationRow(
        eyebrow: String,
        value: String,
        icon: String,
        isMuted: Bool
    ) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(market.accent)
                .frame(width: 10)
                .accessibilityHidden(true)
            Text(eyebrow.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(PA.Colors.muted)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(isMuted ? PA.Colors.textSecondary : PA.Colors.text)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(eyebrow): \(value)")
    }

    // MARK: - "About this brief" disclosure
    //
    // The model / focus-set / freshness metadata used to be visible by
    // default at the bottom of the expanded card. That made the card
    // read more like a model debug panel than a product feature. The
    // disclosure here keeps the data accessible to anyone who taps it
    // ("About this brief") but hides the noise on first read.

    @ViewBuilder
    private var aboutThisBriefSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Spacer()
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isMetadataVisible.toggle()
                    }
                    PAHaptics.tap()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "info.circle")
                            .font(.system(size: 10, weight: .semibold))
                            .accessibilityHidden(true)
                        Text(isMetadataVisible ? "Hide details" : "About this brief")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(PA.Colors.muted)
                }
                .buttonStyle(.plain)
                .accessibilityHint(
                    isMetadataVisible
                        ? "Hides model, source, and freshness metadata"
                        : "Shows model, source, and freshness metadata"
                )
            }

            if isMetadataVisible {
                expandedFooter
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    // MARK: - Expanded footer (model / source / freshness)
    //
    // Rendered only when the user explicitly opens "About this brief".
    // No eyebrow header — the disclosure label above already names the
    // section. Kept inside a thin-bordered tile so it visually reads
    // as "metadata in a drawer" rather than primary content.

    private var expandedFooter: some View {
        VStack(alignment: .leading, spacing: 6) {
            metaRow(label: "Model", value: brief?.modelLabel ?? "PopAlpha mix")
            if let focus = brief?.focusSet, !focus.isEmpty {
                metaRow(label: "Focus set", value: focus)
            }
            metaRow(label: "Source", value: (brief?.source ?? "fallback").capitalized)
            metaRow(label: "Data as of", value: formatRelative(brief?.dataAsOf ?? fallbackAsOf))
            metaRow(label: "Generated", value: formatRelative(brief?.generatedAt ?? fallbackAsOf))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PA.Colors.surface.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func metaRow(label: String, value: String) -> some View {
        HStack(spacing: 10) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
                .frame(width: 78, alignment: .leading)
            Text(value)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(PA.Colors.textSecondary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
    }

    private func formatRelative(_ iso: String?) -> String {
        guard let iso else { return "—" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }
        let minutes = Int(-date.timeIntervalSinceNow / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        return "\(hours / 24)d ago"
    }

    private var timestampLabel: String {
        let source = brief?.generatedAt ?? fallbackAsOf
        guard let source else { return "Updating" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: source) ?? ISO8601DateFormatter().date(from: source)
        guard let date else { return "Updating" }
        let minutes = Int(-date.timeIntervalSinceNow / 60)
        if minutes < 1 { return "Updated just now" }
        if minutes < 60 { return "Updated \(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "Updated \(hours)h ago" }
        return "Updated \(hours / 24)d ago"
    }
}

// MARK: - Typewriter text
//
// Types the brief summary out character-by-character on first appearance so
// the homepage's editorial anchor reads as if it's being written live. The
// final height is reserved up front (a hidden full-text layer) so the card
// never reflows as characters appear. Per-character speed scales to the
// paragraph length — a short brief stays readable, a long one never drags —
// and Reduce Motion (or `animate: false`) shows the full text immediately.
private struct BriefTypewriterText: View {
    let text: String
    var lineLimit: Int?
    var animate: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shownCount = 0

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Invisible full-text layer reserves the final height.
            styled(Text(verbatim: text)).hidden()
            styled(Text(verbatim: typedPrefix))
        }
        // Re-runs when the brief text changes (placeholder → live), so the
        // real summary types in once it loads.
        .task(id: text) { await typeOut() }
    }

    private func styled(_ text: Text) -> some View {
        text
            .font(.system(size: 14))
            .foregroundStyle(PA.Colors.text)
            .lineSpacing(3)
            .lineLimit(lineLimit)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var typedPrefix: String {
        guard shownCount < text.count else { return text }
        return String(text.prefix(shownCount))
    }

    private func typeOut() async {
        // Reduce Motion, opt-out, or trivial strings: show instantly.
        guard animate, !reduceMotion, text.count > 1 else {
            shownCount = text.count
            return
        }
        // Aim for the whole paragraph to finish in ~2.2s, clamped so short
        // briefs aren't instant and long ones don't crawl.
        let perChar = min(0.045, max(0.011, 2.2 / Double(text.count)))
        let step = UInt64(perChar * 1_000_000_000)
        shownCount = 0
        var shown = 0
        while shown < text.count {
            shown += 1
            shownCount = shown
            try? await Task.sleep(nanoseconds: step)
            if Task.isCancelled {
                shownCount = text.count
                return
            }
        }
        shownCount = text.count
    }
}

#Preview("PopAlpha Brief — placeholder") {
    AIBriefCard(brief: nil, fallbackAsOf: nil, styleLabel: nil)
        .padding()
        .background(PA.Colors.background)
}
