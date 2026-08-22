import {
  LOGIN_LOGO_PART_1,
} from "@/lib/branding/login-logo-part1";
import {
  LOGIN_LOGO_PART_2,
} from "@/lib/branding/login-logo-part2";
import {
  LOGIN_LOGO_PART_3,
} from "@/lib/branding/login-logo-part3";
import {
  LOGIN_LOGO_PART_4,
} from "@/lib/branding/login-logo-part4";

export const dynamic = "force-static";

export function GET() {
  const base64 =
    LOGIN_LOGO_PART_1 +
    LOGIN_LOGO_PART_2 +
    LOGIN_LOGO_PART_3 +
    LOGIN_LOGO_PART_4;

  const image = Buffer.from(base64, "base64");

  return new Response(image, {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": String(image.byteLength),
    },
  });
}
