import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PopAlpha",
    short_name: "PopAlpha",
    description: "Premium collectibles intelligence for Pokemon card collectors.",
    start_url: "/",
    display: "standalone",
    background_color: "#090909",
    theme_color: "#090909",
    icons: [
      {
        src: "/icon?v=5",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/apple-icon?v=5",
        sizes: "180x180",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
