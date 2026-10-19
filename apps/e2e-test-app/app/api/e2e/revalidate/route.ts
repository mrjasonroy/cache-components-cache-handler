import { revalidatePath, revalidateTag } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Revalidate by tag (immediate expiry) or by path, on whichever instance receives the request.
 * POST /api/e2e/revalidate
 * Body: { tag?: string, path?: string }
 */
export async function POST(request: NextRequest) {
  const { tag, path } = (await request.json()) as { tag?: string; path?: string };

  if (!tag && !path) {
    return NextResponse.json({ error: "tag or path is required" }, { status: 400 });
  }

  if (tag) {
    revalidateTag(tag, { expire: 0 });
  }
  if (path) {
    revalidatePath(path);
  }

  return NextResponse.json({ success: true, tag: tag ?? null, path: path ?? null });
}
