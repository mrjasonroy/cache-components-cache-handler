import { afterEach, describe, expect, test, vi } from "vitest";
import { calculateLifespan, isExpired } from "./lifespan.js";

const MOCK_TIME = new Date("2024-01-02T03:04:05.000Z");

describe("lifespan helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("calculateLifespan returns null when revalidate is false", () => {
    expect(calculateLifespan(false)).toBeNull();
  });

  test("calculateLifespan uses provided revalidate seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(MOCK_TIME);

    const lifespan = calculateLifespan(300);

    expect(lifespan).toEqual({
      lastModifiedAt: Math.floor(MOCK_TIME.getTime() / 1000),
      staleAt: Math.floor(MOCK_TIME.getTime() / 1000) + 300,
      expireAt: Math.floor(MOCK_TIME.getTime() / 1000) + 300,
      staleAge: 300,
      expireAge: 300,
      revalidate: 300,
    });
  });

  test("calculateLifespan uses defaultTTL when revalidate is undefined", () => {
    vi.useFakeTimers();
    vi.setSystemTime(MOCK_TIME);

    const lifespan = calculateLifespan(undefined, 120);

    expect(lifespan).toEqual({
      lastModifiedAt: Math.floor(MOCK_TIME.getTime() / 1000),
      staleAt: Math.floor(MOCK_TIME.getTime() / 1000) + 120,
      expireAt: Math.floor(MOCK_TIME.getTime() / 1000) + 120,
      staleAge: 120,
      expireAge: 120,
      revalidate: undefined,
    });
  });

  test("calculateLifespan returns null without ttl information", () => {
    expect(calculateLifespan(undefined, undefined)).toBeNull();
  });

  test("isExpired respects null lifespan", () => {
    expect(isExpired(null)).toBe(false);
  });

  test("isExpired returns false when entry has not expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(MOCK_TIME);

    const lifespan = calculateLifespan(60);
    expect(lifespan).not.toBeNull();
    expect(isExpired(lifespan)).toBe(false);
  });

  test("isExpired returns true when current time passes expireAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(MOCK_TIME);

    const lifespan = calculateLifespan(1);
    expect(lifespan).not.toBeNull();

    vi.setSystemTime(new Date(MOCK_TIME.getTime() + 2_000));
    expect(isExpired(lifespan)).toBe(true);
  });
});
