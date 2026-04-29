import SwiftUI
import NukeUI

/// Shown after a medium-confidence scan when the identifier narrowed
/// the card to a short list but couldn't pick a single winner with
/// high confidence. Lets the user tap the correct match from the
/// top 3 candidates. A tap:
///   1. Fires the promote-to-eval-corpus API so the (image, chosen
///      slug) pair lands in scan_eval_images as a user_correction
///      — this feeds future fine-tuning + eval coverage.
///   2. Navigates into CardDetailView for the chosen card.
///
/// When the sheet closes without a pick ("None of these" or
/// dismiss), the scanner re-arms so the user can try again.
///
/// Only surfaced for confidence == "medium". High-confidence auto-
/// navigates (existing behavior). Low-confidence re-arms silently
/// (the matches are too noisy to be worth showing).
struct ScanPickerSheet: View {
    let matches: [ScanMatch]
    let imageHash: String?
    let scanLanguage: ScanLanguage
    /// What on-device OCR pulled from the captured frame. Used by the
    /// debug overlay (DEBUG-only) so during sprint real-device testing
    /// the operator can see whether Vision actually extracted the
    /// printed collector number / set name. Default-nil keeps the
    /// initializer source-compatible with existing callers.
    var ocrCardNumber: String? = nil
    var ocrSetHint: String? = nil
    /// Day 2 retrieval path that resolved this scan
    /// (`vision_only`, `ocr_direct_unique`, `ocr_direct_narrow`,
    /// `ocr_intersect_unique`, `ocr_intersect_narrow`). Surfaced in the
    /// DEBUG overlay so during sprint real-device testing the operator
    /// can see which signal won — direct DB lookup vs. CLIP+OCR
    /// intersection vs. CLIP-only fallback. Default-nil keeps the
    /// initializer source-compatible with existing callers.
    var winningPath: String? = nil
    let onPick: (ScanMatch) -> Void
    let onDismiss: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var promoting = false

    private var topMatches: [ScanMatch] {
        Array(matches.prefix(3))
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                header
                matchList
                Spacer(minLength: 12)
                #if DEBUG
                ocrDebugStrip
                #endif
                noneOfTheseButton
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 24)
            .background(PA.Colors.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        onDismiss()
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(PA.Colors.muted)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(promoting)
    }

    #if DEBUG
    @ViewBuilder
    private var ocrDebugStrip: some View {
        let numberDisplay = ocrCardNumber?.isEmpty == false ? ocrCardNumber! : "—"
        let hintDisplay = ocrSetHint?.isEmpty == false ? ocrSetHint! : "—"
        let pathDisplay = winningPath?.isEmpty == false ? winningPath! : "—"
        VStack(alignment: .leading, spacing: 4) {
            Text("OCR debug (DEBUG builds only)")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)
            HStack(spacing: 12) {
                Text("card_number: \(numberDisplay)")
                    .font(.system(size: 11, design: .monospaced))
                Text("set_hint: \(hintDisplay)")
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .foregroundStyle(PA.Colors.foreground.opacity(0.7))
            Text("path: \(pathDisplay)")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(PA.Colors.foreground.opacity(0.7))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(PA.Colors.muted.opacity(0.08))
        )
        .padding(.bottom, 12)
    }
    #endif

    // MARK: - Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Which card did you scan?")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
            Text("We narrowed it down but aren't 100% sure. Tap the right one.")
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
        }
        .padding(.bottom, 16)
    }

    private var matchList: some View {
        VStack(spacing: 10) {
            ForEach(Array(topMatches.enumerated()), id: \.element.slug) { index, match in
                Button {
                    handlePick(match)
                } label: {
                    matchRow(match: match, rank: index + 1)
                }
                .buttonStyle(.plain)
                .disabled(promoting)
            }
        }
    }

    private func matchRow(match: ScanMatch, rank: Int) -> some View {
        HStack(spacing: 12) {
            // Rank badge
            Text("\(rank)")
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .foregroundStyle(PA.Colors.muted)
                .frame(width: 22, height: 22)
                .background(PA.Colors.surfaceSoft)
                .clipShape(Circle())

            // Card thumbnail
            if let urlString = match.mirroredPrimaryImageUrl,
               let url = URL(string: urlString) {
                LazyImage(url: url) { state in
                    if let image = state.image {
                        image
                            .resizable()
                            .aspectRatio(63.0 / 88.0, contentMode: .fill)
                    } else {
                        thumbnailPlaceholder
                    }
                }
                .frame(width: 52, height: 73)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            } else {
                thumbnailPlaceholder
                    .frame(width: 52, height: 73)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }

            // Card info
            VStack(alignment: .leading, spacing: 4) {
                Text(match.canonicalName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(1)

                HStack(spacing: 6) {
                    if let setName = match.setName {
                        Text(setName)
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                            .lineLimit(1)
                    }
                    if let number = match.cardNumber {
                        Text("·")
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.border)
                        Text("#\(number)")
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .foregroundStyle(PA.Colors.muted)
                    }
                }

                // Visual similarity indicator — a thin progress bar. We
                // deliberately do NOT show the raw sim number to avoid
                // false precision; the bar is a cue, not a decision.
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(PA.Colors.surfaceSoft)
                        Capsule()
                            .fill(PA.Colors.accent.opacity(0.8))
                            .frame(width: geo.size.width * CGFloat(max(0, min(1, match.similarity))))
                    }
                }
                .frame(height: 3)
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(PA.Colors.muted.opacity(0.5))
        }
        .padding(12)
        .glassSurface(radius: 12)
    }

    private var thumbnailPlaceholder: some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(PA.Colors.surfaceSoft)
            .overlay(
                Image(systemName: "photo")
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.muted.opacity(0.4))
            )
    }

    private var noneOfTheseButton: some View {
        Button {
            onDismiss()
            dismiss()
        } label: {
            Text("None of these — try again")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(PA.Colors.surfaceSoft)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(promoting)
        .padding(.top, 4)
    }

    // MARK: - Actions

    private func handlePick(_ match: ScanMatch) {
        guard !promoting else { return }
        promoting = true
        PAHaptics.tap()

        // Fire-and-forget promote. We don't block the navigation on
        // the promote call — it's bookkeeping, not correctness. If it
        // fails, the user's navigation still succeeds; the eval corpus
        // just doesn't get this sample (we can recover via telemetry
        // image_hash later if needed).
        if let hash = imageHash {
            Task.detached {
                _ = try? await ScanService.promoteEvalFromHash(
                    imageHash: hash,
                    canonicalSlug: match.slug,
                    source: .userCorrection,
                    language: scanLanguage,
                    notes: "picker-sheet-select"
                )
            }
        }

        onPick(match)
        dismiss()
    }
}
