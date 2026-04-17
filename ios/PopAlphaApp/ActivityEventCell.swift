import SwiftUI
import NukeUI

struct ActivityEventCell: View {
    let item: ActivityService.ActivityFeedItem

    // Interaction callbacks (nil = non-interactive)
    var onLikeTap: ((Int) -> Void)?
    var onCommentTap: ((ActivityService.ActivityFeedItem) -> Void)?
    var onCardTap: ((String) -> Void)?
    var onHandleTap: ((String) -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Avatar — tappable
            Button {
                onHandleTap?(item.actor.handle)
            } label: {
                Text(item.actor.avatarInitial)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .frame(width: 36, height: 36)
                    .background(PA.Colors.surfaceSoft)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 6) {
                // Action text — handle is tappable
                HStack(spacing: 0) {
                    Button {
                        onHandleTap?(item.actor.handle)
                    } label: {
                        Text("@\(item.actor.handle) ")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(PA.Colors.text)
                    }
                    .buttonStyle(.plain)

                    Text(item.actionText)
                        .font(.system(size: 14))
                        .foregroundStyle(PA.Colors.textSecondary)
                        .lineLimit(2)
                }

                // Card thumbnail — tappable
                if item.hasCardImage, let url = item.cardImageURL {
                    Button {
                        if let slug = item.canonicalSlug {
                            onCardTap?(slug)
                        }
                    } label: {
                        LazyImage(url: url) { state in
                            if let image = state.image {
                                image
                                    .resizable()
                                    .aspectRatio(63.0 / 88.0, contentMode: .fit)
                                    .frame(width: 60)
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            } else {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(PA.Colors.surfaceSoft)
                                    .frame(width: 60, height: 84)
                            }
                        }
                        .padding(.top, 2)
                    }
                    .buttonStyle(.plain)

                    if let setName = item.setName {
                        Text(setName)
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                    }
                }

                // Footer: time + interactive like/comment buttons
                HStack(spacing: 12) {
                    Text(item.timeAgo)
                        .font(PA.Typography.caption)
                        .foregroundStyle(PA.Colors.muted)

                    // Like button
                    Button {
                        onLikeTap?(item.id)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: item.likedByMe ? "heart.fill" : "heart")
                                .font(.system(size: 12))
                                .foregroundStyle(item.likedByMe ? PA.Colors.negative : PA.Colors.muted)
                            if item.likeCount > 0 {
                                Text("\(item.likeCount)")
                                    .font(PA.Typography.caption)
                                    .foregroundStyle(item.likedByMe ? PA.Colors.negative : PA.Colors.muted)
                            }
                        }
                    }
                    .buttonStyle(.plain)

                    // Comment button
                    Button {
                        onCommentTap?(item)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "bubble.right")
                                .font(.system(size: 12))
                                .foregroundStyle(PA.Colors.muted)
                            if item.commentCount > 0 {
                                Text("\(item.commentCount)")
                                    .font(PA.Typography.caption)
                                    .foregroundStyle(PA.Colors.muted)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(PA.Layout.cardPadding)
        .glassSurface()
    }
}
