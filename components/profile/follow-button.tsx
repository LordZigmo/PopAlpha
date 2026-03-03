"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";

export default function FollowButton({
  handle,
  initialFollowers,
}: {
  handle: string;
  initialFollowers: number;
}) {
  const { user, isLoaded } = useUser();
  const [following, setFollowing] = useState(false);
  const [followers, setFollowers] = useState(initialFollowers);
  const [pending, setPending] = useState(false);

  async function toggleFollow() {
    if (!user || pending) return;
    setPending(true);

    try {
      const response = await fetch(
        following ? `/api/profile/follow?handle=${encodeURIComponent(handle)}` : "/api/profile/follow",
        following
          ? { method: "DELETE" }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ handle }),
            },
      );

      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not update follow state.");

      setFollowing((current) => !current);
      setFollowers((current) => current + (following ? -1 : 1));
    } catch {
      // Intentionally quiet in UI for now.
    } finally {
      setPending(false);
    }
  }

  if (!isLoaded) {
    return (
      <div className="rounded-2xl border border-[#1E1E1E] bg-white/[0.04] px-4 py-2 text-[13px] font-semibold text-white">
        {followers} followers
      </div>
    );
  }

  if (!user) {
    return (
      <Link
        href="/sign-in"
        className="rounded-2xl border border-[#1E1E1E] bg-white/[0.06] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.1]"
      >
        Follow
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={toggleFollow}
      disabled={pending}
      className="rounded-2xl border border-[#1E1E1E] bg-white/[0.08] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.12] disabled:opacity-60"
    >
      {pending ? "Working..." : following ? `Following · ${followers}` : `Follow · ${followers}`}
    </button>
  );
}
