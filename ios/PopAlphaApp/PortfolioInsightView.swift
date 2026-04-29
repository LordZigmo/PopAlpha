import SwiftUI

// MARK: - Portfolio Insight View
// AI insights + collection evolution timeline.

struct PortfolioInsightView: View {
    let insights: [PortfolioInsight]
    let activities: [PortfolioActivity]
    /// Render the AI insights block. Default true; pass false to render
    /// only the Evolution timeline (used when Evolution is positioned
    /// independently at the bottom of the page).
    var showInsights: Bool = true
    /// Render the Evolution timeline. Default true; pass false to render
    /// only the AI insights (used when Evolution moves to the bottom).
    var showActivity: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if showInsights && !insights.isEmpty {
                insightsSection
            }
            if showActivity && !activities.isEmpty {
                activitySection
            }
        }
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    // MARK: - Insights Section

    private var insightsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "brain.head.profile")
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.accent)
                Text("PopAlpha Insights")
                    .font(PA.Typography.sectionTitle)
                    .foregroundStyle(PA.Colors.text)
            }

            VStack(spacing: 8) {
                ForEach(insights) { insight in
                    insightRow(insight)
                }
            }
        }
    }

    private func insightRow(_ insight: PortfolioInsight) -> some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 1)
                .fill(PA.Colors.accent)
                .frame(width: 3)

            Text(insight.text)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(PA.Colors.textSecondary)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface()
    }

    // MARK: - Activity / Evolution Section

    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.accent)
                Text("Evolution")
                    .font(PA.Typography.sectionTitle)
                    .foregroundStyle(PA.Colors.text)
            }

            VStack(spacing: 0) {
                ForEach(Array(activities.enumerated()), id: \.element.id) { index, activity in
                    activityRow(activity)

                    if index < activities.count - 1 {
                        Divider()
                            .background(PA.Colors.border)
                            .padding(.leading, 54)
                    }
                }
            }
            .glassSurface()
        }
    }

    private func activityRow(_ activity: PortfolioActivity) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle()
                    .fill(PA.Colors.surfaceSoft)
                    .frame(width: 28, height: 28)
                Image(systemName: activity.icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(activity.title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                    Spacer()
                    Text(activity.timeAgo)
                        .font(.system(size: 11))
                        .foregroundStyle(PA.Colors.muted)
                }

                Text(activity.description)
                    .font(.system(size: 12))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
