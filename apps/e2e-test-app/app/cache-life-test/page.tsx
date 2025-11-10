import {
  getBiweeklyProfileData,
  getDaysProfileData,
  getHoursProfileData,
  getInlineProfileData,
  getMaxProfileData,
  getMinutesProfileData,
  getSecondsProfileData,
  getShortProfileData,
  getTimestampData,
  getWeeksProfileData,
} from "@/lib/cache-life-data";

// Test page for cacheLife profiles
export default async function CacheLifeTestPage({
  searchParams,
}: {
  searchParams: { profile?: string; id?: string };
}) {
  const id = searchParams.id || "default";
  const profile = searchParams.profile || "default";

  let data: Awaited<ReturnType<typeof getTimestampData>>;

  switch (profile) {
    case "seconds":
      data = await getSecondsProfileData(id);
      break;
    case "minutes":
      data = await getMinutesProfileData(id);
      break;
    case "hours":
      data = await getHoursProfileData(id);
      break;
    case "days":
      data = await getDaysProfileData(id);
      break;
    case "weeks":
      data = await getWeeksProfileData(id);
      break;
    case "max":
      data = await getMaxProfileData(id);
      break;
    case "inline":
      data = await getInlineProfileData(id);
      break;
    case "biweekly":
      data = await getBiweeklyProfileData(id);
      break;
    case "short":
      data = await getShortProfileData(id);
      break;
    default:
      data = await getTimestampData(id);
  }

  return (
    <div>
      <h1>cacheLife() Test Page</h1>
      <div data-testid="cache-life-content">
        <p data-testid="profile">Profile: {profile}</p>
        <p data-testid="id">ID: {data.id}</p>
        <p data-testid="timestamp">Timestamp: {data.timestamp}</p>
        <p data-testid="random">Random: {data.random}</p>
      </div>
    </div>
  );
}
