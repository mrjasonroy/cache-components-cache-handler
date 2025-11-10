"use server";

import { revalidateTag, updateTag } from "next/cache";

export async function revalidateTestTag() {
  revalidateTag("test-tag", "max");
  return { revalidated: true, type: "revalidateTag" };
}

export async function updateTestTag() {
  updateTag("test-tag");
  return { updated: true, type: "updateTag" };
}
