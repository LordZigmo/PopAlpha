export default function SearchLoading() {
  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <section className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="h-6 w-48 rounded bg-surface-soft" />
          <div className="mt-2 h-4 w-28 rounded bg-surface-soft" />
          <div className="mt-4 h-14 rounded-[var(--radius-card)] bg-surface-soft" />
        </section>

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="flex items-center justify-between gap-3 border-b border-app pb-3">
                <div className="min-w-0 flex-1">
                  <div className="h-4 w-40 rounded bg-surface-soft" />
                  <div className="mt-2 h-3 w-64 rounded bg-surface-soft" />
                </div>
                <div className="h-3 w-10 rounded bg-surface-soft" />
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

