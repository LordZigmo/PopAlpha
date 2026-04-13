import SwiftUI

// MARK: - Activity Comment Sheet

struct ActivityCommentSheet: View {
    let eventId: Int
    let eventActorHandle: String

    @Environment(\.dismiss) private var dismiss

    @State private var comments: [ActivityService.ActivityComment] = []
    @State private var isLoading = true
    @State private var error: String?
    @State private var commentText = ""
    @State private var isPosting = false
    @FocusState private var isInputFocused: Bool

    private let maxLength = 500

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
                    } else if comments.isEmpty {
                        emptyState
                    } else {
                        commentList
                    }

                    Divider().background(PA.Colors.border)

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
        }
    }

    // MARK: - Comment List

    private var commentList: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(comments) { comment in
                    commentRow(comment)
                    if comment.id != comments.last?.id {
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
        HStack(alignment: .top, spacing: 10) {
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
        do {
            if let comment = try await ActivityService.shared.postComment(eventId: eventId, body: body) {
                comments.append(comment)
                commentText = ""
            }
        } catch {
            // Could show an alert here
        }
        isPosting = false
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
