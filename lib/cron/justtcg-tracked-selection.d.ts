export type TrackedSelectionSkipEntry = {
  canonical_slug: string;
  printing_id: string;
  reason:
    | "MISSING_JUSTTCG_MAPPING"
    | "MISSING_PROVIDER_SET_ID"
    | "MISSING_PROVIDER_VARIANT_ID"
    | "MISSING_PRINTING_ID";
  mapping_id?: string;
  provider_set_id?: string;
};

export declare function buildTrackedSelectionPlan(
  trackedRows: Array<{ canonical_slug: string; printing_id: string }>,
  mappingRows: Array<{
    id?: string;
    printing_id?: string;
    external_id?: string | null;
    meta?: { provider_set_id?: string | null; provider_variant_id?: string | null } | null;
  }>,
): {
  eligibleMappings: Array<unknown>;
  skippedEntries: TrackedSelectionSkipEntry[];
};

