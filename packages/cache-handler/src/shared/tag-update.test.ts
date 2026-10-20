import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  UPDATE_EXPIRING_TAGS_SCRIPT,
  UPDATE_EXPIRING_TAGS_SHA,
  UPDATE_TAGS_SCRIPT,
  UPDATE_TAGS_SHA,
  mergeUpdate,
  updateArgs,
} from "./tag-update.js";

describe("UPDATE_TAGS_SCRIPT", () => {
  test("UPDATE_TAGS_SHA is the script's SHA1", () => {
    expect(createHash("sha1").update(UPDATE_TAGS_SCRIPT).digest("hex")).toBe(UPDATE_TAGS_SHA);
  });

  test("field-expiring variant SHA1 matches the script", () => {
    expect(createHash("sha1").update(UPDATE_EXPIRING_TAGS_SCRIPT).digest("hex")).toBe(
      UPDATE_EXPIRING_TAGS_SHA,
    );
  });

  test("arguments are tag, stale, expired, with an empty expired to keep the stored one", () => {
    const updates = new Map([
      ["a", { stale: 1, expired: 2 }],
      ["b", { stale: 3 }],
    ]);
    expect(updateArgs(updates)).toEqual(["a", "1", "2", "b", "3", ""]);
  });
});

describe("mergeUpdate", () => {
  test("a first update is stored as is", () => {
    expect(mergeUpdate(undefined, { stale: 5, expired: 5 })).toEqual({ stale: 5, expired: 5 });
    expect(mergeUpdate(undefined, { stale: 5 })).toEqual({ stale: 5 });
  });

  test("a newer update replaces the record; without expire it keeps the stored expiry", () => {
    expect(mergeUpdate({ stale: 5, expired: 5 }, { stale: 9, expired: 9 })).toEqual({
      stale: 9,
      expired: 9,
    });
    expect(mergeUpdate({ stale: 5, expired: 5 }, { stale: 9 })).toEqual({ stale: 9, expired: 5 });
  });

  test("an older update leaves the record, and fills only a missing expiry", () => {
    expect(mergeUpdate({ stale: 9, expired: 9 }, { stale: 5, expired: 5 })).toEqual({
      stale: 9,
      expired: 9,
    });
    expect(mergeUpdate({ stale: 9, expired: 9 }, { stale: 5, expired: 60_005 })).toEqual({
      stale: 9,
      expired: 9,
    });
    expect(mergeUpdate({ stale: 9 }, { stale: 5, expired: 7 })).toEqual({ stale: 9, expired: 7 });
  });

  test('"max" then an immediate revalidation expires at once, whichever arrives first', () => {
    const max = { stale: 5, expired: 5 + 31_536_000_000 };
    const immediate = { stale: 6, expired: 6 };
    expect(mergeUpdate(mergeUpdate(undefined, max), immediate)).toEqual(immediate);
    expect(mergeUpdate(mergeUpdate(undefined, immediate), max)).toEqual(immediate);
  });

  test("in the same millisecond the earlier expiry wins", () => {
    expect(mergeUpdate({ stale: 5, expired: 65 }, { stale: 5, expired: 5 })).toEqual({
      stale: 5,
      expired: 5,
    });
    expect(mergeUpdate({ stale: 5, expired: 5 }, { stale: 5, expired: 65 })).toEqual({
      stale: 5,
      expired: 5,
    });
    expect(mergeUpdate({ stale: 5, expired: 5 }, { stale: 5 })).toEqual({ stale: 5, expired: 5 });
    expect(mergeUpdate({ stale: 5 }, { stale: 5, expired: 65 })).toEqual({ stale: 5, expired: 65 });
  });
});
