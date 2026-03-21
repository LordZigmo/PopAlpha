# eBay Deletion Review Runbook

This runbook covers PopAlpha's current internal-only review workflow for verified eBay marketplace account deletion receipts.

## Scope

- This workflow starts only after:
  - the public eBay webhook verifies the raw request body and signature
  - a verified receipt is stored in `public.ebay_deletion_notification_receipts`
  - the cron worker normalizes that receipt into `public.ebay_deletion_manual_review_tasks`
- Internal operators reach this workflow only through the server-protected `/internal/admin` surface, using a trusted Clerk identity that is explicitly allowlisted for internal admin access.
- The backing review routes under `/api/admin/ebay-deletion-tasks` use that same trusted internal admin session model; they do not treat `ADMIN_SECRET` as the normal UI auth path.
- This workflow does **not** authorize deletion, erasure, account disablement, or any irreversible action.

## Review States

- `pending_review`
  - default state for a new normalized task
  - means no operator has made a substantive decision yet
- `needs_more_context`
  - the verified receipt is real, but current internal evidence is insufficient to choose even an advisory candidate match
- `matched_candidate`
  - an operator selected an advisory candidate match for follow-up
  - this is still not authoritative identity resolution
- `no_match_found`
  - current internal evidence does not support selecting any advisory candidate
  - this is not a statement that PopAlpha definitely has no matching user forever
- `escalated`
  - the task needs a higher-trust or cross-functional review before anything else is designed or allowed

## Allowed Evidence

- Verified receipt metadata already stored by PopAlpha:
  - `notification_id`
  - topic / schema version
  - eBay `userId`
  - eBay `username`
  - publish / event timestamps
  - signature verification metadata
- Advisory exact-handle candidate matches derived from the verified eBay username and current `app_users.handle_norm`
- Internal operator notes that summarize what was reviewed and why a state changed
- Internal ticket or escalation references recorded in review notes

## Advisory Only

- The current candidate-match system is advisory only.
- An exact handle match is **not** proof that an eBay account belongs to a PopAlpha user.
- eBay `username` alone is **not** authoritative identity evidence.
- Review notes are operator annotations, not eligibility decisions.
- No current state means "safe to delete."

## What Operators May Do

- Read task, receipt, and audit-event data through the internal admin review routes
- Change `reviewState`
- Add or clear `reviewNotes`
- Mark or clear one advisory candidate match chosen from the exact-handle candidate list
- Escalate a task when the current evidence is ambiguous, conflicting, or policy-sensitive

## What Operators Must Never Do Yet

- Do not delete or erase any user data
- Do not disable accounts or mark a user as deletion-eligible
- Do not mutate `app_users` or any user-owned table as part of this review flow
- Do not use direct SQL or ad hoc scripts to bypass the audited admin routes for review actions
- Do not treat advisory candidate matches as final identity resolution

## When To Escalate

- Multiple plausible advisory candidates exist
- No advisory candidate exists, but the request appears legitimate and important
- Review notes reveal conflicting evidence across systems
- A repeat or unusual eBay receipt pattern suggests a broader policy or abuse issue
- Any operator is unsure whether future deletion design would require legal, privacy, or product review

## Audit Expectations

- Operator attribution comes from the trusted Clerk-backed internal admin session. Audit events should record the canonical actor format `clerk:<clerk_user_id>`, not a freeform display string. If an internal admin route is called without that canonical actor format, the audit trail should fall back to the route auth reason instead of trusting arbitrary text.
- Every state change is append-only audited
- Every note update is append-only audited
- Every candidate-match mark or clear action is append-only audited
- `task_viewed` is intentionally **not** recorded yet because it is too noisy for the current phase

## Still Deferred

- Authoritative identity-resolution rules
- A reviewed deletion eligibility model
- Any irreversible deletion or erasure worker
- User communication / notification procedures
- A legal / privacy sign-off process for destructive actions

Until those pieces exist and are separately reviewed, this workflow remains annotation-only.
