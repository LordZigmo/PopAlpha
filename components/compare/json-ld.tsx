import { serializeJsonLd } from "@/lib/seo/json-ld-serialize";

type JsonLdProps = {
  data: Record<string, unknown> | Record<string, unknown>[];
};

// Renders one <script type="application/ld+json"> per block. Some callers pass
// externally-ingested catalog text (card/set names, rarities, descriptions), so
// serializeJsonLd escapes `<`/`>`/`&` to keep a stray `</script>` from breaking
// out of the tag (which would inject markup and truncate the structured data).
export default function JsonLd({ data }: JsonLdProps) {
  const blocks = Array.isArray(data) ? data : [data];
  return (
    <>
      {blocks.map((block, index) => (
        <script
          key={index}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(block) }}
        />
      ))}
    </>
  );
}
