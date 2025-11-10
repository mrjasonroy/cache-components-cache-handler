import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

export async function POST() {
  // E2E-201: revalidateTag - delayed invalidation with stale-while-revalidate
  revalidateTag("test-tag", "max");

  return NextResponse.json({ revalidated: true, type: "revalidateTag" });
}
