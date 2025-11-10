import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Revalidate all caches under a path
 * POST /api/revalidate-path
 * Body: { path: string, type?: "page" | "layout" }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { path, type } = body;

  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  try {
    // Revalidate the path with optional type
    if (type) {
      revalidatePath(path, type);
    } else {
      revalidatePath(path);
    }

    return NextResponse.json({
      success: true,
      path,
      type: type || "default",
      message: `Path "${path}" revalidated`,
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
