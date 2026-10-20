import { flushCache } from "@mrjasonroy/cache-components-cache-handler";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Test-only flush endpoint, the shape docs/operations.md tells sites to build: the package ships
 * `flushCache`, the route and its auth belong to the app. Disabled unless E2E_FLUSH_TOKEN is set.
 * POST /api/e2e/flush  (Authorization: Bearer <E2E_FLUSH_TOKEN>)
 * Body: { scope?: "build" | "all" }
 */
export async function POST(request: NextRequest) {
  const token = process.env.E2E_FLUSH_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { scope?: string };
  const scope = body.scope === "all" ? "all" : "build";

  try {
    const result = await flushCache({ scope });
    return NextResponse.json({ success: true, scope, ...result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
