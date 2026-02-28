"use client";

import { useEffect, useState } from "react";
import { NavBar } from "@/components/ios-grouped-ui";

export default function CardDetailNavBar({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const onScroll = () => setCompact(window.scrollY > 36);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return <NavBar title={title} subtitle={subtitle} compact={compact} />;
}
