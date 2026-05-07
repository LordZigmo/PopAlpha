import SwiftUI

// MARK: - Activity Comment Sheet

struct ActivityCommentSheet: View {
    let eventId: Int
    let eventActorHandle: String

    @Environment(\.dismiss) private var dismiss
    @StateObject private var blockedStore = BlockedUsersStore.shared

    @State private var comments: [ActivityService.ActivityComment] = []
    @State private var isLoading = true
    @State private var error: String?
    @State private var commentText = ""
    @State private var isPosting = false
    @State private var postError: String?
    @State private var reportTarget: ReportTargetIdentifier?
    @State private var blockConfirm: BlockTargetIdentifier?
    @FocusState private var isInputFocused: Bool

    private let maxLength = 500

    private var visibleComments: [ActivityService.ActivityComment] {
        comments.filter { !blockedStore.isBlocked($0.author.id) }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                PA.Colors.background.ignoresSafeArea()

                VStack(spacing: 0) {
                    // Comment list
                    if isLoading {
                        loadingState
                    } else if let error {
                        errorState(error)
                    } else if visibleComments.isEmpty {
                        emptyState
                    } else {
                        commentList
                    }

                    Divider().background(PA.Colors.border)

                    if let postError {
                        Text(postError)
                            .font(.system(size: 12))
                            .foregroundStyle(.red)
                            .padding(.horizontal, 16)
                            .padding(.top, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityLabel("Post error: \(postError)")
                    }

                    // Input bar
                    inputBar
                }
            }
            .navigationTitle("Comments")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(PA.Colors.accent)
                }
            }
            .toolbarBackground(PA.Colors.surface, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .task {
                await loadComments()
            }
            .sheet(item: $reportTarget) { target in
                ReportSheet(
                    targetKind: target.kind,
                    targetId: target.targetId,
                    targetLabel: target.label,
                )
            }
            .alert(
                "Block @\(blockConfirm?.handle ?? "")?",
                isPresented: Binding(
                    get: { blockConfirm != nil },
                    set: { if !$0 { blockConfirm = nil } },
                ),
                presenting: blockConfirm,
            ) { target in
                Button("Block", role: .destructive) {
                    Task { await performBlock(target) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("They won't be able to comment on or see your activity. You can unblock anytime in Settings.")
            }
        }
    }

    // MARK: - Comment List

    private var commentList: some View {
        let rows = visibleComments
        return ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(rows) { comment in
                    commentRow(comment)
                    if comment.id != rows.last?.id {
                        Divider()
                            .background(PA.Colors.border)
                            .padding(.leading, 52)
                    }
                }
            }
            .padding(.top, 8)
        }
    }

    private func commentRow(_ comment: ActivityService.ActivityComment) -> some View {
        let isOwn = comment.author.id == AuthService.shared.currentUserId
        return HStack(alignment: .top, spacing: 10) {
            // Avatar
            Text(comment.author.avatarInitial)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
                .frame(width: 30, height: 30)
                .background(PA.Colors.surfaceSoft)
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text("@\(comment.author.handle)")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)

                    Text(timeAgo(comment.createdAt))
                        .font(PA.Typography.caption)
                        .foregroundStyle(PA.Colors.muted)
                }

                Text(comment.body)
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            if !isOwn {
                Menu {
                    Button {
                        reportTarget = ReportTargetIdentifier(
                            kind: .comment,
                            targetId: String(comment.id),
                            label: "@\(comment.author.handle): \(comment.body)",
                        )
                    } label: {
                        Label("Report comment", systemImage: "flag")
                    }
                    Button(role: .destructive) {
                        blockConfirm = BlockTargetIdentifier(
                            userId: comment.author.id,
                            handle: comment.author.handle,
                        )
                    } label: {
                        Label("Block @\(comment.author.handle)", systemImage: "hand.raised")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.muted)
                        .padding(8)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("More options for @\(comment.author.handle)'s comment")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(spacing: 10) {
            TextField("Add a comment...", text: $commentText, axis: .vertical)
                .font(.system(size: 14))
                .foregroundStyle(PA.Colors.text)
                .lineLimit(1...4)
                .focused($isInputFocused)
                .padding(10)
                .background(PA.Colors.surfaceSoft)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .onSubmit {
                    Task { await postComment() }
                }

            if !commentText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button {
                    Task { await postComment() }
                } label: {
                    if isPosting {
                        ProgressView()
                            .tint(PA.Colors.accent)
                            .scaleEffect(0.8)
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(PA.Colors.accent)
                    }
                }
                .disabled(isPosting || commentText.count > maxLength)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(PA.Colors.surface)
    }

    // MARK: - States

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
                .font(.system(size: 24))
                .foregroundStyle(PA.Colors.muted)
            Text(message)
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
            Button("Retry") {
                Task { await loadComments() }
            }
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(PA.Colors.accent)
            Spacer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "bubble.right")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)

            Text("No comments yet")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(PA.Colors.text)

            Text("Be the first to comment on @\(eventActorHandle)'s activity.")
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 240)
            Spacer()
        }
    }

    // MARK: - Data

    private func loadComments() async {
        isLoading = true
        error = nil
        do {
            comments = try await ActivityService.shared.fetchComments(eventId: eventId)
        } catch {
            self.error = "Couldn't load comments"
        }
        isLoading = false
    }

    private func postComment() async {
        let body = commentText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, body.count <= maxLength else { return }

        isPosting = true
        postError = nil
        do {
            if let comment = try await ActivityService.shared.postComment(eventId: eventId, body: body) {
                comments.append(comment)
                commentText = ""
            }
        } catch APIError.httpError(_, let body) {
            postError = body.isEmpty ? "Couldn't post comment." : body
        } catch {
            postError = "Couldn't post comment. Please try again."
        }
        isPosting = false
    }

    private func performBlock(_ target: BlockTargetIdentifier) async {
        do {
            try await APIClient.blockUser(target.userId)
            blockedStore.recordBlock(target.userId)
        } catch {
            // Soft-fail: server-side filtering is authoritative on next refetch.
            // Could surface an alert here in a future polish pass.
        }
    }

    // MARK: - Helpers

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
