import { describe, it, expect, vi } from "vitest";
import {
  buildAuthConfig,
  createAuthSessionToken,
  generateRandomPassword,
  getAuthSessionFromCookie,
  hashPassword,
  isPasswordValid,
  validateAuthSessionToken,
  verifyPassword,
} from "../auth";

describe("Auth utilities", () => {
  it("builds auth config defaults", () => {
    const config = buildAuthConfig({});
    expect(config.enabled).toBe(true);
    expect(config.minPasswordLength).toBe(7);
  });

  it("hashes and verifies passwords", () => {
    const hashed = hashPassword("super-secret");
    expect(verifyPassword("super-secret", hashed)).toBe(true);
    expect(verifyPassword("wrong", hashed)).toBe(false);
  });

  it("validates issued session tokens", () => {
    const config = buildAuthConfig({
      AUTH_SESSION_SECRET: "test-secret",
    });

    const token = createAuthSessionToken(config, "user-123");
    const session = validateAuthSessionToken(config, token);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe("user-123");
  });

  it("rejects expired session tokens", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));

    const config = buildAuthConfig({
      AUTH_SESSION_SECRET: "test-secret",
      AUTH_SESSION_TTL_HOURS: "0.001", // ~3.6 seconds
    });

    const token = createAuthSessionToken(config, "user-123");
    vi.setSystemTime(new Date("2025-01-01T00:00:10.000Z"));

    expect(validateAuthSessionToken(config, token)).toBeNull();
    vi.useRealTimers();
  });

  it("extracts session tokens from cookies", () => {
    const config = buildAuthConfig({
      AUTH_SESSION_SECRET: "test-secret",
    });

    const token = createAuthSessionToken(config, "user-123");
    const cookieHeader = `${config.cookieName}=${encodeURIComponent(token)}; theme=dark`;
    const session = getAuthSessionFromCookie(cookieHeader, config);
    expect(session?.userId).toBe("user-123");
  });

  it("validates password length", () => {
    const config = buildAuthConfig({ AUTH_MIN_PASSWORD_LENGTH: "9" });
    expect(isPasswordValid(config, "12345678")).toBe(false);
    expect(isPasswordValid(config, "123456789")).toBe(true);
  });

  it("generates random passwords", () => {
    const password = generateRandomPassword(32);
    expect(password).toHaveLength(32);
  });
});
