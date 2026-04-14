"use client";

import { useState } from "react";
import PostBody, { type PostMention } from "@/components/profile/post-body";
import ProfileActivityFeed from "./profile-activity-feed";

type ProfilePost = {
  id: number;
  handle: string;
  body: string;
  created_at: string;
  mentions: PostMention[];
};

function formatPostTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.round(diffMs / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

const TABS = ["Posts", "Activity", "Collections"] as const;
type Tab = (typeof TABS)[number];

export default function ProfileTabs({
  handle,
  posts,
}: {
  handle: string;
  posts: ProfilePost[];
}) {
  const [activeTab, setActiveTab] = useState<Tab>("Posts");

  return (
    <>
      <div className="mt-6 grid grid-cols-3 border-b border-[#1E1E1E]">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-2 py-3 text-center text-[13px] font-semibold transition-colors ${
              activeTab === tab
                ? "border-b-2 border-white text-white"
                : "text-[#6B6B6B] hover:text-[#8A8A8A]"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Posts" && (
        <div className="px-1 py-6">
          {posts.length === 0 ? (
            <div className="rounded-[1.5rem] border border-dashed border-[#1E1E1E] bg-[#0B0B0B] px-5 py-8 text-center">
              <p className="text-[18px] font-semibold tracking-[-0.03em] text-white">Nothing here yet</p>
              <p className="mt-2 text-[14px] leading-6 text-[#8A8A8A]">No posts from this profile yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {posts.map((post) => (
                <article key={post.id} className="rounded-[1.35rem] border border-[#1E1E1E] bg-[#0B0B0B] px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[14px] font-semibold text-white">@{post.handle}</p>
                    <span className="text-[12px] text-[#6B6B6B]">{formatPostTime(post.created_at)}</span>
                  </div>
                  <PostBody body={post.body} mentions={post.mentions} />
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "Activity" && (
        <ProfileActivityFeed handle={handle} />
      )}

      {activeTab === "Collections" && (
        <div className="px-1 py-6">
          <div className="rounded-[1.5rem] border border-dashed border-[#1E1E1E] bg-[#0B0B0B] px-5 py-8 text-center">
            <p className="text-[18px] font-semibold tracking-[-0.03em] text-white">Coming soon</p>
            <p className="mt-2 text-[14px] leading-6 text-[#8A8A8A]">
              Public collection showcase is on the roadmap.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
