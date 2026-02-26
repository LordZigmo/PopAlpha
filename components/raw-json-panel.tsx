type RawJsonPanelProps = {
  value: unknown;
  className?: string;
};

export default function RawJsonPanel({ value, className }: RawJsonPanelProps) {
  return (
    <details className={`raw-json-panel rounded-2xl border-app border bg-surface/60 p-4 ${className ?? ""}`}>
      <summary className="text-app marker:hidden cursor-pointer list-none text-sm font-semibold">Raw JSON (debug)</summary>
      <div className="raw-json-content mt-0 grid overflow-hidden transition-all duration-300 ease-out">
        <div className="min-h-0">
          <p className="text-muted mt-2 text-xs">Expand this only when you need full technical output.</p>
          <pre className="border-app bg-surface-soft text-app mt-3 max-h-[420px] overflow-auto rounded-xl border p-3 text-xs leading-5">
            <code>{JSON.stringify(value, null, 2)}</code>
          </pre>
        </div>
      </div>
    </details>
  );
}
