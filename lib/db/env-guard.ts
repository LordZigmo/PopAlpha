const NEON_STYLE_ENV_KEYS = [
  "AI_NEON_DATABASE_URL",
  "NEON_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_URL_NON_POOLING",
  "POPALPHA_NEON_DATABASE_URL",
  "POPALPHA_DATABASE_URL",
  "POPALPHA_POSTGRES_URL",
  "POPALPHA_POSTGRES_URL_NON_POOLING",
  "PopAlpha_NEON_DATABASE_URL",
  "PopAlpha_DATABASE_URL",
  "PopAlpha_POSTGRES_URL",
  "PopAlpha_POSTGRES_URL_NON_POOLING",
] as const;

let warned = false;

export function warnIfPricingDbEnvLooksMixed(context: "admin_client" | "public_client"): void {
  if (warned) return;

  const present = NEON_STYLE_ENV_KEYS
    .filter((key) => {
      const value = process.env[key];
      return typeof value === "string" && value.trim().length > 0;
    });

  if (present.length === 0) return;

  warned = true;
  console.warn(
    `[db-env] ${context}: detected Neon/AI DB env vars (${present.join(", ")}). `
      + "Pricing/data APIs use Supabase clients only (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_*).",
  );
}
