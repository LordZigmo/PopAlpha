import Image from "next/image";

type PhoneFrameProps = {
  src: string;
  alt: string;
  /** Tailwind width class wrapper sets the size; aspect ratio fixes the height. */
  className?: string;
  priority?: boolean;
  sizes?: string;
};

/**
 * A single iPhone device frame (titanium bezel, dynamic island, liquid-glass
 * glare) showing a real app screenshot. Width comes from the parent via
 * `className` (e.g. `w-[300px]`); the 9:19.3 aspect ratio sets the height.
 */
export default function PhoneFrame({
  src,
  alt,
  className = "",
  priority = false,
  sizes = "(max-width: 1024px) 80vw, 320px",
}: PhoneFrameProps) {
  return (
    <div className={`relative aspect-[9/19.3] ${className}`}>
      <div
        className="relative h-full w-full rounded-[2.7rem] border border-white/12 p-[3px]"
        style={{
          background: "linear-gradient(150deg,#3A3F4A 0%,#15181F 28%,#0A0C11 60%,#1B1F27 100%)",
          boxShadow: "0 44px 84px -30px rgba(0,0,0,0.92), 0 0 0 1px rgba(255,255,255,0.04) inset",
        }}
      >
        <div className="relative h-full w-full overflow-hidden rounded-[2.45rem] bg-black">
          <Image
            src={src}
            alt={alt}
            fill
            sizes={sizes}
            priority={priority}
            className="object-cover object-top"
          />

          {/* dynamic island */}
          <div className="absolute left-1/2 top-2.5 z-20 h-[22px] w-[88px] -translate-x-1/2 rounded-full bg-black">
            <span className="absolute right-3 top-1/2 h-[7px] w-[7px] -translate-y-1/2 rounded-full bg-[#10151C]" />
          </div>

          {/* liquid-glass screen glare */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-[2.45rem] bg-[linear-gradient(125deg,rgba(255,255,255,0.16)_0%,rgba(255,255,255,0)_30%,rgba(255,255,255,0)_72%,rgba(255,255,255,0.05)_100%)]"
          />
        </div>
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[2.7rem] ring-1 ring-inset ring-white/[0.07]"
      />
    </div>
  );
}
