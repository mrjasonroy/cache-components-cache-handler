import { cacheTag } from "next/cache";
import { cookies } from "next/headers";
import { Suspense } from "react";

// Static cached header (no dynamic APIs)
async function getStaticHeader() {
  "use cache: remote";
  cacheTag("static-header");

  await new Promise((resolve) => setTimeout(resolve, 3000));

  return {
    title: "Dynamic Suspense Test",
    subtitle: "Static shell + Dynamic user content",
    timestamp: Date.now(),
  };
}

// Dynamic user session (uses cookies - MUST be in Suspense)
async function UserSession() {
  // This component uses cookies() - it MUST be wrapped in Suspense
  const testId = (await cookies()).get("test-id-user-session")?.value || `gen-user-${Date.now()}`;

  // Simulate fetching user data (NOT cached, always fresh)
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const timestamp = Date.now();

  return (
    <div data-testid="user-section">
      <h2>User Session (Dynamic)</h2>
      <p data-testid="user-id">User ID: {testId}</p>
      <p data-testid="user-timestamp">Timestamp: {timestamp}</p>
      <p className="dynamic-indicator">⚡ Streams on every request</p>
    </div>
  );
}

// Cached user preferences (remote cache, uses cookie for testId)
async function getCachedPreferences(testId: string) {
  "use cache: remote";
  cacheTag("user-prefs");

  // Simulate slow DB query
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const timestamp = Date.now();

  return {
    prefsId: testId,
    theme: "dark",
    language: "en",
    timestamp,
  };
}

async function UserPreferences() {
  const testId = (await cookies()).get("test-id-user-prefs")?.value || `gen-prefs-${Date.now()}`;
  console.log("testId", testId);

  const prefs = await getCachedPreferences(testId);

  return (
    <div data-testid="prefs-section">
      <h2>User Preferences (Cached Remote)</h2>
      <p data-testid="prefs-id">Prefs ID: {prefs.prefsId}</p>
      <p>Theme: {prefs.theme}</p>
      <p data-testid="prefs-timestamp">Timestamp: {prefs.timestamp}</p>
      <p className="cache-indicator">💾 Cached after first load</p>
    </div>
  );
}

function UserSkeleton() {
  return (
    <div className="skeleton">
      <h2>Loading user data...</h2>
      <div className="skeleton-line" />
      <div className="skeleton-line" />
    </div>
  );
}

function PrefsSkeleton() {
  return (
    <div className="skeleton">
      <h2>Loading preferences...</h2>
      <div className="skeleton-line" />
      <div className="skeleton-line" />
    </div>
  );
}

// Static header component wrapped for caching
async function StaticHeader() {
  const header = await getStaticHeader();

  return (
    <div data-testid="static-header">
      <h1>{header.title}</h1>
      <p>{header.subtitle}</p>
      <p data-testid="header-timestamp">Header Timestamp: {header.timestamp}</p>
      <p className="cache-indicator">💾 Cached (static shell)</p>
    </div>
  );
}

function HeaderSkeleton() {
  return (
    <div className="skeleton">
      <h1>Loading...</h1>
      <div className="skeleton-line" />
    </div>
  );
}

export default async function DynamicSuspensePage() {
  return (
    <div>
      <Suspense fallback={<HeaderSkeleton />}>
        <StaticHeader />
      </Suspense>

      <hr />

      {/* Dynamic content - MUST be wrapped in Suspense */}
      <Suspense fallback={<UserSkeleton />}>
        <UserSession />
      </Suspense>

      <hr />

      {/* Cached dynamic content - Uses cookies but result is cached */}
      <Suspense fallback={<PrefsSkeleton />}>
        <UserPreferences />
      </Suspense>

      <hr />

      <div className="instruction">
        <h3>How This Works:</h3>
        <ul>
          <li>
            <strong>Static Header:</strong> Cached (3s → &lt;1s). Pre-renders as part of static
            shell.
          </li>
          <li>
            <strong>User Session:</strong> NOT cached. Always takes 2s. Streams on every request.
          </li>
          <li>
            <strong>User Preferences:</strong> Cached (3s → &lt;1s). Uses cookies for testId but
            result is cached.
          </li>
        </ul>
        <p>
          <strong>Key Pattern:</strong> Static shell renders instantly, dynamic content streams in
          with fallback UI.
        </p>
      </div>

      <a href="/">Back to home</a>
    </div>
  );
}
