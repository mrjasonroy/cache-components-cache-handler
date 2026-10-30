import { revalidateTag } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

/** Test-only CMS webhook; the kind Secret supplies its bearer token. */
export async function POST(request: NextRequest) {
  const secret = process.env.E2E_REVALIDATE_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  const tags = body && typeof body === "object" && "tags" in body ? body.tags : null;
  if (
    !Array.isArray(tags) ||
    tags.length === 0 ||
    tags.length > 19 ||
    !tags.every((tag): tag is string => typeof tag === "string" && /^multi-pod-[\w-]+$/.test(tag))
  ) {
    return NextResponse.json({ error: "Expected 1–19 multi-pod tags" }, { status: 400 });
  }
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  return NextResponse.json({ pod: process.env.POD_NAME, tags });
}
