import { revalidatePath, revalidateTag } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

type Profile = "expire-0" | "none" | "max";

/**
 * Next 16 types `revalidateTag`'s profile as required, but a call without one is still supported
 * (deprecated, with a warning): it reaches the handlers' `updateTags` with no durations.
 */
const revalidateTagWithoutProfile = revalidateTag as (tag: string) => undefined;

/**
 * Revalidate by tag or by path, on whichever instance receives the request.
 * POST /api/e2e/revalidate
 * Body: { tag?: string, path?: string, profile?: "expire-0" | "none" | "max" }
 *
 * `profile` only applies to `tag`: "expire-0" (default) → `revalidateTag(tag, { expire: 0 })`,
 * "none" → `revalidateTag(tag)`, "max" → `revalidateTag(tag, "max")`.
 */
export async function POST(request: NextRequest) {
  const {
    tag,
    path,
    profile = "expire-0",
  } = (await request.json()) as { tag?: string; path?: string; profile?: Profile };

  if (!tag && !path) {
    return NextResponse.json({ error: "tag or path is required" }, { status: 400 });
  }
  if (profile !== "expire-0" && profile !== "none" && profile !== "max") {
    return NextResponse.json({ error: `unknown profile: ${String(profile)}` }, { status: 400 });
  }

  if (tag) {
    if (profile === "none") {
      revalidateTagWithoutProfile(tag);
    } else {
      revalidateTag(tag, profile === "max" ? "max" : { expire: 0 });
    }
  }
  if (path) {
    revalidatePath(path);
  }

  return NextResponse.json({ success: true, tag: tag ?? null, path: path ?? null, profile });
}
