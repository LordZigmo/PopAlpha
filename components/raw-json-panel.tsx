type RawJsonPanelProps = {
  value: unknown;
};

export default function RawJsonPanel({ value }: RawJsonPanelProps) {
  return (
    <details className="card mt-4 rounded-2xl p-4">
      <summary className="cursor-pointer list-none text-sm font-semibold text-neutral-800 marker:hidden dark:text-neutral-100">
        Raw JSON (debug)
      </summary>
      <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
        Expand this only when you need full technical output.
      </p>
      <pre className="mt-3 max-h-[420px] overflow-auto rounded-xl border border-neutral-300/90 bg-neutral-100/90 p-3 text-xs leading-5 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950/70 dark:text-neutral-100">
        <code>{JSON.stringify(value, null, 2)}</code>
      </pre>
    </details>
  );
}
