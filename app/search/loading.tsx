import Link from "next/link";

export default function SearchLoading() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F0F0F0]">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.04] bg-[#0A0A0A]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="text-[16px] font-bold tracking-tight text-white">PopAlpha</Link>
          <nav className="flex items-center gap-5">
            <Link href="/sets" className="hidden text-[13px] font-medium text-[#666] transition hover:text-white sm:block">Sets</Link>
            <Link href="/portfolio" className="hidden text-[13px] font-medium text-[#666] transition hover:text-white sm:block">Portfolio</Link>
          </nav>
        </div>
      </header>

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
