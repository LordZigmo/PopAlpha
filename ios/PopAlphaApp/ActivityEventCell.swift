import SwiftUI
import NukeUI

struct ActivityEventCell: View {
    let item: ActivityService.ActivityFeedItem

    // Interaction callbacks (nil = non-interactive)
    var onLikeTap: ((Int) -> Void)?
    var onCommentTap: ((ActivityService.ActivityFeedItem) -> Void)?
    var onCardTap: ((String) -> Void)?
    var onHandleTap: ((String) -> Void)?
    var onReportTap: ((ActivityService.ActivityFeedItem) -> Void)?
    var onBlockTap: ((ActivityService.ActivityFeedItem) -> Void)?

    private var isOwn: Bool {
        item.actor.id == AuthService.shared.currentUserId
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Avatar — tappable
            Button {
                onHandleTap?(item.actor.handle)
            } label: {
                ActorAvatarView(url: item.actor.avatarURL, initial: item.actor.initial, size: 36)
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

                    Spacer()

                    if !isOwn, onReportTap != nil || onBlockTap != nil {
                        Menu {
                            if onReportTap != nil {
                                Button {
                                    onReportTap?(item)
                                } label: {
                                    Label("Report activity", systemImage: "flag")
                                }
                            }
                            if onBlockTap != nil {
                                Button(role: .destructive) {
                                    onBlockTap?(item)
                                } label: {
                                    Label("Block @\(item.actor.handle)", systemImage: "hand.raised")
                                }
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(PA.Colors.muted)
                                .frame(width: 24, height: 20)
                                .contentShape(Rectangle())
                        }
                        .accessibilityLabel("More options for @\(item.actor.handle)'s activity")
                    }
                }
            }
        }
        .padding(PA.Layout.cardPadding)
        .glassSurface()
    }
}

// MARK: - Actor Avatar

/// Avatar for activity surfaces (feed, notifications, profile headers):
/// the user's PopAlpha-stored picture when set, otherwise a handle-initial
/// monogram. Mirrors the web `ActorAvatar` fallback so both platforms render
/// the same person identically.
struct ActorAvatarView: View {
    let url: URL?
    let initial: String
    var size: CGFloat = 36

    var body: some View {
        Group {
            if let url {
                LazyImage(url: url) { state in
                    if let image = state.image {
                        image.resizable().aspectRatio(contentMode: .fill)
                    } else {
                        monogram
                    }
                }
            } else {
                monogram
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    private var monogram: some View {
        Text(initial)
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundStyle(PA.Colors.text)
            .frame(width: size, height: size)
            .background(PA.Colors.surfaceSoft)
    }
}
