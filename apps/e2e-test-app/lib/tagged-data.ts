import { cacheTag } from "next/cache";

// E2E-201-202: Tag-based revalidation

export async function getTaggedData(tag: string) {
  "use cache";
  cacheTag(tag);

  await new Promise((resolve) => setTimeout(resolve, 100));

  return {
    tag,
    timestamp: new Date().toISOString(),
    randomValue: Math.random(),
  };
}
