import SwiftUI

struct ActivityFeedView: View {
    @State private var items: [ActivityService.ActivityFeedItem] = []
    @State private var nextCursor: Int?
    @State private var loading = false
    @State private var loadingMore = false
    @State private var error: String?

    // Sheet/navigation targets
    @State private var commentTarget: ActivityService.ActivityFeedItem?
    @State private var profileHandle: String?
    @State private var navigateToProfile = false

    private var auth: AuthService { AuthService.shared }

    var body: some View {
        NavigationStack {
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 0) {
                    headerSection

                    if loading && items.isEmpty {
                        skeletonList
                    } else if let error, items.isEmpty {
                        errorState(error)
                    } else if items.isEmpty {
                        emptyState
                    } else {
                        feedList
                    }

                    Spacer(minLength: 100)
                }
            }
            .background(PA.Colors.background)
            // .task(id:) prevents the feed from reloading (and
            // resetting scroll) every time the user pops back from a
            // pushed detail view. See SetDetailView.swift for the full
            // rationale. Pull-to-refresh still covers manual refreshes.
            .task(id: auth.isAuthenticated) {
                await loadFeed()
            }
            .refreshable {
                await loadFeed()
            }
            .sheet(item: $commentTarget) { item in
                ActivityCommentSheet(eventId: item.id, eventActorHandle: item.actor.handle)
            }
            .navigationDestination(isPresented: $navigateToProfile) {
                if let handle = profileHandle {
                    UserProfileView(handle: handle)
                }
            }
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Activity")
                .font(PA.Typography.sectionTitle)
                .foregroundStyle(PA.Colors.text)

            Text("See what collectors you follow are up to")
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, PA.Layout.sectionPadding)
        .padding(.top, PA.Layout.sectionPadding)
        .padding(.bottom, 12)
    }

    // MARK: - Feed List

    private var feedList: some View {
        LazyVStack(spacing: 10) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                ActivityEventCell(
                    item: item,
                    onLikeTap: { eventId in handleLike(eventId: eventId) },
                    onCommentTap: { target in commentTarget = target },
                    onCardTap: { _ in /* Card navigation handled by parent if needed */ },
                    onHandleTap: { handle in
                        profileHandle = handle
                        navigateToProfile = true
                    }
                )
                .onAppear {
                    // Infinite scroll — load more when last item appears
                    if index == items.count - 1, nextCursor != nil, !loadingMore {
                        Task { await loadMore() }
                    }
                }
            }

            if loadingMore {
                ProgressView()
                    .tint(PA.Colors.accent)
                    .padding(.vertical, 20)
            }
        }
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    // MARK: - Sign-in Prompt

    private var signInPrompt: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.crop.circle.badge.plus")
                .font(.system(size: 36))
                .foregroundStyle(PA.Colors.accent)

            Text("Sign in to see activity")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(PA.Colors.text)

            Text("Follow collectors and see their pickups, milestones, and collection activity.")
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)

            Button {
                AuthService.shared.signIn()
            } label: {
                Text("Sign In")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PA.Colors.background)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 12)
                    .background(PA.Colors.accent)
                    .clipShape(Capsule())
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 80)
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "person.2")
                .font(.system(size: 32))
                .foregroundStyle(PA.Colors.muted)

            Text("Your feed is quiet")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(PA.Colors.text)

            Text(auth.isAuthenticated
                 ? "Follow collectors to see their pickups, milestones, and collection activity here."
                 : "Sign in and follow collectors to see their pickups, milestones, and collection activity.")
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 260)

            if !auth.isAuthenticated {
                Button {
                    AuthService.shared.signIn()
                } label: {
                    Text("Sign In")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.accent)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                        .background(PA.Colors.accent.opacity(0.12))
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 80)
    }

    // MARK: - Skeleton

    private var skeletonList: some View {
        VStack(spacing: 12) {
            ForEach(0..<4, id: \.self) { _ in
                skeletonCell
            }
        }
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    private var skeletonCell: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(PA.Colors.surfaceSoft)
                .frame(width: 36, height: 36)

            VStack(alignment: .leading, spacing: 8) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(PA.Colors.surfaceSoft)
                    .frame(height: 14)
                    .frame(maxWidth: .infinity)

                RoundedRectangle(cornerRadius: 4)
                    .fill(PA.Colors.surfaceSoft.opacity(0.6))
                    .frame(width: 120, height: 12)
            }
        }
        .padding(PA.Layout.cardPadding)
        .glassSurface()
    }

    // MARK: - Error State

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)
            Text(message)
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
            Button("Try Again") {
                Task { await loadFeed() }
            }
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(PA.Colors.accent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    // MARK: - Data Loading

    private func loadFeed() async {
        guard auth.isAuthenticated else {
            loading = false
            return
        }
        loading = items.isEmpty
        error = nil
        do {
            let (feedItems, cursor) = try await ActivityService.shared.fetchFeed()
            items = feedItems
            nextCursor = cursor
        } catch {
            self.error = "Couldn't load activity"
        }
        loading = false
    }

    private func loadMore() async {
        guard let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        do {
            let (moreItems, newCursor) = try await ActivityService.shared.fetchFeed(cursor: cursor)
            items.append(contentsOf: moreItems)
            nextCursor = newCursor
        } catch {
            // Silently fail on pagination errors
        }
        loadingMore = false
    }

    // MARK: - Interactions

    private func handleLike(eventId: Int) {
        // Optimistic UI
        guard let index = items.firstIndex(where: { $0.id == eventId }) else { return }
        let wasLiked = items[index].likedByMe
        let oldCount = items[index].likeCount

        // We need to create a new item with toggled state since ActivityFeedItem is a struct
        // For optimistic update, we mutate through a mutable copy
        var updated = items
        updated[index] = toggledItem(items[index])
        items = updated

        Task {
            do {
                let (liked, count) = try await ActivityService.shared.toggleLike(eventId: eventId)
                // Reconcile with server state
                if let idx = items.firstIndex(where: { $0.id == eventId }) {
                    var reconciled = items
                    reconciled[idx] = reconciledItem(items[idx], liked: liked, likeCount: count)
                    items = reconciled
                }
            } catch {
                // Revert optimistic update
                if let idx = items.firstIndex(where: { $0.id == eventId }) {
                    var reverted = items
                    reverted[idx] = reconciledItem(items[idx], liked: wasLiked, likeCount: oldCount)
                    items = reverted
                }
            }
        }
    }

    /// Create a copy of the item with toggled like state
    private func toggledItem(_ item: ActivityService.ActivityFeedItem) -> ActivityService.ActivityFeedItem {
        reconciledItem(
            item,
            liked: !item.likedByMe,
            likeCount: item.likedByMe ? max(0, item.likeCount - 1) : item.likeCount + 1
        )
    }

    /// Create a copy with specific like state — uses JSON round-trip since all fields are `let`
    private func reconciledItem(
        _ item: ActivityService.ActivityFeedItem,
        liked: Bool,
        likeCount: Int
    ) -> ActivityService.ActivityFeedItem {
        // Build a minimal JSON dict manually (avoids needing Encodable on ActivityFeedItem)
        let actorDict: [String: Any] = [
            "id": item.actor.id,
            "handle": item.actor.handle,
            "avatar_initial": item.actor.avatarInitial
        ]

        var dict: [String: Any] = [
            "id": item.id,
            "actor": actorDict,
            "event_type": item.eventType,
            "created_at": item.createdAt,
            "like_count": likeCount,
            "comment_count": item.commentCount,
            "liked_by_me": liked
        ]

        if let slug = item.canonicalSlug { dict["canonical_slug"] = slug }
        if let name = item.cardName { dict["card_name"] = name }
        if let img = item.cardImageUrl { dict["card_image_url"] = img }
        if let set = item.setName { dict["set_name"] = set }
        if let target = item.targetUser {
            dict["target_user"] = ["id": target.id, "handle": target.handle]
        }

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let updated = try? decoder.decode(ActivityService.ActivityFeedItem.self, from: data)
        else {
            return item
        }

        return updated
    }
}
