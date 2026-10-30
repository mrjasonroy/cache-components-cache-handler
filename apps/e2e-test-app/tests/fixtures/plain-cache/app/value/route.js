import { cacheLife, cacheTag, revalidateTag } from "next/cache";

async function readValue(origin, id) {
  "use cache";
  cacheTag(`plain-${id}`);
  cacheLife({ stale: 0, revalidate: 300, expire: 600 });
  const response = await fetch(`${origin}/${id}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Test origin failed");
  return response.text();
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const value = await readValue(params.get("origin"), params.get("id"));
  return Response.json({ value });
}

export async function POST(request) {
  const { id } = await request.json();
  revalidateTag(`plain-${id}`, { expire: 0 });
  return Response.json({ revalidated: true });
}
