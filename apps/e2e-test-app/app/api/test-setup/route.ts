import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Test setup endpoint - sets stable test IDs for cache verification
 * POST /api/test-setup
 * Body: { testId: string, scenario: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { testId, scenario } = body;

  if (!testId || !scenario) {
    return NextResponse.json({ error: "testId and scenario are required" }, { status: 400 });
  }

  // Store test ID in cookie for this test run
  (await cookies()).set(`test-id-${scenario}`, testId, {
    maxAge: 3600, // 1 hour
    httpOnly: true,
  });

  return NextResponse.json({
    success: true,
    testId,
    scenario,
    message: `Test ID set for scenario: ${scenario}`,
  });
}

/**
 * GET - retrieve current test ID for a scenario
 */
export async function GET(request: NextRequest) {
  const scenario = request.nextUrl.searchParams.get("scenario");

  if (!scenario) {
    return NextResponse.json({ error: "scenario parameter required" }, { status: 400 });
  }

  const testId = (await cookies()).get(`test-id-${scenario}`)?.value;

  return NextResponse.json({
    scenario,
    testId: testId || null,
  });
}
