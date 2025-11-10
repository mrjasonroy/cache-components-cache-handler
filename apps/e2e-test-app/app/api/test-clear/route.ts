import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Clear all test cookies
 * POST /api/test-clear
 */
export async function POST() {
  const cookieStore = await cookies();
  const allCookies = cookieStore.getAll();

  // Delete all test-id cookies
  for (const cookie of allCookies) {
    if (cookie.name.startsWith("test-id-")) {
      cookieStore.delete(cookie.name);
    }
  }

  return NextResponse.json({
    success: true,
    message: "All test cookies cleared",
  });
}
