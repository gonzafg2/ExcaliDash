import { describe, expect, it } from "vitest";
import { isLatestRequest, mergeUniqueDrawings } from "./pagination";
import type { DrawingSummary } from "../../types";

const drawing = (id: string, name = id): DrawingSummary => ({
  id,
  name,
  collectionId: null,
  preview: null,
  version: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

describe("dashboard pagination helpers", () => {
  it("accepts only latest request version", () => {
    expect(isLatestRequest(3, 3)).toBe(true);
    expect(isLatestRequest(2, 3)).toBe(false);
    expect(isLatestRequest(4, 3)).toBe(false);
  });

  it("merges pages without duplicating IDs", () => {
    const existing = [drawing("a"), drawing("b")];
    const incoming = [drawing("b", "b-new"), drawing("c")];

    const merged = mergeUniqueDrawings(existing, incoming);

    expect(merged.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(merged[1].name).toBe("b");
  });
});
