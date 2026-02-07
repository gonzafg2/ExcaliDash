import { describe, expect, it } from "vitest";
import {
  hasRenderableElements,
  isSuspiciousEmptySnapshot,
  isStaleEmptySnapshot,
  isStaleNonRenderableSnapshot,
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

  it("flags stale empty snapshot when latest scene is non-empty", () => {
    const latest = [{ id: "a", version: 2, versionNonce: 2, isDeleted: false }];
    expect(isStaleEmptySnapshot(latest, [])).toBe(true);
  });

  it("does not flag empty snapshot when latest scene is already empty", () => {
    expect(isStaleEmptySnapshot([], [])).toBe(false);
  });

  it("does not flag identical empty snapshots", () => {
    const latest = [];
    const candidate = [];
    expect(isStaleEmptySnapshot(latest, candidate)).toBe(false);
  });

  it("flags stale non-renderable snapshot when latest scene has renderable elements", () => {
    const latest = [{ id: "a", version: 2, versionNonce: 2, isDeleted: false }];
    const candidate = [{ id: "a", version: 1, versionNonce: 1, isDeleted: true }];
    expect(isStaleNonRenderableSnapshot(latest, candidate)).toBe(true);
  });

  it("does not flag non-renderable snapshot when latest scene is already non-renderable", () => {
    const latest = [{ id: "a", version: 2, versionNonce: 2, isDeleted: true }];
    const candidate = [{ id: "a", version: 1, versionNonce: 1, isDeleted: true }];
    expect(isStaleNonRenderableSnapshot(latest, candidate)).toBe(false);
  });
});
