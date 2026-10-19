import { describe, expect, test } from "vitest";
import { isImplicitTag } from "./is-implicit-tag.js";

describe("isImplicitTag", () => {
  test("returns true for tags with implicit prefix", () => {
    expect(isImplicitTag("_N_T_internal")).toBe(true);
  });

  test("returns false for regular tags", () => {
    expect(isImplicitTag("user:123")).toBe(false);
  });

  test("returns false for non-string inputs", () => {
    expect(isImplicitTag(null as unknown as string)).toBe(false);
    expect(isImplicitTag(undefined as unknown as string)).toBe(false);
  });
});
