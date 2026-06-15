/**
 * Serializes a JSON-LD object to a string safe to inline inside a
 * `<script type="application/ld+json">` tag.
 *
 * `JSON.stringify` alone does NOT escape `<`, `>`, or `&`, so a catalog string
 * containing `</script>` — or even a bare `<` / `>` — would break out of the
 * script tag. Consequences: the structured data truncates (Google silently
 * fails to parse the Product/Breadcrumb/FAQ rich result) and, worst case,
 * arbitrary markup is injected. Card/set names, rarities, and descriptions are
 * ingested from external pricing/card sources, so this input is NOT trusted.
 *
 * We escape those characters to their `\uXXXX` forms. JSON parsers decode them
 * back to the identical characters, so every consumer sees the same data — only
 * the wire representation changes. (`<` and `>` are the load-bearing escapes for
 * the HTML script context; `&` is defensive.)
 */
export function serializeJsonLd(block: unknown): string {
  return JSON.stringify(block)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
