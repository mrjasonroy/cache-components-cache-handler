import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { fromNextClock, nowMs, setClockForTests, toNextClock } from "./clock.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The source files a handler call can reach: everything but tests and test helpers. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "testing" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("clock", () => {
  afterEach(() => {
    Reflect.deleteProperty(performance, "timeOrigin");
    setClockForTests(() => Date.now());
  });

  test("tracks wall time in whole milliseconds, though the performance clock is 5 s off", () => {
    setClockForTests(undefined);
    for (const skew of [5_000, -5_000]) {
      Object.defineProperty(performance, "timeOrigin", {
        value: performance.timeOrigin + skew,
        configurable: true,
      });
      const before = Date.now();
      const now = nowMs();
      expect(Number.isInteger(now)).toBe(true);
      expect(now).toBeGreaterThanOrEqual(before - 1);
      expect(now).toBeLessThanOrEqual(Date.now() + 1);
      // Next's clock is the skewed one.
      expect(
        Math.abs(toNextClock(now) - (performance.timeOrigin + performance.now())),
      ).toBeLessThan(2);
      expect(fromNextClock(toNextClock(now))).toBe(now);
      Reflect.deleteProperty(performance, "timeOrigin");
    }
  });

  // Next aborts a prerender that reads the time through `Date` (see clock.ts).
  test("no source file reads the time through Date: they use nowMs()", () => {
    const reads = /\bDate\.now\s*\(|\bnew\s+Date\s*\(|(?<![\w.])Date\s*\(/;
    const hits = sourceFiles(SRC)
      .filter((file) => !file.endsWith(join("shared", "clock.ts")))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, index) => ({ line: line.trim(), at: `${relative(SRC, file)}:${index + 1}` }))
          .filter(({ line }) => !line.startsWith("*") && !line.startsWith("//"))
          .filter(({ line }) => reads.test(line))
          .map(({ at, line }) => `${at}: ${line}`),
      );
    expect(hits).toEqual([]);
  });
});
