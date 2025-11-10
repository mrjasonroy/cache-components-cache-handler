import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id") || "default";

  // Simulate a slow API call
  await new Promise((resolve) => setTimeout(resolve, 100));

  return NextResponse.json({
    id,
    timestamp: new Date().toISOString(),
    random: Math.random(),
    message: "Test data from API",
  });
}
