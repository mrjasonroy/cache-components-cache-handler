// Test page for legacy fetch() caching (without cacheComponents)
export default async function HomePage() {
  // Test 1: fetch with force-cache
  const res1 = await fetch("https://api.github.com/repos/vercel/next.js", {
    cache: "force-cache",
  });
  const data1 = await res1.json();

  // Test 2: fetch with revalidate
  const res2 = await fetch("https://api.github.com/users/vercel", {
    next: { revalidate: 3600 },
  });
  const data2 = await res2.json();

  return (
    <div style={{ padding: "2rem" }}>
      <h1>Legacy Cache Test (cacheComponents: false)</h1>

      <div style={{ marginTop: "2rem" }}>
        <h2>Test 1: fetch with force-cache</h2>
        <p data-testid="repo-name">Repo: {data1.name}</p>
        <p data-testid="repo-stars">Stars: {data1.stargazers_count}</p>
        <p>Timestamp: {new Date().toISOString()}</p>
      </div>

      <div style={{ marginTop: "2rem" }}>
        <h2>Test 2: fetch with revalidate (3600s)</h2>
        <p data-testid="user-name">User: {data2.login}</p>
        <p>Timestamp: {new Date().toISOString()}</p>
      </div>

      <p style={{ marginTop: "2rem", fontSize: "0.875rem", color: "#666" }}>
        Reload the page - if caching works, timestamps should stay the same and cache handler should
        log "HIT" in the terminal.
      </p>
    </div>
  );
}
