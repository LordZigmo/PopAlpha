"use client";

import { useSearchParams } from "next/navigation";
import CardSearch from "@/components/card-search";

export default function NavSearchForm() {
  const searchParams = useSearchParams();

  return (
    <CardSearch
      key={searchParams.get("q") ?? ""}
      className="flex-1"
      size="nav"
      placeholder="Search cards…"
      enableGlobalShortcut
      submitMode="active-only"
      initialValue={searchParams.get("q") ?? ""}
    />
  );
}
