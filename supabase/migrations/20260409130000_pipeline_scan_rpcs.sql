-- Additional RPC functions to bypass PostgREST .order().range() bug.
-- Converts remaining paginated scan queries in the SCRYDEX pipeline
-- to direct SQL functions.

-- 1. Card printings loader for match stage
CREATE OR REPLACE FUNCTION public.scan_card_printings_by_set(
  p_set_codes text[],
  p_limit integer DEFAULT 1000,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  id uuid,
  canonical_slug text,
  set_code text,
  card_number text,
  language text,
  finish text,
  edition text,
  stamp text
)
LANGUAGE plpgsql STABLE
SET statement_timeout = '30s'
AS $$
BEGIN
  RETURN QUERY
    SELECT p.id, p.canonical_slug, p.set_code, p.card_number,
           p.language, p.finish, p.edition, p.stamp
    FROM public.card_printings p
    WHERE p.set_code = ANY(p_set_codes)
    ORDER BY p.id ASC
    LIMIT p_limit OFFSET p_offset;
END;
$$;

-- 2. Card printings for set priority (filtered by language + year)
CREATE OR REPLACE FUNCTION public.scan_card_printings_for_priority(
  p_set_codes text[],
  p_year_from integer,
  p_limit integer DEFAULT 1000,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  set_code text,
  set_name text,
  year integer,
  canonical_slug text
)
LANGUAGE plpgsql STABLE
SET statement_timeout = '30s'
AS $$
BEGIN
  RETURN QUERY
    SELECT p.set_code, p.set_name, p.year, p.canonical_slug
    FROM public.card_printings p
    WHERE p.language = 'EN'
      AND p.year >= p_year_from
      AND p.set_code = ANY(p_set_codes)
    ORDER BY p.id ASC
    LIMIT p_limit OFFSET p_offset;
END;
$$;

-- 3. Variant price latest for set priority
CREATE OR REPLACE FUNCTION public.scan_variant_price_latest_for_priority(
  p_provider text,
  p_set_ids text[],
  p_limit integer DEFAULT 1000,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  set_id text,
  canonical_slug text,
  latest_observed_at timestamptz
)
LANGUAGE plpgsql STABLE
SET statement_timeout = '30s'
AS $$
BEGIN
  RETURN QUERY
    SELECT v.set_id, v.canonical_slug, v.latest_observed_at
    FROM public.variant_price_latest v
    WHERE v.provider = p_provider
      AND v.grade = 'RAW'
      AND v.set_id = ANY(p_set_ids)
    ORDER BY v.set_id ASC, v.canonical_slug ASC
    LIMIT p_limit OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.scan_card_printings_by_set(text[], integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.scan_card_printings_for_priority(text[], integer, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.scan_variant_price_latest_for_priority(text, text[], integer, integer) TO authenticated, service_role;
