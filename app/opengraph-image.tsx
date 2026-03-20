import { createSocialImageResponse } from "./brand-image";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";
export const alt = "PopAlpha";

export default function OpenGraphImage() {
  return createSocialImageResponse({
    eyebrow: "Collectibles Intelligence",
    title: "PopAlpha",
    subtitle: "Premium signals, fair pricing, and collector context in seconds.",
  });
}
