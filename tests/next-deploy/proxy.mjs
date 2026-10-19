#!/usr/bin/env node
// Round-robin HTTP proxy in front of several `next start` instances, so every harness request
// can land on a different process and only shared (Redis) state carries across.
//
//   node proxy.mjs <listenPort> <upstreamPort> [<upstreamPort> ...]
//
// The Host header is passed through unchanged, so absolute URLs and redirects point back at the
// proxy. Each response carries `x-next-deploy-instance` (the upstream port) for debugging.
import http from "node:http";

const [listenPort, ...upstreamPorts] = process.argv.slice(2).map(Number);
if (!listenPort || upstreamPorts.length === 0) {
  console.error("usage: proxy.mjs <listenPort> <upstreamPort> [<upstreamPort> ...]");
  process.exit(2);
}

const agent = new http.Agent({ keepAlive: true });
let turn = 0;

const server = http.createServer((req, res) => {
  const port = upstreamPorts[turn++ % upstreamPorts.length];
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers: req.headers,
      agent,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, {
        ...upstreamRes.headers,
        "x-next-deploy-instance": String(port),
      });
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (error) => {
    console.error(`[proxy] ${req.method} ${req.url} -> :${port} failed: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end("bad gateway");
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
});

server.listen(listenPort, () => {
  console.log(`[proxy] :${listenPort} -> ${upstreamPorts.map((p) => `:${p}`).join(", ")}`);
});
