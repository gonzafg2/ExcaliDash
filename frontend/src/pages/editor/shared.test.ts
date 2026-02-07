import { describe, expect, it } from "vitest";
import {
  hasRenderableElements,
  isSuspiciousEmptySnapshot,
} from "./shared";

describe("editor/shared scene guards", () => {
  it("detects renderable elements", () => {
    expect(hasRenderableElements([{ id: "a", isDeleted: false }])).toBe(true);
    expect(
      hasRenderableElements([
        { id: "a", isDeleted: true },
        { id: "b", isDeleted: true },
      ])
    ).toBe(false);
  });

  it("flags empty snapshot after a previously non-empty persisted scene", () => {
    const previous = [{ id: "a", isDeleted: false }];
    expect(isSuspiciousEmptySnapshot(previous, [])).toBe(true);
  });

  it("does not flag empty snapshot for already-empty drawings", () => {
    expect(isSuspiciousEmptySnapshot([], [])).toBe(false);
  });

  it("does not flag non-empty snapshots", () => {
    const previous = [{ id: "a", isDeleted: false }];
    const next = [{ id: "a", isDeleted: true }];
    expect(isSuspiciousEmptySnapshot(previous, next)).toBe(false);
  });
});
