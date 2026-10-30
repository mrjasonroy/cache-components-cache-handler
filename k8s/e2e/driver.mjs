import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import Redis from "ioredis";

const pods = process.env.POD_URLS?.split(",") ?? [];
assert.equal(new Set(pods).size, 3, "Exactly three distinct ready pod addresses required");
const service = process.env.APP_URL;
const secret = process.env.E2E_REVALIDATE_SECRET;
assert.ok(service && secret, "APP_URL and E2E_REVALIDATE_SECRET required");
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 0,
  retryStrategy: (attempt) => (attempt <= 30 ? 100 : null),
});
redis.on("error", (error) => process.stderr.write(`${error.message}\n`));
const ids = Array.from({ length: 19 }, (_, i) => `article-${i}`);
const tags = ids.map((id) => `multi-pod-${id}`);
const state = new Map(ids.map((id) => [id, { version: 1, hold: null, started: false }]));
const server = createServer(async (request, response) => {
  if (request.url === "/health") {
    response.end("ready");
    return;
  }
  const entry = state.get(request.url?.slice(1));
  if (!entry) {
    response.writeHead(404).end();
    return;
  }
  const snapshot = entry.version;
  entry.started = true;
  await entry.hold;
  response.end(String(snapshot));
});
const report = (message) => process.stdout.write(`${message}\n`);

async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await sleep(20);
  }
}

async function read(base, id) {
  const response = await fetch(`${base}/e2e/multi-pod/${id}`, {
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, `${base}/${id}`);
  const html = await response.text();
  const match = html.match(/data-testid="version"[^>]*>(\d+)</);
  assert.ok(match, `Missing version in ${base}/${id}: ${html.slice(0, 200)}`);
  return Number(match[1]);
}

async function invalidate(selected) {
  const before = await redis.hmget("multi-pod:tags", ...selected);
  const response = await fetch(`${service}/api/e2e/multi-pod`, {
    method: "POST",
    // A new connection makes the ClusterIP select a backend per webhook.
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify({ tags: selected }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, "CMS webhook status");
  const { pod } = await response.json();
  // HTTP headers can precede Next's pending tag writes. Observe Redis before releasing renders.
  await until(async () => {
    const after = await redis.hmget("multi-pod:tags", ...selected);
    return after.every((record, i) => record && record !== before[i]);
  }, "invalidation committed in Redis");
  return pod;
}

async function freshEverywhere(version, phase) {
  for (const pod of pods) {
    for (const id of ids) {
      const actual = await read(pod, id);
      // Never retry freshness: the first read after invalidation is the contract.
      assert.equal(
        actual,
        version,
        `STALE_CONTENT ${phase} ${pod}/${id}: expected ${version}, got ${actual}`,
      );
    }
  }
  report(`${phase}: ${ids.length} pages × ${pods.length} pods fresh at version ${version}`);
}

let release = () => {};
try {
  await new Promise((resolve) => server.listen(8080, "0.0.0.0", resolve));
  // A ready Redis pod can precede kube-proxy installing its Service routes.
  await until(
    () =>
      redis.ping().then(
        () => true,
        () => false,
      ),
    "Redis Service reachable",
  );
  await until(
    () =>
      fetch("http://driver:8080/health", { signal: AbortSignal.timeout(1000) }).then(
        (response) => response.ok,
        () => false,
      ),
    "origin Service reachable",
  );
  const unauthorized = await fetch(`${service}/api/e2e/multi-pod`, {
    method: "POST",
    body: JSON.stringify({ tags }),
  });
  assert.equal(unauthorized.status, 401, "Webhook must require the Secret");
  await freshEverywhere(1, "warm");
  // One CMS save and one webhook, followed by the first read on every replica.
  for (const entry of state.values()) entry.version = 2;
  await invalidate(tags);
  await freshEverywhere(2, "single save");

  for (let round = 1; round <= 5; round++) {
    const version = round + 2;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    for (const entry of state.values()) {
      entry.hold = held;
      entry.started = false;
    }
    // Evict warm shells before starting controlled renders of the pre-save snapshot.
    await invalidate(tags);
    const renders = ids.map((id, i) => read(pods[(i + round) % pods.length], id));
    // Attach rejection handlers immediately while the renders are deliberately held.
    const finished = Promise.all(renders);
    finished.catch(() => {});
    await until(
      () => [...state.values()].every((entry) => entry.started),
      "all origin snapshots held",
    );
    for (const entry of state.values()) entry.version = version;
    const receivers = new Set();
    const start = Date.now();
    const burst = tags.map(async (tag, i) => {
      await sleep(i * 150);
      receivers.add(await invalidate([tag]));
    });
    await Promise.all(burst);
    report(
      `round ${round}: 19 invalidations committed in ${Date.now() - start}ms; receivers=${[...receivers]}`,
    );
    release();
    const snapshots = await finished;
    assert.ok(
      snapshots.every((snapshot) => snapshot === version - 1),
      "Held renders must contain pre-save data",
    );
    for (const entry of state.values()) entry.hold = null;
    // Let the completed shell writes settle; never poll the page to hide a stale first read.
    await sleep(200);
    await freshEverywhere(version, `burst ${round}`);
  }
  report("MULTI_POD_PASS: single save and five held-render bursts");
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  release();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  redis.disconnect();
}
