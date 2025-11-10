import { revalidateTag } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Revalidate cache by tag
 * POST /api/revalidate-tag
 * Body: { tag: string, profile?: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { tag, profile } = body;

  if (!tag) {
    return NextResponse.json({ error: "tag is required" }, { status: 400 });
  }

  try {
    // Call revalidateTag with profile parameter
    // undefined = immediate expiration (deprecated, for testing)
    // "max" = stale-while-revalidate (recommended for production)
    revalidateTag(tag, profile === "immediate" ? undefined : profile);

    return NextResponse.json({
      success: true,
      tag,
      profile: profile || "immediate",
      message: `Tag "${tag}" revalidated`,
      timestamp: Date.now(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
