import SwiftUI

// MARK: - Email Sign-In Sheet
//
// Two-phase email-code sign-in for users without an Apple ID / Google
// account, plus the App Review demo-account path (reviewer enters the
// test email + receives a code from Clerk's email service).
//
// Phase 1 (.email): user types email → tap "Send Code" → AuthService
//   asks Clerk to start a sign-in attempt and email a 6-digit code.
// Phase 2 (.code):  user types the 6-digit code → tap "Verify" → on
//   success the session is created, AuthService runs the shared
//   post-session plumbing, and the sheet dismisses (the underlying
//   guest UI re-renders as authenticated).

struct EmailSignInSheet: View {
    @Environment(\.dismiss) private var dismiss

    enum Phase: Equatable { case email, code }

    @State private var phase: Phase = .email
    @State private var email: String = ""
    @State private var code: String = ""
    @State private var isSending: Bool = false
    @State private var isVerifying: Bool = false
    @State private var errorMessage: String?

    @FocusState private var emailFocused: Bool
    @FocusState private var codeFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Spacer()
                heroSection
                Spacer()

                switch phase {
                case .email: emailPhase
                case .code:  codePhase
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(PA.Colors.negative)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                        .padding(.top, 12)
                }

                Spacer(minLength: 24)
            }
            .padding(.bottom, 24)
            .background(PA.Colors.background.ignoresSafeArea())
            .navigationTitle(phase == .email ? "Sign In" : "Enter Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                if phase == .code {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            // Roll back to phase 1; clear code + error.
                            // The Clerk SignIn attempt remains valid until
                            // resent, which is fine — phase 1 will start
                            // a fresh one if the user changes the email.
                            withAnimation { phase = .email }
                            code = ""
                            errorMessage = nil
                        } label: {
                            Image(systemName: "chevron.left")
                            Text("Back")
                        }
                    }
                }
            }
            .onAppear {
                if phase == .email {
                    emailFocused = true
                }
            }
        }
    }

    // MARK: - Hero

    private var heroSection: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(PA.Colors.accent.opacity(0.15))
                    .frame(width: 72, height: 72)
                Image(systemName: phase == .email ? "envelope.fill" : "number.circle.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
            }

            VStack(spacing: 8) {
                Text(phase == .email ? "Sign in with email" : "Check your email")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(PA.Colors.text)
                    .multilineTextAlignment(.center)

                Text(
                    phase == .email
                    ? "We'll email you a 6-digit code. No password required."
                    : "Enter the 6-digit code we just sent to \(email)."
                )
                .font(.system(size: 14))
                .foregroundStyle(PA.Colors.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            }
        }
    }

    // MARK: - Phase 1: Email

    private var emailPhase: some View {
        VStack(spacing: 12) {
            TextField("you@example.com", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.send)
                .focused($emailFocused)
                .onSubmit { Task { await sendCode() } }
                .padding(14)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(PA.Colors.surfaceSoft)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(PA.Colors.border, lineWidth: 1)
                )
                .padding(.horizontal, 24)
                .accessibilityLabel("Email address")

            Button {
                Task { await sendCode() }
            } label: {
                HStack(spacing: 6) {
                    if isSending {
                        ProgressView()
                            .tint(Color.white)
                            .scaleEffect(0.85)
                    }
                    Text("Send Code")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Color.white)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(PA.Colors.accent.opacity(canSendCode ? 1.0 : 0.5))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!canSendCode)
            .padding(.horizontal, 24)
            .padding(.top, 4)
            .accessibilityLabel("Send code to email")
        }
    }

    // MARK: - Phase 2: Code

    private var codePhase: some View {
        VStack(spacing: 12) {
            TextField("000000", text: $code)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.center)
                .font(.system(size: 28, weight: .semibold, design: .monospaced))
                .tracking(8)
                .focused($codeFocused)
                .padding(.vertical, 14)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(PA.Colors.surfaceSoft)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(PA.Colors.border, lineWidth: 1)
                )
                .padding(.horizontal, 24)
                .onChange(of: code) { _, newValue in
                    let digits = newValue.filter(\.isNumber)
                    if digits != newValue { code = digits }
                    if digits.count > 6 { code = String(digits.prefix(6)) }
                    // Auto-submit at 6 digits — saves a tap and matches
                    // the OS one-time-code paste affordance UX.
                    if code.count == 6, !isVerifying {
                        Task { await verify() }
                    }
                }
                .accessibilityLabel("Verification code")

            Button {
                Task { await verify() }
            } label: {
                HStack(spacing: 6) {
                    if isVerifying {
                        ProgressView()
                            .tint(Color.white)
                            .scaleEffect(0.85)
                    }
                    Text("Verify")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Color.white)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(PA.Colors.accent.opacity(canVerify ? 1.0 : 0.5))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!canVerify)
            .padding(.horizontal, 24)
            .accessibilityLabel("Verify code")

            Button {
                Task { await sendCode(isResend: true) }
            } label: {
                Text(isSending ? "Sending…" : "Resend code")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(PA.Colors.accent)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.plain)
            .disabled(isSending || isVerifying)
            .accessibilityLabel("Resend code")
        }
        .onAppear { codeFocused = true }
    }

    // MARK: - Validation

    private var canSendCode: Bool {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        return !isSending && trimmed.contains("@") && trimmed.contains(".")
    }

    private var canVerify: Bool {
        !isVerifying && code.count == 6
    }

    // MARK: - Actions

    @MainActor
    private func sendCode(isResend: Bool = false) async {
        guard canSendCode || isResend else { return }
        errorMessage = nil
        isSending = true
        defer { isSending = false }

        do {
            try await AuthService.shared.signInWithEmail(email)
            if !isResend {
                withAnimation { phase = .code }
            }
        } catch {
            errorMessage = humanReadable(error)
        }
    }

    @MainActor
    private func verify() async {
        guard canVerify else { return }
        errorMessage = nil
        isVerifying = true
        defer { isVerifying = false }

        do {
            try await AuthService.shared.verifyEmailCode(code)
            // Sign-in succeeded — dismiss; the underlying guest screens
            // re-render as authenticated.
            dismiss()
        } catch {
            errorMessage = humanReadable(error)
            // Clear the code so the user can try again without
            // backspacing through 6 digits.
            code = ""
        }
    }

    private func humanReadable(_ error: Error) -> String {
        let raw = error.localizedDescription
        // Clerk errors are usually fairly user-friendly out of the box,
        // but a few common ones can be smoothed over for clarity.
        let lower = raw.lowercased()
        if lower.contains("not found") || lower.contains("no account") {
            return "We couldn't find an account with that email."
        }
        if lower.contains("incorrect") || lower.contains("invalid code") {
            return "That code didn't match. Try again or resend."
        }
        if lower.contains("expired") {
            return "Code expired. Tap Resend to get a new one."
        }
        return raw
    }
}
