// ScanQuotaWarningToast.swift
//
// Soft-friction warning element shown at the bottom of the scanner
// viewport when a free user's daily quota is running out (remaining
// <= 1) or fully exhausted (remaining == 0). Despite the "Toast"
// name, this is now mounted PERSISTENTLY by ScannerTabView — visible
// for the whole time the conditions hold rather than auto-dismissing
// after a few seconds. The earlier timed-toast version raced with
// post-scan navigation: a successful scan immediately pushes
// CardDetailView, so the toast animated in on a view the user
// wasn't looking at. Persistent visibility solves that — the user
// always sees the warning when they're on the scanner near/at the
// limit.
//
// Mounting + condition logic lives in ScannerTabView; this view is
// presentational only.

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
                    Text(subtitle)
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
        switch remaining {
        case 0:  return "Daily limit reached"
        case 1:  return "1 scan left today"
        default: return "\(remaining) scans left today"
        }
    }

    private var subtitle: String {
        remaining == 0
            ? "Tap to upgrade and keep scanning"
            : "Tap to keep scanning unlimited"
    }
}
