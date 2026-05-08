// ScanQuotaWarningToast.swift
//
// One-shot soft-friction toast that fires AFTER a free user's 4th
// scan of the day, before they hit the hard wall on scan #5. Shown
// in the same bottom-center slot as the identify status toast (but
// only when no identify is in flight) for ~4 seconds, with a single
// tap target that opens the paywall.
//
// Why before the wall, not after: hard walls convert when users are
// motivated, but a meaningful tail bounces silently when they hit a
// wall they didn't see coming. Surfacing the soft warning at scan #4
// catches users mid-engagement and gives the paywall a chance to
// land while their intent is still high.
//
// Trigger logic + once-per-day suppression live in ScannerTabView;
// this view is presentational only.

import SwiftUI

struct ScanQuotaWarningToast: View {
    let remaining: Int
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(PA.Colors.gold.opacity(0.95))

                VStack(alignment: .leading, spacing: 2) {
                    Text(headline)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                    Text("Tap to keep scanning unlimited")
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.7))
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.6))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(PA.Colors.gold.opacity(0.4), lineWidth: 1)
            )
            .shadow(color: PA.Colors.gold.opacity(0.18), radius: 14, x: 0, y: 6)
            .shadow(color: .black.opacity(0.3), radius: 18, x: 0, y: 10)
        }
        .buttonStyle(.plain)
    }

    private var headline: String {
        if remaining == 1 { return "1 scan left today" }
        return "\(remaining) scans left today"
    }
}
