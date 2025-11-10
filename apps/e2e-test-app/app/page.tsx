export default function Home() {
  return (
    <div>
      <h1>Cache Handler E2E Tests</h1>
      <nav>
        <ul>
          <li>
            <a href="/cached-component">E2E-001: Cached Component</a>
          </li>
          <li>
            <a href="/cached-page">E2E-002: Cached Page</a>
          </li>
          <li>
            <a href="/cached-function">E2E-003: Cached Function</a>
          </li>
          <li>
            <a href="/suspense-with">E2E-101: With Suspense</a>
          </li>
          <li>
            <a href="/suspense-without">E2E-103: Without Suspense (should error)</a>
          </li>
          <li>
            <a href="/revalidate-test">E2E-201-202: Revalidation</a>
          </li>
        </ul>
      </nav>
    </div>
  );
}
