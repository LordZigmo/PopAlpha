function SkeletonLine({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-md bg-neutral-200/90 dark:bg-neutral-800/80 ${className}`} />;
}

export default function CertSkeleton() {
  return (
    <section className="card mt-6 rounded-3xl p-6 sm:p-7" aria-live="polite" aria-busy="true">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <SkeletonLine className="h-4 w-28" />
          <SkeletonLine className="h-14 w-48" />
          <SkeletonLine className="h-5 w-full max-w-lg" />
          <SkeletonLine className="h-4 w-44" />
          <div className="flex gap-2">
            <SkeletonLine className="h-7 w-28 rounded-full" />
            <SkeletonLine className="h-7 w-24 rounded-full" />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
          <div className="rounded-2xl border border-neutral-300/70 p-4 dark:border-neutral-700/80">
            <SkeletonLine className="h-3 w-28" />
            <SkeletonLine className="mt-3 h-8 w-16" />
          </div>
          <div className="rounded-2xl border border-neutral-300/70 p-4 dark:border-neutral-700/80">
            <SkeletonLine className="h-3 w-24" />
            <SkeletonLine className="mt-3 h-8 w-14" />
          </div>
          <div className="rounded-2xl border border-neutral-300/70 p-4 dark:border-neutral-700/80">
            <SkeletonLine className="h-3 w-36" />
            <SkeletonLine className="mt-3 h-8 w-32 rounded-full" />
          </div>
        </div>
      </div>
    </section>
  );
}
