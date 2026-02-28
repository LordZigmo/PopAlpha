import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

function resolveBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.SITE_URL ?? "";
  if (configured.trim()) {
    return configured.trim().replace(/\/$/, "");
  }

  const vercel = process.env.VERCEL_URL?.trim() ?? "";
  if (vercel) {
    return vercel.startsWith("http") ? vercel.replace(/\/$/, "") : `https://${vercel}`;
  }

  return "http://localhost:3000";
}

async function main() {
  const slug = process.argv[2] ?? "base-4-charizard";
  const response = await fetch(`${resolveBaseUrl()}/api/cards/${encodeURIComponent(slug)}/detail`, {
    cache: "no-store",
  });

  const payload = await response.json();
  console.log(JSON.stringify({
    status: response.status,
    slug,
    defaults: payload?.defaults ?? null,
    rawVariantCount: payload?.raw?.variants?.length ?? 0,
    gradedMatrixCount: payload?.graded?.matrix?.length ?? 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
