"use server";

import { revalidateTag, updateTag } from "next/cache";

const DEFAULT_TAG = "test-tag";

export async function revalidateTestTag(tag: string = DEFAULT_TAG) {
  revalidateTag(tag, "max");
  return { revalidated: true, type: "revalidateTag", tag };
}

export async function updateTestTag(tag: string = DEFAULT_TAG) {
  updateTag(tag);
  return { updated: true, type: "updateTag", tag };
}
