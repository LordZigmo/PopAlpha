function SkeletonLine({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-md bg-surface-soft ${className}`} />;
}

export default function CertSkeleton() {
  return (
    <section className="glass mt-6 rounded-3xl border-app border p-5 sm:p-6" aria-live="polite" aria-busy="true">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-4 rounded-3xl border-app border p-5">
          <SkeletonLine className="h-4 w-28" />
          <SkeletonLine className="h-16 w-40" />
          <SkeletonLine className="h-5 w-full max-w-lg" />
          <div className="flex gap-2">
            <SkeletonLine className="h-7 w-24 rounded-full" />
            <SkeletonLine className="h-7 w-28 rounded-full" />
            <SkeletonLine className="h-7 w-24 rounded-full" />
          </div>
          <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
            <SkeletonLine className="h-28 w-28 rounded-2xl" />
            <SkeletonLine className="h-28 w-full rounded-2xl" />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <div className="rounded-2xl border-app border p-4">
            <SkeletonLine className="h-3 w-28" />
            <SkeletonLine className="mt-3 h-8 w-16" />
          </div>
          <div className="rounded-2xl border-app border p-4">
            <SkeletonLine className="h-3 w-24" />
            <SkeletonLine className="mt-3 h-8 w-14" />
          </div>
          <div className="rounded-2xl border-app border p-4">
            <SkeletonLine className="h-3 w-32" />
            <SkeletonLine className="mt-3 h-8 w-24" />
          </div>
          <div className="rounded-2xl border-app border p-4">
            <SkeletonLine className="h-3 w-20" />
            <SkeletonLine className="mt-3 h-8 w-12" />
          </div>
        </div>
      </div>
    </section>
  );
}
