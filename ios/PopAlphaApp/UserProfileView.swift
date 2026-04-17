import SwiftUI
import NukeUI

// MARK: - User Profile View (for viewing other users)

struct UserProfileView: View {
    let handle: String

    @State private var profile: ProfileService.UserProfile?
    @State private var posts: [ProfileService.ProfilePost] = []
    @State private var stats: ProfileService.ProfileStats?
    @State private var isFollowing = false
    @State private var isLoading = true
    @State private var error: String?
    @State private var followLoading = false

    @State private var activityItems: [ActivityService.ActivityFeedItem] = []
    @State private var selectedSegment: ProfileSegment = .posts

    private var auth: AuthService { AuthService.shared }

    enum ProfileSegment: String, CaseIterable {
        case posts = "Posts"
        case activity = "Activity"
    }

    var body: some View {
        ZStack {
            PA.Colors.background.ignoresSafeArea()

            if isLoading {
                loadingState
            } else if let error {
                errorState(error)
            } else if let profile {
                profileContent(profile)
            }
        }
        .navigationTitle("@\(handle)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PA.Colors.surface, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            await loadProfile()
        }
    }

    // MARK: - Profile Content

    private func profileContent(_ profile: ProfileService.UserProfile) -> some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 20) {
                // Banner
                if let bannerUrl = profile.profileBannerUrl, let url = URL(string: bannerUrl) {
                    LazyImage(url: url) { state in
                        if let image = state.image {
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(height: 120)
                                .clipped()
                        } else {
                            bannerPlaceholder
                        }
                    }
                } else {
                    bannerPlaceholder
                }

                VStack(spacing: 16) {
                    // Avatar + Handle
                    VStack(spacing: 8) {
                        ZStack {
                            Circle()
                                .stroke(PA.Colors.accent.opacity(0.3), lineWidth: 2)
                                .frame(width: 72, height: 72)

                            Circle()
                                .fill(PA.Colors.surfaceSoft)
                                .frame(width: 64, height: 64)
                                .overlay(
                                    Text(String(handle.prefix(1)).uppercased())
                                        .font(.system(size: 24, weight: .bold))
                                        .foregroundStyle(PA.Colors.accent)
                                )
                        }
                        .offset(y: -24)
                        .padding(.bottom, -24)

                        Text("@\(handle)")
                            .font(.system(size: 18, weight: .bold))
                            .foregroundStyle(PA.Colors.text)

                        if let bio = profile.profileBio, !bio.isEmpty {
                            Text(bio)
                                .font(.system(size: 14))
                                .foregroundStyle(PA.Colors.textSecondary)
                                .multilineTextAlignment(.center)
                                .frame(maxWidth: 300)
                        }
                    }

                    // Follow button
                    if handle != auth.currentHandle {
                        Button {
                            Task { await toggleFollow() }
                        } label: {
                            HStack(spacing: 6) {
                                if followLoading {
                                    ProgressView()
                                        .tint(isFollowing ? PA.Colors.muted : PA.Colors.background)
                                        .scaleEffect(0.7)
                                } else {
                                    Image(systemName: isFollowing ? "checkmark" : "plus")
                                        .font(.system(size: 12, weight: .bold))
                                }
                                Text(isFollowing ? "Following" : "Follow")
                                    .font(.system(size: 14, weight: .semibold))
                            }
                            .foregroundStyle(isFollowing ? PA.Colors.text : PA.Colors.background)
                            .padding(.horizontal, 24)
                            .padding(.vertical, 10)
                            .background(isFollowing ? PA.Colors.surfaceSoft : PA.Colors.accent)
                            .clipShape(Capsule())
                            .overlay(
                                isFollowing ? Capsule().stroke(PA.Colors.border, lineWidth: 1) : nil
                            )
                        }
                        .disabled(followLoading)
                    }

                    // Stats
                    if let stats {
                        HStack(spacing: 32) {
                            statItem(value: stats.postCount, label: "Posts")
                            statItem(value: stats.followerCount, label: "Followers")
                            statItem(value: stats.followingCount, label: "Following")
                        }
                        .padding(.vertical, 16)
                        .frame(maxWidth: .infinity)
                        .glassSurface(radius: PA.Layout.panelRadius)
                    }

                    // Segment picker
                    Picker("", selection: $selectedSegment) {
                        ForEach(ProfileSegment.allCases, id: \.self) { segment in
                            Text(segment.rawValue).tag(segment)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, PA.Layout.sectionPadding)

                    // Content
                    switch selectedSegment {
                    case .posts:
                        postsSection
                    case .activity:
                        activitySection
                    }
                }
                .padding(.horizontal, PA.Layout.sectionPadding)
            }
            .padding(.bottom, 32)
        }
    }

    // MARK: - Posts Section

    private var postsSection: some View {
        Group {
            if posts.isEmpty {
                VStack(spacing: 8) {
                    Text("No posts yet")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(PA.Colors.muted)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(posts) { post in
                        postCell(post)
                    }
                }
            }
        }
    }

    private func postCell(_ post: ProfileService.ProfilePost) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(post.body)
                .font(.system(size: 14))
                .foregroundStyle(PA.Colors.text)
                .fixedSize(horizontal: false, vertical: true)

            Text(timeAgo(post.createdAt))
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(PA.Layout.cardPadding)
        .glassSurface()
    }

    // MARK: - Activity Section

    private var activitySection: some View {
        Group {
            if activityItems.isEmpty {
                VStack(spacing: 8) {
                    Text("No activity yet")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(PA.Colors.muted)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
                .task {
                    await loadActivity()
                }
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(activityItems) { item in
                        ActivityEventCell(item: item)
                    }
                }
            }
        }
    }

    // MARK: - Helpers

    private var bannerPlaceholder: some View {
        LinearGradient(
            colors: [PA.Colors.accent.opacity(0.15), PA.Colors.surfaceSoft],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .frame(height: 120)
    }

    private func statItem(value: Int, label: String) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(PA.Colors.text)
            Text(label)
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
        }
    }

    private var loadingState: some View {
        VStack {
            Spacer()
            ProgressView()
                .tint(PA.Colors.accent)
            Spacer()
        }
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)
            Text(message)
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
            Button("Retry") {
                Task { await loadProfile() }
            }
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(PA.Colors.accent)
            Spacer()
        }
    }

    // MARK: - Data

    private func loadProfile() async {
        isLoading = true
        error = nil
        do {
            let (prof, profPosts, profStats) = try await ProfileService.shared.fetchMyProfile()
            // Note: fetchMyProfile returns current user's profile.
            // For viewing other users, we'd need a fetchProfile(handle:) endpoint.
            // For now, we use the profile data and activity endpoints.
            profile = prof
            posts = profPosts
            stats = profStats

            // Check follow status
            isFollowing = try await ProfileService.shared.isFollowing(handle: handle)
        } catch {
            self.error = "Couldn't load profile"
        }
        isLoading = false
    }

    private func loadActivity() async {
        do {
            let (items, _) = try await ActivityService.shared.fetchProfileActivity(handle: handle)
            activityItems = items
        } catch {
            // Silently fail
        }
    }

    private func toggleFollow() async {
        followLoading = true
        let wasFollowing = isFollowing

        // Optimistic
        isFollowing.toggle()

        do {
            if wasFollowing {
                try await ProfileService.shared.unfollowUser(handle: handle)
            } else {
                try await ProfileService.shared.followUser(handle: handle)
            }
            // Update follower count
            if let s = stats {
                stats = ProfileService.ProfileStats(
                    postCount: s.postCount,
                    followerCount: s.followerCount + (wasFollowing ? -1 : 1),
                    followingCount: s.followingCount
                )
            }
        } catch {
            isFollowing = wasFollowing // Revert
        }
        followLoading = false
    }

    private func timeAgo(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: iso) else { return "" }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "now" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        let days = hours / 24
        return "\(days)d"
    }
}
