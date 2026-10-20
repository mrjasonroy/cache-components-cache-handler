import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
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

/**
 * A read of the time through `Date`: `Date.now` called or taken as a reference, `new Date` with or
 * without parentheses, `Date()`, or `now` destructured from `Date`.
 */
const DATE_READ =
  /(?<![\w.])Date\.now\b|\bnew\s+Date\b|(?<![\w.])Date\s*\(|\{[^}]*\bnow\b[^}]*\}\s*=\s*Date\b/;

describe("clock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(performance, "timeOrigin");
    setClockForTests(() => Date.now());
  });

  test("tracks wall time in whole milliseconds, though the performance clock is 5 s off", () => {
    setClockForTests(undefined);
    // Both clocks are held still, so nothing depends on how fast the runner is.
    const wall = 1_800_000_000_000;
    const origin = performance.timeOrigin;
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    // Next's clock reads the wall time plus a fraction of a millisecond.
    vi.spyOn(performance, "now").mockImplementation(() => wall - origin + 0.4);
    for (const skew of [5_000, -5_000]) {
      Object.defineProperty(performance, "timeOrigin", {
        value: origin + skew,
        configurable: true,
      });
      const now = nowMs();
      expect(now).toBe(wall);
      // Next's clock is the skewed one: the conversion lands within its fraction of it.
      const nextClock = performance.timeOrigin + performance.now();
      expect(Math.abs(toNextClock(now) - nextClock)).toBeLessThan(1);
      expect(fromNextClock(toNextClock(now))).toBe(now);
      Reflect.deleteProperty(performance, "timeOrigin");
    }
  });

  test("a time converted to Next's clock and back is the same millisecond, whatever the offset's fraction", () => {
    setClockForTests(undefined);
    const wall = 1_800_000_000_000;
    const origin = performance.timeOrigin;
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    const time = wall - 60_000;
    // The performance clock moves within one wall millisecond between the two conversions, so
    // each measures a slightly different fraction.
    for (let step = 0; step < 100; step++) {
      elapsed = wall - origin - step / 100;
      const onNext = toNextClock(time);
      elapsed += 0.37;
      expect(fromNextClock(onNext)).toBe(time);
    }
  });

  test("without Next (Date native, nothing to require): re-anchors to wall time", async () => {
    expect(Function.prototype.toString.call(Date)).toContain("[native code]");
    vi.resetModules();
    vi.doMock("./node-require.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./node-require.js")>()),
      loadedModule: () => {
        throw new Error("Cannot find module 'next'");
      },
    }));
    try {
      const fresh = await import("./clock.js");
      const wall = 1_800_000_000_000;
      const origin = performance.timeOrigin;
      vi.spyOn(Date, "now").mockImplementation(() => wall);
      vi.spyOn(performance, "now").mockImplementation(() => wall - origin + 0.4);
      Object.defineProperty(performance, "timeOrigin", {
        value: origin + 5_000,
        configurable: true,
      });
      expect(fresh.nowMs()).toBe(wall);
    } finally {
      vi.doUnmock("./node-require.js");
      vi.resetModules();
    }
  });

  test("the Date guard catches a read taken as a reference, not only a call", () => {
    for (const read of [
      "const now = Date.now;",
      "setInterval(Date.now, 1000);",
      "times.map(Date.now)",
      "const { now } = Date;",
      "const stamp = new Date;",
      "Date.now()",
      "new Date()",
      "String(Date())",
    ]) {
      expect(DATE_READ.test(read), read).toBe(true);
    }
    for (const fine of ["isDate(value)", "entry.Date.now", "toDate(1)", "const date = 1;"]) {
      expect(DATE_READ.test(fine), fine).toBe(false);
    }
  });

  // Next aborts a prerender that reads the time through `Date` (see clock.ts).
  test("no source file reads the time through Date: they use nowMs()", () => {
    const reads = DATE_READ;
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
