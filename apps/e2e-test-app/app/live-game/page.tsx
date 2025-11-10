import { cacheTag } from "next/cache";
import { cookies } from "next/headers";
import { Suspense } from "react";

// Team record - CACHED (remote, 8s DB query)
async function getTeamRecord(testId: string) {
  "use cache: remote";
  cacheTag("team");

  await new Promise((resolve) => setTimeout(resolve, 3000));

  return {
    recordId: testId,
    wins: 45,
    losses: 37,
    timestamp: Date.now(),
  };
}

// Live scores - NOT CACHED (3s API call, always fresh)
async function getLiveScores(testId: string) {
  // No "use cache" - always fetches fresh
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return {
    scoresId: testId,
    homeScore: Math.floor(Math.random() * 100),
    awayScore: Math.floor(Math.random() * 100),
    quarter: Math.floor(Math.random() * 4) + 1,
    timestamp: Date.now(),
  };
}

// Page wrapper - NOT CACHED (2s)
async function getPageData(testId: string) {
  // No "use cache" - wraps everything
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return {
    pageLoadId: testId,
    timestamp: Date.now(),
  };
}

// Team Record Component - Uses cookies, must be in Suspense
async function TeamRecord() {
  const recordId =
    (await cookies()).get("test-id-live-record")?.value || `gen-record-${Date.now()}`;

  const record = await getTeamRecord(recordId);

  return (
    <div data-testid="record-section">
      <h2>Team Record (Cached Remote)</h2>
      <p data-testid="record-id">Record ID: {record.recordId}</p>
      <p>
        Record: {record.wins}W - {record.losses}L
      </p>
      <p>Timestamp: {record.timestamp}</p>
      <p className="cache-indicator">💾 Cached (saves 8s on reload)</p>
    </div>
  );
}

// Live Scores Component - Uses cookies, must be in Suspense
async function LiveScores() {
  const scoresId =
    (await cookies()).get("test-id-live-scores")?.value || `gen-scores-${Date.now()}`;

  const scores = await getLiveScores(scoresId);

  return (
    <div data-testid="scores-section">
      <h2>Live Scores (Not Cached)</h2>
      <p data-testid="scores-id">Scores ID: {scores.scoresId}</p>
      <p>
        Score: {scores.homeScore} - {scores.awayScore}
      </p>
      <p>Quarter: {scores.quarter}</p>
      <p>Timestamp: {scores.timestamp}</p>
      <p className="dynamic-indicator">⚡ Always fresh (3s every load)</p>
    </div>
  );
}

// Page Info Component - Uses cookies, must be in Suspense
async function PageInfo() {
  const pageId = (await cookies()).get("test-id-live-page")?.value || `gen-page-${Date.now()}`;

  const pageData = await getPageData(pageId);

  return (
    <div data-testid="page-section">
      <h2>Page Info (Not Cached)</h2>
      <p data-testid="page-id">Page Load ID: {pageData.pageLoadId}</p>
      <p>Timestamp: {pageData.timestamp}</p>
      <p className="dynamic-indicator">⚡ Always fresh (2s every load)</p>
    </div>
  );
}

function RecordSkeleton() {
  return (
    <div className="skeleton" data-testid="record-skeleton">
      <h2>Loading team record...</h2>
      <div className="skeleton-line" />
      <div className="skeleton-line" />
    </div>
  );
}

function ScoresSkeleton() {
  return (
    <div className="skeleton" data-testid="scores-skeleton">
      <h2>Loading live scores...</h2>
      <div className="skeleton-line" />
      <div className="skeleton-line" />
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="skeleton" data-testid="page-skeleton">
      <h2>Loading page info...</h2>
      <div className="skeleton-line" />
    </div>
  );
}

export default function LiveGamePage() {
  return (
    <div>
      <h1>Live Game: Nested Caching with Suspense</h1>

      <p className="instruction">
        <strong>Pattern:</strong> All components use cookies (dynamic API) and are wrapped in
        Suspense. This demonstrates:
      </p>
      <ul className="instruction">
        <li>✅ Dynamic APIs work correctly with Suspense boundaries</li>
        <li>✅ Cached components (Team Record) save time even in dynamic context</li>
        <li>✅ Uncached components (Scores, Page) always stream fresh</li>
      </ul>

      <hr />

      {/* Page Info - 2s, not cached */}
      <Suspense fallback={<PageSkeleton />}>
        <PageInfo />
      </Suspense>

      <hr />

      {/* Live Scores - 3s, not cached */}
      <Suspense fallback={<ScoresSkeleton />}>
        <LiveScores />
      </Suspense>

      <hr />

      {/* Team Record - 8s, CACHED! */}
      <Suspense fallback={<RecordSkeleton />}>
        <TeamRecord />
      </Suspense>

      <hr />

      <div className="instruction">
        <h3>Expected Behavior:</h3>
        <ul>
          <li>
            <strong>First load:</strong> All components stream in (max time: 8s for Team Record)
          </li>
          <li>
            <strong>Second load:</strong> Team Record cached (instant!), Page + Scores still stream
            (max time: 3s)
          </li>
          <li>
            <strong>After revalidateTag(&quot;team&quot;):</strong> Back to 8s (Team Record
            refetches)
          </li>
        </ul>
      </div>

      <a href="/">Back to home</a>
    </div>
  );
}
