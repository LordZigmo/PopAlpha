import { createSocialImageResponse } from "./brand-image";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";
export const alt = "PopAlpha";

export default function TwitterImage() {
  return createSocialImageResponse({
    eyebrow: "Collector Signal",
    title: "PopAlpha",
    subtitle: "Make collectibles feel legible, modern, and intelligent.",
  });
}
