import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { buildCanonicalSearchDoc, normalizeSearchText } from "../lib/search/normalize.mjs";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const [
    { data: canonicalRows, error: canonicalError },
    { data: aliasRows, error: aliasError },
    { data: printingRows, error: printingError },
  ] = await Promise.all([
    supabase
      .from("canonical_cards")
      .select("slug, canonical_name, subject, set_name, card_number, year")
      .limit(10000),
    supabase
      .from("card_aliases")
      .select("id, alias")
      .limit(20000),
    supabase
      .from("card_printings")
      .select("canonical_slug, image_url")
      .not("image_url", "is", null)
      .order("canonical_slug", { ascending: true })
      .order("id", { ascending: true })
      .limit(50000),
  ]);

  if (canonicalError) throw canonicalError;
  if (aliasError) throw aliasError;
  if (printingError) throw printingError;

  const primaryImageBySlug = new Map();
  for (const row of printingRows ?? []) {
    if (!row.image_url || primaryImageBySlug.has(row.canonical_slug)) continue;
    primaryImageBySlug.set(row.canonical_slug, row.image_url);
  }

  const canonicalUpdates = (canonicalRows ?? []).map((row) => {
    const searchDoc = buildCanonicalSearchDoc(row);
    return {
      slug: row.slug,
      search_doc: searchDoc,
      search_doc_norm: normalizeSearchText(searchDoc),
      primary_image_url: primaryImageBySlug.get(row.slug) ?? null,
    };
  });

  const aliasUpdates = (aliasRows ?? []).map((row) => ({
    id: row.id,
    alias_norm: normalizeSearchText(row.alias),
  }));

  for (let i = 0; i < canonicalUpdates.length; i += 250) {
    const batch = canonicalUpdates.slice(i, i + 250);
    const { error } = await supabase.from("canonical_cards").upsert(batch, { onConflict: "slug" });
    if (error) throw error;
  }

  for (let i = 0; i < aliasUpdates.length; i += 250) {
    const batch = aliasUpdates.slice(i, i + 250);
    const { error } = await supabase.from("card_aliases").upsert(batch, { onConflict: "id" });
    if (error) throw error;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        canonicalRowsUpdated: canonicalUpdates.length,
        aliasRowsUpdated: aliasUpdates.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
