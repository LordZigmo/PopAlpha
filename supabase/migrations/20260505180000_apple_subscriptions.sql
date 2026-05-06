-- Apple App Store subscriptions / non-consumable purchases.
-- Source of truth for `hasPro()` server-side checks.
--
-- Writers: ASSN V2 webhook (canonical) + iOS-side /api/iap/verify
-- (low-latency unlock at purchase time).
-- Readers: lib/entitlements.ts hasPro() — joins on clerk_user_id.
--
-- Idempotency: PK is original_transaction_id (Apple's stable ID per
-- subscription line). last_assn_at lets the webhook handler ignore
-- out-of-order or replayed notifications.

CREATE TABLE IF NOT EXISTS public.apple_subscriptions (
  original_transaction_id text PRIMARY KEY,
  clerk_user_id           text NOT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE CASCADE,
  product_id              text NOT NULL,
  environment             text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  status                  text NOT NULL CHECK (status IN ('active', 'expired', 'revoked', 'grace_period', 'billing_retry')),
  expires_at              timestamptz,
  revoked_at              timestamptz,
  last_assn_at            timestamptz,
  raw_jws_payload         jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- hasPro() lookup: WHERE clerk_user_id = $1 AND status = 'active'
--                   AND (expires_at IS NULL OR expires_at > now())
CREATE INDEX IF NOT EXISTS apple_subscriptions_user_active_idx
  ON public.apple_subscriptions (clerk_user_id, status, expires_at);

ALTER TABLE public.apple_subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.apple_subscriptions FROM anon, authenticated;
