import { NextResponse } from "next/server";

/** Process-level healthcheck for Render. Deliberately does not depend on WAHA/Redis. */
export async function GET() {
  return NextResponse.json({ ok: true, service: "deskcomm-web" });
}
