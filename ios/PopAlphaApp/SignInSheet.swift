import SwiftUI

// MARK: - Sign In Sheet
//
// Unified sign-in surface presented anywhere `AuthService.shared.signIn()`
// is invoked. Three phases:
//
//   .chooser → "Continue with Google / Apple / Email"
//              Google + Apple delegate to their direct AuthService methods
//              and dismiss the sheet (Clerk's web/system flow takes over).
//              Email transitions to .email in-sheet rather than nesting
//              another sheet.
//
//   .email   → email entry. "Send Code" calls
//              AuthService.signInWithEmail(_:) which kicks off Clerk's
//              email-code flow, then transitions to .code.
//
//   .code    → 6-digit verification code. Auto-submits at 6 digits.
//              "Resend code" re-runs phase-1 against the same email.
//              On success, dismisses the sheet and the underlying view
//              re-renders signed-in.
//
// Surfaces that want all three buttons inline (e.g., Profile tab guest
// state, MarketplaceView SignInPromoCard) use `SignInProviderStack` —
// not this sheet. Those stack surfaces present this sheet directly into
// `.email` for the email button so users skip the chooser they already
// implicitly chose against.

struct SignInSheet: View {
    @Environment(\.dismiss) private var dismiss

    enum Phase: Equatable { case chooser, email, code }

    var startingPhase: Phase

    @State private var phase: Phase
    @State private var email: String = ""
    @State private var code: String = ""
    @State private var isSending: Bool = false
    @State private var isVerifying: Bool = false
    @State private var errorMessage: String?

    @FocusState private var emailFocused: Bool
    @FocusState private var codeFocused: Bool

    init(startingPhase: Phase = .chooser) {
        self.startingPhase = startingPhase
        self._phase = State(initialValue: startingPhase)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Spacer()
                heroSection
                Spacer()

                switch phase {
                case .chooser: chooserPhase
                case .email:   emailPhase
                case .code:    codePhase
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
            .navigationTitle(navTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                if shouldShowBack {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            withAnimation { phase = previousPhase }
                            // Clear transient state for the phase we're
                            // returning to; the email survives so a user
                            // coming back from .code can fix a typo.
                            errorMessage = nil
                            if phase == .chooser {
                                email = ""
                                code = ""
                            } else if phase == .email {
                                code = ""
                            }
                        } label: {
                            Image(systemName: "chevron.left")
                            Text("Back")
                        }
                    }
                }
            }
            .onAppear {
                if phase == .email { emailFocused = true }
                if phase == .code { codeFocused = true }
            }
        }
    }

    // MARK: - Hero

    private var navTitle: String {
        switch phase {
        case .chooser: "Sign In"
        case .email:   "Sign In"
        case .code:    "Enter Code"
        }
    }

    private var heroSection: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(PA.Colors.accent.opacity(0.15))
                    .frame(width: 72, height: 72)
                Image(systemName: heroIcon)
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
            }

            VStack(spacing: 8) {
                Text(heroTitle)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(PA.Colors.text)
                    .multilineTextAlignment(.center)

                Text(heroSubtitle)
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
        }
    }

    private var heroIcon: String {
        switch phase {
        case .chooser: "person.crop.circle.badge.checkmark"
        case .email:   "envelope.fill"
        case .code:    "number.circle.fill"
        }
    }

    private var heroTitle: String {
        switch phase {
        case .chooser: "Welcome to PopAlpha"
        case .email:   "Continue with email"
        case .code:    "Check your email"
        }
    }

    private var heroSubtitle: String {
        switch phase {
        case .chooser:
            return "Sign in or create an account to track your portfolio, build a wishlist, and unlock the daily market brief."
        case .email:
            return "New here or returning, we'll email you a 6-digit code. No password required."
        case .code:
            return "Enter the 6-digit code we just sent to \(email)."
        }
    }

    // MARK: - Toolbar back

    private var shouldShowBack: Bool {
        // Only offer Back if we DID NOT start at the deeper phase. If
        // SignInProviderStack opened us directly into .email, going back
        // to .chooser would be weird — they explicitly picked Email.
        switch (startingPhase, phase) {
        case (.chooser, .email), (.chooser, .code), (.email, .code):
            return true
        default:
            return false
        }
    }

    private var previousPhase: Phase {
        switch phase {
        case .code:    return .email
        case .email:   return .chooser
        case .chooser: return .chooser
        }
    }

    // MARK: - Phase 0: Chooser

    private var chooserPhase: some View {
        VStack(spacing: 10) {
            PrimarySignInButton(maxWidth: 280) {
                AuthService.shared.signInWithGoogle()
                dismiss()
            }
            PrimaryAppleSignInButton(maxWidth: 280) {
                AuthService.shared.signInWithApple()
                dismiss()
            }
            PrimaryEmailSignInButton(maxWidth: 280) {
                withAnimation { phase = .email }
            }
        }
        .padding(.horizontal, 24)
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
