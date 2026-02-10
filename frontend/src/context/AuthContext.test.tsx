import { render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";

const Probe = () => {
  const { loading, authEnabled } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="auth-enabled">{String(authEnabled)}</span>
    </div>
  );
};

describe("AuthProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to auth-enabled mode if /auth/status fails", async () => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });

    vi.spyOn(axios, "get").mockRejectedValue(new Error("network down"));

    render(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });
    expect(screen.getByTestId("auth-enabled").textContent).toBe("true");
  });

  it("clears stored auth state when backend reports auth disabled", async () => {
    const storage = new Map<string, string>([
      ["excalidash-user", JSON.stringify({ id: "u1" })],
    ]);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });

    vi.spyOn(axios, "get").mockResolvedValueOnce({ data: { authEnabled: false } });

    render(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });
    expect(screen.getByTestId("auth-enabled").textContent).toBe("false");
    expect(storage.get("excalidash-user")).toBeUndefined();
  });

  it("uses cached auth-disabled mode when /auth/status is temporarily unavailable", async () => {
    const storage = new Map<string, string>([
      ["excalidash-auth-enabled", "false"],
      ["excalidash-user", JSON.stringify({ id: "u1" })],
    ]);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });

    vi.spyOn(axios, "get").mockRejectedValue(new Error("network down"));

    render(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });
    expect(screen.getByTestId("auth-enabled").textContent).toBe("false");
    expect(storage.get("excalidash-user")).toBeUndefined();
  });
});
