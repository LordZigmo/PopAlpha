"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ background: "#0A0A0A", color: "#F0F0F0", fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 700 }}>Something went wrong</h1>
        <pre style={{ marginTop: "1rem", fontSize: "0.85rem", color: "#FF6B6B", whiteSpace: "pre-wrap" }}>
          {error.message}
        </pre>
        {error.digest ? (
          <p style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "#666" }}>
            Digest: {error.digest}
          </p>
        ) : null}
        <button
          onClick={reset}
          style={{
            marginTop: "1.5rem",
            padding: "0.5rem 1rem",
            background: "#222",
            color: "#F0F0F0",
            border: "1px solid #333",
            borderRadius: "0.5rem",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
