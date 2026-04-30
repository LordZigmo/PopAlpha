"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";
import { useSafeUser } from "@/lib/auth/use-safe-user";
import { Camera, Pencil } from "lucide-react";
import PostBody, { type PostMention } from "@/components/profile/post-body";
import PageShell from "@/components/layout/PageShell";
import posthog from "posthog-js";

type AppProfile = {
  handle: string | null;
  onboarded: boolean;
  created_at: string;
  profile_bio: string | null;
  profile_banner_url: string | null;
};

type ProfilePost = {
  id: number;
  body: string;
  created_at: string;
  mentions?: PostMention[];
};

type ProfileResponse = {
  ok: boolean;
  profile?: AppProfile;
  posts?: ProfilePost[];
  stats?: {
    post_count: number;
    follower_count: number;
    following_count: number;
  };
  error?: string;
};

type SuggestCard = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
};

type HoldingsSummaryResponse = {
  ok: boolean;
  collectionValue?: number;
};

function getOpenSlashRange(text: string, caret: number | null): { start: number; end: number; query: string } | null {
  const safeCaret = caret ?? text.length;
  const before = text.slice(0, safeCaret);
  const slashCount = (before.match(/\//g) ?? []).length;
  if (slashCount % 2 === 0) return null;
  const start = before.lastIndexOf("/");
  if (start < 0) return null;
  return {
    start,
    end: safeCaret,
    query: before.slice(start + 1).trim(),
  };
}

function formatJoined(value: string | undefined): string {
  if (!value) return "Recently";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    year: "numeric",
  }).format(date);
}

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
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatCurrency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

export default function ProfilePage() {
  const { user, isLoaded } = useSafeUser();
  const [appProfile, setAppProfile] = useState<AppProfile | null>(null);
  const [posts, setPosts] = useState<ProfilePost[]>([]);
  const [stats, setStats] = useState({ post_count: 0, follower_count: 0, following_count: 0 });
  const [portfolioValue, setPortfolioValue] = useState<number | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [posting, setPosting] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editingHandle, setEditingHandle] = useState(false);
  const [editingBio, setEditingBio] = useState(false);
  const [editingPostId, setEditingPostId] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [handleDraft, setHandleDraft] = useState("");
  const [bioDraft, setBioDraft] = useState("");
  const [postDraft, setPostDraft] = useState("");
  const [postEditDraft, setPostEditDraft] = useState("");
  const [mentionSuggestions, setMentionSuggestions] = useState<SuggestCard[]>([]);
  const [activeMentionTarget, setActiveMentionTarget] = useState<"composer" | "editor" | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const bannerInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isLoaded || !user) return;
    let cancelled = false;

    setLoadingProfile(true);
    void fetch("/api/profile", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const payload = (await response.json()) as ProfileResponse;
        if (cancelled) return;
        setAppProfile(payload.profile ?? null);
        setPosts(payload.posts ?? []);
        setStats(payload.stats ?? { post_count: 0, follower_count: 0, following_count: 0 });
      })
      .catch(() => {
        if (!cancelled) {
          setAppProfile(null);
          setPosts([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingProfile(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isLoaded, user]);

  useEffect(() => {
    if (!isLoaded || !user) return;
    let cancelled = false;

    void fetch("/api/holdings/summary", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as HoldingsSummaryResponse;
        if (!response.ok || !payload.ok || cancelled) return;
        setPortfolioValue(typeof payload.collectionValue === "number" ? payload.collectionValue : 0);
      })
      .catch(() => {
        if (!cancelled) setPortfolioValue(null);
      });

    return () => {
      cancelled = true;
    };
  }, [isLoaded, user]);

  const displayName = useMemo(
    () => [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.username || "Collector",
    [user?.firstName, user?.lastName, user?.username],
  );
  const handle = appProfile?.handle || user?.username || "popalpha_user";
  const bio = appProfile?.profile_bio || "Tracking the market one card at a time. Watching what's moving, learning what to watch next, and treating the collection like the real thing.";
  const bannerUrl = appProfile?.profile_banner_url || "";
  const joined = formatJoined(appProfile?.created_at);

  useEffect(() => {
    setNameDraft(displayName);
  }, [displayName]);

  useEffect(() => {
    setHandleDraft(handle);
  }, [handle]);

  useEffect(() => {
    setBioDraft(bio);
  }, [bio]);

  useEffect(() => {
    const activeText = activeMentionTarget === "editor" ? postEditDraft : postDraft;
    const activeRef = activeMentionTarget === "editor" ? editorRef.current : composerRef.current;
    const range = getOpenSlashRange(activeText, activeRef?.selectionStart ?? activeText.length);
    const query = range?.query ?? "";

    if (!query) {
      setMentionSuggestions([]);
      return;
    }

    let cancelled = false;
    void fetch(`/api/search/suggest?q=${encodeURIComponent(query)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const payload = await response.json();
        if (!cancelled) {
          setMentionSuggestions((payload.cards ?? []) as SuggestCard[]);
        }
      })
      .catch(() => {
        if (!cancelled) setMentionSuggestions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [activeMentionTarget, postDraft, postEditDraft]);

  if (!isLoaded || loadingProfile) {
    return (
      <PageShell>
        <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
          <div className="overflow-hidden rounded-[2rem] border border-[#1E1E1E] bg-[#101010]">
            <div className="h-40 animate-pulse bg-white/[0.04]" />
            <div className="px-5 py-5">
              <div className="-mt-16 h-24 w-24 animate-pulse rounded-full border-4 border-[#101010] bg-white/[0.06]" />
              <div className="mt-4 h-6 w-40 animate-pulse rounded-full bg-white/[0.05]" />
              <div className="mt-2 h-4 w-28 animate-pulse rounded-full bg-white/[0.04]" />
            </div>
          </div>
        </div>
      </PageShell>
    );
  }

  if (!user) {
    return (
      <PageShell>
        <div className="mx-auto max-w-2xl px-5 py-10 sm:px-8">
          <div className="rounded-[2rem] border border-[#1E1E1E] bg-[#101010] px-6 py-8 text-center">
            <p className="text-[24px] font-semibold tracking-[-0.03em] text-white">Profile</p>
            <p className="mt-3 text-[14px] leading-6 text-[#A3A3A3]">Sign in to see your PopAlpha profile.</p>
            <Link
              href="/sign-in"
              className="mt-5 inline-flex rounded-2xl border border-[#1E1E1E] bg-white/[0.06] px-4 py-2 text-[14px] font-semibold text-white transition hover:bg-white/[0.1]"
            >
              Sign In
            </Link>
          </div>
        </div>
      </PageShell>
    );
  }

  async function onSelectProfileImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const currentUser = user;
    if (!currentUser) return;

    setUploadingImage(true);
    setImageError(null);

    try {
      await currentUser.setProfileImage({ file });
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "Could not update profile photo.");
    } finally {
      setUploadingImage(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  }

  async function onSelectBannerImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadingBanner(true);
    setProfileError(null);

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") resolve(reader.result);
          else reject(new Error("Could not read banner image."));
        };
        reader.onerror = () => reject(new Error("Could not read banner image."));
        reader.readAsDataURL(file);
      });

      const response = await fetch("/api/profile/banner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not upload banner.");
      setAppProfile((current) =>
        current
          ? { ...current, profile_banner_url: payload.bannerUrl ?? null }
          : current,
      );
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Could not upload banner.");
    } finally {
      setUploadingBanner(false);
      if (bannerInputRef.current) bannerInputRef.current.value = "";
    }
  }

  async function saveProfileEdits() {
    const currentUser = user;
    if (!currentUser) return;

    setSavingProfile(true);
    setProfileError(null);

    try {
      const trimmedName = nameDraft.trim();
      const nameParts = trimmedName.split(/\s+/).filter(Boolean);
      await currentUser.update({
        firstName: nameParts[0] ?? "",
        lastName: nameParts.slice(1).join(" ") || null,
      });

      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: handleDraft,
          profileBio: bioDraft,
        }),
      });
      const payload = (await response.json()) as ProfileResponse;
      if (!response.ok || !payload.profile) {
        throw new Error(payload.error || "Could not save profile.");
      }

      setAppProfile(payload.profile);
      setEditingName(false);
      setEditingHandle(false);
      setEditingBio(false);
      posthog.capture("profile_updated", {
        handle: payload.profile.handle,
      });
    } catch (error) {
      posthog.captureException(error);
      setProfileError(error instanceof Error ? error.message : "Could not save profile.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function createPost() {
    const body = postDraft.trim();
    if (!body) return;

    setPosting(true);
    setProfileError(null);
    try {
      const response = await fetch("/api/profile/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.post) {
        throw new Error(payload.error || "Could not publish post.");
      }
      setPosts((current) => [payload.post as ProfilePost, ...current]);
      setStats((current) => ({ ...current, post_count: current.post_count + 1 }));
      setPostDraft("");
      posthog.capture("post_created", {
        post_id: (payload.post as ProfilePost).id,
        body_length: body.length,
      });
    } catch (error) {
      posthog.captureException(error);
      setProfileError(error instanceof Error ? error.message : "Could not publish post.");
    } finally {
      setPosting(false);
    }
  }

  async function savePostEdit(postId: number) {
    const body = postEditDraft.trim();
    if (!body) return;

    setPosting(true);
    setProfileError(null);
    try {
      const response = await fetch(`/api/profile/posts/${postId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.post) {
        throw new Error(payload.error || "Could not save post.");
      }
      setPosts((current) => current.map((post) => (post.id === postId ? payload.post as ProfilePost : post)));
      setEditingPostId(null);
      setPostEditDraft("");
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Could not save post.");
    } finally {
      setPosting(false);
    }
  }

  async function deletePost(postId: number) {
    setPosting(true);
    setProfileError(null);
    try {
      const response = await fetch(`/api/profile/posts/${postId}`, {
        method: "DELETE",
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Could not delete post.");
      }
      setPosts((current) => current.filter((post) => post.id !== postId));
      setStats((current) => ({ ...current, post_count: Math.max(0, current.post_count - 1) }));
      posthog.capture("post_deleted", { post_id: postId });
      if (editingPostId === postId) {
        setEditingPostId(null);
        setPostEditDraft("");
      }
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Could not delete post.");
    } finally {
      setPosting(false);
    }
  }

  function insertMention(card: SuggestCard) {
    const target = activeMentionTarget === "editor" ? "editor" : "composer";
    const text = target === "editor" ? postEditDraft : postDraft;
    const ref = target === "editor" ? editorRef.current : composerRef.current;
    const caret = ref?.selectionStart ?? text.length;
    const range = getOpenSlashRange(text, caret);
    if (!range) return;

    const next = `${text.slice(0, range.start)}/${card.canonical_name}/${text.slice(range.end)}`;
    if (target === "editor") {
      setPostEditDraft(next);
    } else {
      setPostDraft(next);
    }
    setMentionSuggestions([]);
    setActiveMentionTarget(null);
  }

  return (
    <PageShell>
      <div className="mx-auto max-w-3xl px-5 py-6 sm:px-8 sm:py-8">
        <section className="overflow-hidden rounded-[2rem] border border-[#1E1E1E] bg-[#101010]">
        <div
          className="group relative h-40 bg-[radial-gradient(circle_at_top_left,rgba(29,78,216,0.24),transparent_34%),radial-gradient(circle_at_top_right,rgba(49,46,129,0.26),transparent_30%),linear-gradient(180deg,#0F172A_0%,#0A0A0A_72%)] bg-cover bg-center"
          style={bannerUrl ? { backgroundImage: `linear-gradient(180deg, rgba(10,10,10,0.18), rgba(10,10,10,0.68)), url("${bannerUrl}")` } : undefined}
        >
          <button
            type="button"
            onClick={() => !uploadingBanner && bannerInputRef.current?.click()}
            className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/25 px-3 py-1.5 text-[12px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100"
          >
            <Pencil size={12} strokeWidth={2.4} />
            {uploadingBanner ? "Uploading..." : "Edit banner"}
          </button>
          <input
            ref={bannerInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={onSelectBannerImage}
          />
        </div>

        <div className="px-5 pb-5 sm:px-6 sm:pb-6">
          <div className="mb-4 flex justify-end gap-3">
            <Link
              href="/settings"
              className="rounded-2xl border border-[#1E1E1E] bg-white/[0.04] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.08]"
            >
              Settings
            </Link>
            <SignOutButton>
              <button
                type="button"
                className="rounded-2xl border border-[#1E1E1E] bg-white/[0.04] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.08]"
              >
                Sign Out
              </button>
            </SignOutButton>
          </div>

          <div className="-mt-16 flex flex-wrap items-end justify-between gap-4">
            <div className="flex items-end gap-4">
              <div className="group relative">
                <button
                  type="button"
                  onClick={() => !uploadingImage && avatarInputRef.current?.click()}
                  className="relative block h-24 w-24 overflow-hidden rounded-full border-4 border-[#101010] shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
                  aria-label="Edit profile picture"
                >
                  <img src={user.imageUrl} alt={displayName} className="h-full w-full object-cover" />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/55">
                    <span className="flex items-center gap-1 rounded-full border border-white/10 bg-black/0 px-2 py-1 text-[11px] font-semibold text-white opacity-0 transition-all group-hover:bg-black/35 group-hover:opacity-100">
                      <Camera size={12} strokeWidth={2.4} />
                      Edit
                    </span>
                  </span>
                </button>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={onSelectProfileImage}
                />
              </div>

              <div className="pb-2">
                {editingName ? (
                  <input
                    value={nameDraft}
                    onChange={(event) => setNameDraft(event.target.value)}
                    className="w-full rounded-2xl border border-[#1E1E1E] bg-[#090909] px-4 py-3 text-[20px] font-semibold tracking-[-0.03em] text-white outline-none"
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <h1 className="text-[28px] font-semibold tracking-[-0.04em] text-white">{displayName}</h1>
                    <button
                      type="button"
                      onClick={() => setEditingName(true)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#1E1E1E] bg-white/[0.04] text-[#8A8A8A] transition hover:text-white"
                    >
                      <Pencil size={14} strokeWidth={2.4} />
                    </button>
                  </div>
                )}

                {editingHandle ? (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[14px] text-[#8A8A8A]">@</span>
                    <input
                      value={handleDraft}
                      onChange={(event) => setHandleDraft(event.target.value)}
                      className="rounded-2xl border border-[#1E1E1E] bg-[#090909] px-3 py-2 text-[14px] text-white outline-none"
                    />
                  </div>
                ) : (
                  <div className="mt-1 flex items-center gap-2">
                    <p className="text-[14px] text-[#8A8A8A]">@{handle}</p>
                    <button
                      type="button"
                      onClick={() => setEditingHandle(true)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[#1E1E1E] bg-white/[0.04] text-[#8A8A8A] transition hover:text-white"
                    >
                      <Pencil size={12} strokeWidth={2.4} />
                    </button>
                  </div>
                )}

                {uploadingImage ? <p className="mt-1 text-[12px] font-medium text-[#9CCBFF]">Updating photo...</p> : null}
                {imageError ? <p className="mt-1 max-w-xs text-[12px] text-[#FF8A80]">{imageError}</p> : null}
              </div>
            </div>

            {!appProfile?.onboarded ? (
              <Link
                href="/onboarding/handle"
                className="rounded-2xl border border-[#1E1E1E] bg-white/[0.05] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.1]"
              >
                Claim Handle
              </Link>
            ) : null}
          </div>

          <div className="mt-5">
            {editingBio ? (
              <textarea
                value={bioDraft}
                onChange={(event) => setBioDraft(event.target.value)}
                rows={4}
                className="w-full rounded-[1.3rem] border border-[#1E1E1E] bg-[#090909] px-4 py-3 text-[15px] leading-7 text-[#D4D4D4] outline-none"
              />
            ) : (
              <div className="flex items-start gap-2">
                <p className="flex-1 text-[15px] leading-7 text-[#D4D4D4]">{bio}</p>
                <button
                  type="button"
                  onClick={() => setEditingBio(true)}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#1E1E1E] bg-white/[0.04] text-[#8A8A8A] transition hover:text-white"
                >
                  <Pencil size={14} strokeWidth={2.4} />
                </button>
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-5 text-[13px] text-[#8A8A8A]">
              <span>Joined {joined}</span>
              <Link
                href="/portfolio"
                className="font-medium text-[#CFCFCF] transition hover:text-white"
              >
                Portfolio {formatCurrency(portfolioValue)}
              </Link>
              <span>{stats.post_count} Posts</span>
              <span>{stats.following_count} Following</span>
              <span>{stats.follower_count} Followers</span>
            </div>

            {editingName || editingHandle || editingBio ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={saveProfileEdits}
                  disabled={savingProfile}
                  className="rounded-2xl border border-[#1E1E1E] bg-white/[0.08] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.12] disabled:opacity-60"
                >
                  {savingProfile ? "Saving..." : "Save Profile"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingName(false);
                    setEditingHandle(false);
                    setEditingBio(false);
                    setNameDraft(displayName);
                    setHandleDraft(handle);
                    setBioDraft(bio);
                    setProfileError(null);
                  }}
                  className="rounded-2xl border border-[#1E1E1E] px-4 py-2 text-[13px] font-semibold text-[#8A8A8A] transition hover:text-white"
                >
                  Cancel
                </button>
              </div>
            ) : null}

            {profileError ? <p className="mt-3 text-[12px] text-[#FF8A80]">{profileError}</p> : null}
          </div>

          <div className="mt-6 grid grid-cols-3 border-b border-[#1E1E1E]">
            <div className="border-b-2 border-white px-2 py-3 text-center text-[13px] font-semibold text-white">Posts</div>
            <div className="px-2 py-3 text-center text-[13px] font-semibold text-[#6B6B6B]">Collections</div>
            <div className="px-2 py-3 text-center text-[13px] font-semibold text-[#6B6B6B]">Replies</div>
          </div>

          <div className="mt-5 rounded-[1.5rem] border border-[#1E1E1E] bg-[#0B0B0B] p-4">
            <textarea
              ref={composerRef}
              value={postDraft}
              onChange={(event) => {
                setPostDraft(event.target.value.slice(0, 280));
                setActiveMentionTarget("composer");
              }}
              onClick={() => setActiveMentionTarget("composer")}
              onKeyUp={() => setActiveMentionTarget("composer")}
              rows={3}
              placeholder="Share a market thought... Use /Card Name/ to mention a card."
              className="w-full resize-none bg-transparent text-[15px] leading-7 text-white outline-none placeholder:text-[#555]"
            />
            {activeMentionTarget === "composer" && mentionSuggestions.length > 0 ? (
              <div className="mt-3 rounded-[1rem] border border-[#1E1E1E] bg-[#090909] p-2">
                {mentionSuggestions.map((card) => (
                  <button
                    key={card.slug}
                    type="button"
                    onClick={() => insertMention(card)}
                    className="flex w-full items-center justify-between rounded-[0.9rem] px-3 py-2 text-left transition hover:bg-white/[0.04]"
                  >
                    <span className="text-[13px] font-semibold text-white">{card.canonical_name}</span>
                    <span className="text-[11px] text-[#6B6B6B]">{card.set_name ?? ""}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-[12px] text-[#6B6B6B]">{280 - postDraft.length} left</span>
              <button
                type="button"
                onClick={createPost}
                disabled={posting || !postDraft.trim()}
                className="rounded-2xl border border-[#1E1E1E] bg-white/[0.08] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.12] disabled:opacity-60"
              >
                {posting ? "Posting..." : "Post"}
              </button>
            </div>
          </div>

          <div className="px-1 py-6">
            {posts.length === 0 ? (
              <div className="rounded-[1.5rem] border border-dashed border-[#1E1E1E] bg-[#0B0B0B] px-5 py-8 text-center">
                <p className="text-[18px] font-semibold tracking-[-0.03em] text-white">Nothing here yet</p>
                <p className="mt-2 text-[14px] leading-6 text-[#8A8A8A]">
                  Your profile is ready. Start posting market notes and reactions here.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {posts.map((post) => (
                  <article key={post.id} className="rounded-[1.35rem] border border-[#1E1E1E] bg-[#0B0B0B] px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[14px] font-semibold text-white">{displayName}</p>
                      <div className="flex items-center gap-3">
                        <span className="text-[12px] text-[#6B6B6B]">{formatPostTime(post.created_at)}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingPostId(post.id);
                            setPostEditDraft(post.body);
                          }}
                          className="text-[12px] font-semibold text-[#8A8A8A] transition hover:text-white"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => deletePost(post.id)}
                          className="text-[12px] font-semibold text-[#8A8A8A] transition hover:text-[#FF8A80]"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {editingPostId === post.id ? (
                      <div className="mt-3">
                        <textarea
                          ref={editorRef}
                          value={postEditDraft}
                          onChange={(event) => {
                            setPostEditDraft(event.target.value.slice(0, 280));
                            setActiveMentionTarget("editor");
                          }}
                          onClick={() => setActiveMentionTarget("editor")}
                          onKeyUp={() => setActiveMentionTarget("editor")}
                          rows={3}
                          className="w-full rounded-[1rem] border border-[#1E1E1E] bg-[#090909] px-3 py-3 text-[14px] leading-6 text-[#D4D4D4] outline-none"
                        />
                        {activeMentionTarget === "editor" && mentionSuggestions.length > 0 ? (
                          <div className="mt-3 rounded-[1rem] border border-[#1E1E1E] bg-[#090909] p-2">
                            {mentionSuggestions.map((card) => (
                              <button
                                key={card.slug}
                                type="button"
                                onClick={() => insertMention(card)}
                                className="flex w-full items-center justify-between rounded-[0.9rem] px-3 py-2 text-left transition hover:bg-white/[0.04]"
                              >
                                <span className="text-[13px] font-semibold text-white">{card.canonical_name}</span>
                                <span className="text-[11px] text-[#6B6B6B]">{card.set_name ?? ""}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-3 flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => savePostEdit(post.id)}
                            className="rounded-2xl border border-[#1E1E1E] bg-white/[0.08] px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-white/[0.12]"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingPostId(null);
                              setPostEditDraft("");
                            }}
                            className="text-[12px] font-semibold text-[#8A8A8A] transition hover:text-white"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <PostBody body={post.body} mentions={post.mentions ?? []} />
                    )}
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
      </div>
    </PageShell>
  );
}
