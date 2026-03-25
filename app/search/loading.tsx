import SiteHeader from "@/components/site-header";

export default function SearchLoading() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F0F0F0]">
      <SiteHeader />

      <div className="mx-auto max-w-7xl px-5 pt-20 pb-20 sm:px-8 sm:pt-22">
        {/* Search bar skeleton */}
        <div className="mx-auto w-full max-w-2xl pt-1 sm:pt-2">
          <div className="h-12 rounded-xl border border-white/[0.06] bg-[#111]" />
        </div>

        {/* Results skeleton */}
        <div className="mt-8">
          <div className="mb-4 flex items-center justify-between">
            <div className="h-3 w-20 rounded bg-white/[0.04]" />
            <div className="h-8 w-40 rounded-lg bg-white/[0.04]" />
          </div>
          <div className="grid grid-cols-3 gap-3 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i}>
                <div className="aspect-[63/88] rounded-xl bg-white/[0.03]" />
                <div className="mt-2 h-3 w-3/4 rounded bg-white/[0.04]" />
                <div className="mt-1 h-2.5 w-1/2 rounded bg-white/[0.03]" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
