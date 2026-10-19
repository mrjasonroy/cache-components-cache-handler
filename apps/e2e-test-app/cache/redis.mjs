import Redis from "ioredis";

// One client for both custom handler files (the escape hatch in the README). Next can load the
// two handler modules separately, so the client is parked on globalThis to keep it to one
// connection per process.
const globalKey = Symbol.for("e2e-test-app.redis-client");

if (!globalThis[globalKey]) {
  globalThis[globalKey] = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
}

/** @type {import("ioredis").Redis} */
export const client = globalThis[globalKey];
