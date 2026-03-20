import { createBrandIconResponse } from "./brand-image";

export const size = {
  width: 512,
  height: 512,
};

export const contentType = "image/png";

export default function Icon() {
  return createBrandIconResponse(size.width);
}
