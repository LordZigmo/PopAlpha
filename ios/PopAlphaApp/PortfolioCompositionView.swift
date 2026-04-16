import SwiftUI

// MARK: - Portfolio Composition View
// Era/category breakdowns + "What Defines You" attribute pills.

struct PortfolioCompositionView: View {
    let composition: PortfolioComposition
    let attributes: [PortfolioAttribute]

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {

            // MARK: Composition

            sectionHeader("Your Collection", icon: "chart.bar.fill")

            VStack(alignment: .leading, spacing: 12) {
                Text("By Era")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.textSecondary)

                stackedBar(segments: composition.byEra)
                legendGrid(segments: composition.byEra)
            }
            .padding(16)
            .glassSurface()

            VStack(alignment: .leading, spacing: 12) {
                Text("By Category")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.textSecondary)

                stackedBar(segments: composition.byCategory)
                legendGrid(segments: composition.byCategory)
            }
            .padding(16)
            .glassSurface()

            // MARK: Attributes

            sectionHeader("What Defines You", icon: "sparkles")

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(attributes) { attr in
                        attributeCard(attr)
                    }
                }
            }
        }
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    // MARK: - Section Header

    private func sectionHeader(_ title: String, icon: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(PA.Colors.accent)
            Text(title)
                .font(PA.Typography.sectionTitle)
                .foregroundStyle(PA.Colors.text)
        }
    }

    // MARK: - Stacked Bar

    private func stackedBar(segments: [AllocationSegment]) -> some View {
        GeometryReader { geo in
            let gap = CGFloat(max(0, segments.count - 1)) * 2
            let available = geo.size.width - gap

            HStack(spacing: 2) {
                ForEach(segments) { seg in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(seg.color)
                        .frame(width: max(4, available * seg.value))
                }
            }
        }
        .frame(height: 8)
    }

    // MARK: - Legend

    private func legendGrid(segments: [AllocationSegment]) -> some View {
        let columns = Array(repeating: GridItem(.flexible(), alignment: .leading), count: 2)

        return LazyVGrid(columns: columns, spacing: 6) {
            ForEach(segments) { seg in
                HStack(spacing: 6) {
                    Circle()
                        .fill(seg.color)
                        .frame(width: 6, height: 6)
                    Text(seg.label)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(PA.Colors.textSecondary)
                        .lineLimit(1)
                    Spacer()
                    Text("\(Int(seg.value * 100))%")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(PA.Colors.text)
                }
            }
        }
    }

    // MARK: - Attribute Card

    private func attributeCard(_ attr: PortfolioAttribute) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: attr.icon)
                .font(.system(size: 14))
                .foregroundStyle(PA.Colors.accent)

            Text(attr.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
                .lineLimit(1)

            Text(attr.subtitle)
                .font(.system(size: 11))
                .foregroundStyle(PA.Colors.muted)
                .lineLimit(2)
        }
        .frame(width: 140, alignment: .leading)
        .padding(12)
        .glassSurface(radius: PA.Layout.pillRadius)
    }
}
