type JsonLdProps = {
  data: Record<string, unknown> | Record<string, unknown>[];
};

// Renders one <script type="application/ld+json"> per block. The payload is built
// entirely from our own typed data (no user input), so JSON.stringify is safe here.
export default function JsonLd({ data }: JsonLdProps) {
  const blocks = Array.isArray(data) ? data : [data];
  return (
    <>
      {blocks.map((block, index) => (
        <script
          key={index}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(block) }}
        />
      ))}
    </>
  );
}
