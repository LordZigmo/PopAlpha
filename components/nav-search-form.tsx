"use client";

import { useSearchParams } from "next/navigation";
import CardSearch from "@/components/card-search";

type NavSearchFormProps = {
  borderless?: boolean;
};

export default function NavSearchForm({ borderless = false }: NavSearchFormProps) {
  const searchParams = useSearchParams();

  return (
    <CardSearch
      key={searchParams.get("q") ?? ""}
      className="flex-1"
      size="nav"
      placeholder="Search cards…"
      enableGlobalShortcut
      submitMode="active-or-search"
      initialValue={searchParams.get("q") ?? ""}
      borderless={borderless}
    />
  );
}
