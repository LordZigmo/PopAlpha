/**
 * Build the tracked-only nightly selection plan.
 * Each tracked asset ends in exactly one pre-fetch state:
 * - eligible => returns a concrete mapping to attempt
 * - skipped  => returns one explicit skip reason
 */

export function buildTrackedSelectionPlan(trackedRows, mappingRows) {
  const mappingsByPrintingId = new Map();
  for (const row of mappingRows ?? []) {
    if (!row?.printing_id) continue;
    const bucket = mappingsByPrintingId.get(row.printing_id) ?? [];
    bucket.push(row);
    mappingsByPrintingId.set(row.printing_id, bucket);
  }

  const eligibleMappings = [];
  const skippedEntries = [];

  for (const trackedRow of trackedRows ?? []) {
    const canonicalSlug = trackedRow?.canonical_slug ?? "";
    const printingId = trackedRow?.printing_id ?? "";

    if (!printingId) {
      skippedEntries.push({
        canonical_slug: canonicalSlug,
        printing_id: printingId,
        reason: "MISSING_PRINTING_ID",
      });
      continue;
    }

    const candidateMappings = mappingsByPrintingId.get(printingId) ?? [];
    if (candidateMappings.length === 0) {
      skippedEntries.push({
        canonical_slug: canonicalSlug,
        printing_id: printingId,
        reason: "MISSING_JUSTTCG_MAPPING",
      });
      continue;
    }

    const mapped = candidateMappings[0];
    const providerSetId = typeof mapped?.meta?.provider_set_id === "string" ? mapped.meta.provider_set_id : null;
    const providerVariantId =
      typeof mapped?.meta?.provider_variant_id === "string"
        ? mapped.meta.provider_variant_id
        : (typeof mapped?.external_id === "string" && mapped.external_id.trim() ? mapped.external_id : null);

    if (!providerSetId) {
      skippedEntries.push({
        canonical_slug: canonicalSlug,
        printing_id: printingId,
        reason: "MISSING_PROVIDER_SET_ID",
        mapping_id: mapped.id,
      });
      continue;
    }

    if (!providerVariantId) {
      skippedEntries.push({
        canonical_slug: canonicalSlug,
        printing_id: printingId,
        reason: "MISSING_PROVIDER_VARIANT_ID",
        mapping_id: mapped.id,
        provider_set_id: providerSetId,
      });
      continue;
    }

    eligibleMappings.push(mapped);
  }

  return { eligibleMappings, skippedEntries };
}

