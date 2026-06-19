import Image from "next/image";

/**
 * Renders a user's avatar across activity surfaces (feed rows, comments,
 * notifications). Shows the PopAlpha-stored picture when set, otherwise a
 * handle-initial monogram — the single place that decides that fallback so
 * the surfaces stay consistent.
 */
export default function ActorAvatar({
  avatarUrl,
  avatarInitial,
  size = 36,
  className = "",
}: {
  avatarUrl: string | null;
  avatarInitial: string;
  size?: number;
  className?: string;
}) {
  const dimension = { width: size, height: size };

  if (avatarUrl) {
    return (
      <Image
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        style={dimension}
        className={`shrink-0 rounded-full bg-white/[0.06] object-cover ${className}`}
      />
    );
  }

  return (
    <div
      style={{ ...dimension, fontSize: Math.round(size * 0.4) }}
      className={`flex shrink-0 items-center justify-center rounded-full bg-white/[0.06] font-semibold text-white ${className}`}
    >
      {avatarInitial}
    </div>
  );
}
