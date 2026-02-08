import axios from "axios";
import type { Drawing, Collection, DrawingSummary } from "../types";
import { normalizePreviewSvg } from "../utils/previewSvg";

export const API_URL = import.meta.env.VITE_API_URL || "/api";

export const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,
});

// Re-export axios for type checking
export { default as axios } from 'axios';
export const isAxiosError = axios.isAxiosError;

// Export api instance for direct use
export { api as default };

// JWT Token Management
const TOKEN_KEY = 'excalidash-access-token';
const REFRESH_TOKEN_KEY = 'excalidash-refresh-token';
const USER_KEY = 'excalidash-user';
const AUTH_ENABLED_CACHE_KEY = "excalidash-auth-enabled";
const AUTH_STATUS_TTL_MS = 5000;

type RetriableRequestConfig = {
  _retry?: boolean;
  _csrfRetry?: boolean;
  _authModeRetry?: boolean;
  url?: string;
  headers?: Record<string, string>;
};

let authEnabledProbeCache: { value: boolean; fetchedAt: number } | null = null;

const getAuthToken = (): string | null => {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
};

// CSRF Token Management
let csrfToken: string | null = null;
let csrfHeaderName: string = "x-csrf-token";
let csrfTokenPromise: Promise<void> | null = null;

export const fetchCsrfToken = async (): Promise<void> => {
  try {
    const response = await axios.get<{ token: string; header: string }>(
      `${API_URL}/csrf-token`,
      { withCredentials: true }
    );
    csrfToken = response.data.token;
    csrfHeaderName = response.data.header || "x-csrf-token";
  } catch (error) {
    console.error("Failed to fetch CSRF token:", error);
    throw error;
  }
};

const ensureCsrfToken = async (): Promise<void> => {
  if (csrfToken) return;

  // Prevent multiple simultaneous token fetches
  if (!csrfTokenPromise) {
    csrfTokenPromise = fetchCsrfToken().finally(() => {
      csrfTokenPromise = null;
    });
  }
  await csrfTokenPromise;
};

export const clearCsrfToken = (): void => {
  csrfToken = null;
};

const clearStoredAuth = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
};

const readCachedAuthEnabled = (): boolean | null => {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(AUTH_ENABLED_CACHE_KEY);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
};

const cacheAuthEnabled = (enabled: boolean) => {
  if (typeof window === "undefined") return;
  authEnabledProbeCache = { value: enabled, fetchedAt: Date.now() };
  localStorage.setItem(AUTH_ENABLED_CACHE_KEY, String(enabled));
};

const getAuthEnabledStatus = async (): Promise<boolean | null> => {
  const now = Date.now();
  if (authEnabledProbeCache && now - authEnabledProbeCache.fetchedAt < AUTH_STATUS_TTL_MS) {
    return authEnabledProbeCache.value;
  }

  try {
    const response = await axios.get<{ authEnabled?: boolean; enabled?: boolean }>(
      `${API_URL}/auth/status`,
      { withCredentials: true }
    );
    const enabled =
      typeof response.data?.authEnabled === "boolean"
        ? response.data.authEnabled
        : typeof response.data?.enabled === "boolean"
          ? response.data.enabled
          : true;
    cacheAuthEnabled(enabled);
    return enabled;
  } catch {
    return readCachedAuthEnabled();
  }
};

const redirectToLogin = async () => {
  const authEnabled = await getAuthEnabledStatus();
  if (authEnabled === false) return;
  if (window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
};

let refreshPromise: Promise<string> | null = null;

const refreshAccessToken = async (): Promise<string> => {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
      if (!refreshToken) {
        throw new Error("Missing refresh token");
      }

      const refreshResponse = await axios.post(
        `${API_URL}/auth/refresh`,
        {
          refreshToken,
        },
        { withCredentials: true }
      );

      const nextAccessToken = String(refreshResponse.data.accessToken || "");
      if (!nextAccessToken) {
        throw new Error("Missing access token in refresh response");
      }

      localStorage.setItem(TOKEN_KEY, nextAccessToken);
      if (refreshResponse.data.refreshToken) {
        localStorage.setItem(REFRESH_TOKEN_KEY, refreshResponse.data.refreshToken);
      }

      return nextAccessToken;
    })().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
};

// Add request interceptor to include JWT and CSRF tokens
api.interceptors.request.use(
  async (config) => {
    // Auth endpoints that don't require authentication (login, register, etc.)
    const publicAuthEndpoints = [
      '/auth/login',
      '/auth/register',
      '/auth/refresh',
      '/auth/password-reset-request',
      '/auth/password-reset-confirm',
    ];

    const isPublicAuthEndpoint = config.url && publicAuthEndpoints.some(endpoint => config.url?.startsWith(endpoint));

    // Add JWT token to all requests except public auth endpoints
    if (!isPublicAuthEndpoint) {
      const token = getAuthToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }

    // Only add CSRF token for state-changing methods (except public auth endpoints)
    const method = config.method?.toUpperCase();
    if (method && ["POST", "PUT", "DELETE", "PATCH"].includes(method) && !isPublicAuthEndpoint) {
      await ensureCsrfToken();
      if (csrfToken) {
        config.headers[csrfHeaderName] = csrfToken;
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Add response interceptor to handle auth and CSRF token errors
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    // Handle must-reset-password enforcement (403)
    if (
      error.response?.status === 403 &&
      error.response?.data?.code === "MUST_RESET_PASSWORD"
    ) {
      const url = String(error.config?.url || "");
      const isAuthRoute =
        url.startsWith("/auth/me") ||
        url.startsWith("/auth/must-reset-password") ||
        url.startsWith("/auth/login") ||
        url.startsWith("/auth/register");

      if (!isAuthRoute && window.location.pathname !== "/login") {
        window.location.href = "/login?mustReset=1";
      }
      return Promise.reject(error);
    }

    // Handle 401 Unauthorized (invalid/expired JWT)
    if (error.response?.status === 401) {
      const originalRequest = (error.config || {}) as RetriableRequestConfig;
      const url = String(originalRequest.url || "");
      const isAuthRoute = url.includes('/auth/');
      const hasRefreshToken = Boolean(localStorage.getItem(REFRESH_TOKEN_KEY));
      const authEnabled = !isAuthRoute ? await getAuthEnabledStatus() : true;

      if (!isAuthRoute && authEnabled === false) {
        if (!originalRequest._authModeRetry) {
          originalRequest._authModeRetry = true;
          return api(originalRequest as any);
        }
        return Promise.reject(error);
      }

      if (!isAuthRoute && hasRefreshToken && !originalRequest._retry) {
        try {
          originalRequest._retry = true;
          const nextAccessToken = await refreshAccessToken();
          originalRequest.headers = originalRequest.headers || {};
          originalRequest.headers.Authorization = `Bearer ${nextAccessToken}`;
          return api(originalRequest as any);
        } catch {
          clearStoredAuth();
          await redirectToLogin();
          return Promise.reject(error);
        }
      }

      if (!isAuthRoute) {
        clearStoredAuth();
        await redirectToLogin();
      }
    }

    // If we get a 403 with CSRF error, clear token and retry once
    if (
      error.response?.status === 403 &&
      error.response?.data?.error?.includes("CSRF")
    ) {
      clearCsrfToken();

      // Retry the request once with a fresh token
      const originalRequest = (error.config || {}) as RetriableRequestConfig;
      if (!originalRequest._csrfRetry) {
        originalRequest._csrfRetry = true;
        await fetchCsrfToken();
        if (csrfToken) {
          originalRequest.headers = originalRequest.headers || {};
          originalRequest.headers[csrfHeaderName] = csrfToken;
        }
        return api(originalRequest as any);
      }
    }
    return Promise.reject(error);
  }
);

const coerceTimestamp = (value: string | number | Date): number => {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
};

type TimestampValue = string | number | Date;

interface HasTimestamps {
  createdAt: TimestampValue;
  updatedAt: TimestampValue;
}

const deserializeTimestamps = <T extends HasTimestamps>(
  data: T
): T & { createdAt: number; updatedAt: number } => ({
  ...data,
  createdAt: coerceTimestamp(data.createdAt),
  updatedAt: coerceTimestamp(data.updatedAt),
});

const deserializeDrawingSummary = (drawing: unknown): DrawingSummary => {
  if (typeof drawing !== 'object' || drawing === null) {
    throw new Error('Invalid drawing data');
  }
  const parsed = drawing as HasTimestamps & DrawingSummary;
  return deserializeTimestamps({
    ...parsed,
    preview:
      typeof parsed.preview === "string"
        ? normalizePreviewSvg(parsed.preview)
        : parsed.preview,
  });
};

const deserializeDrawing = (drawing: unknown): Drawing => {
  if (typeof drawing !== 'object' || drawing === null) {
    throw new Error('Invalid drawing data');
  }
  const parsed = drawing as HasTimestamps & Drawing;
  return deserializeTimestamps({
    ...parsed,
    preview:
      typeof parsed.preview === "string"
        ? normalizePreviewSvg(parsed.preview)
        : parsed.preview,
  });
};

export interface PaginatedDrawings<T> {
  drawings: T[];
  totalCount: number;
  limit?: number;
  offset?: number;
}

export type DrawingSortField = "name" | "createdAt" | "updatedAt";
export type SortDirection = "asc" | "desc";

export function getDrawings(
  search?: string,
  collectionId?: string | null,
  options?: {
    limit?: number;
    offset?: number;
    sortField?: DrawingSortField;
    sortDirection?: SortDirection;
  }
): Promise<PaginatedDrawings<DrawingSummary>>;

export function getDrawings(
  search: string | undefined,
  collectionId: string | null | undefined,
  options: {
    includeData: true;
    limit?: number;
    offset?: number;
    sortField?: DrawingSortField;
    sortDirection?: SortDirection;
  }
): Promise<PaginatedDrawings<Drawing>>;

export async function getDrawings(
  search?: string,
  collectionId?: string | null,
  options?: {
    includeData?: boolean;
    limit?: number;
    offset?: number;
    sortField?: DrawingSortField;
    sortDirection?: SortDirection;
  }
) {
  const params: Record<string, string | number> = {};
  if (search) params.search = search;
  if (collectionId !== undefined)
    params.collectionId = collectionId === null ? "null" : collectionId;
  if (options?.limit !== undefined) params.limit = options.limit;
  if (options?.offset !== undefined) params.offset = options.offset;
  if (options?.sortField) params.sortField = options.sortField;
  if (options?.sortDirection) params.sortDirection = options.sortDirection;

  if (options?.includeData) {
    params.includeData = "true";
    const response = await api.get<PaginatedDrawings<Drawing>>("/drawings", { params });
    return {
      ...response.data,
      drawings: response.data.drawings.map(deserializeDrawing)
    };
  }
  const response = await api.get<PaginatedDrawings<DrawingSummary>>("/drawings", { params });
  return {
    ...response.data,
    drawings: response.data.drawings.map(deserializeDrawingSummary)
  };
}

export const getDrawing = async (id: string) => {
  const response = await api.get<Drawing>(`/drawings/${id}`);
  return deserializeDrawing(response.data);
};

export const createDrawing = async (
  name?: string,
  collectionId?: string | null
) => {
  const response = await api.post<{ id: string }>("/drawings", {
    name: name || "Untitled Drawing",
    collectionId: collectionId ?? null,
    elements: [],
    appState: {},
  });
  return response.data;
};

export const updateDrawing = async (id: string, data: Partial<Drawing>) => {
  const response = await api.put<Drawing>(`/drawings/${id}`, data);
  return deserializeDrawing(response.data);
};

export const deleteDrawing = async (id: string) => {
  const response = await api.delete<{ success: true }>(`/drawings/${id}`);
  return response.data;
};

export const duplicateDrawing = async (id: string) => {
  const response = await api.post<Drawing>(`/drawings/${id}/duplicate`);
  return deserializeDrawing(response.data);
};

export const getCollections = async () => {
  const response = await api.get<Collection[]>("/collections");
  return response.data;
};

export const createCollection = async (name: string) => {
  const response = await api.post<Collection>("/collections", { name });
  return response.data;
};

export const updateCollection = async (id: string, name: string) => {
  const response = await api.put<{ success: true }>(`/collections/${id}`, {
    name,
  });
  return response.data;
};

export const deleteCollection = async (id: string) => {
  const response = await api.delete<{ success: true }>(`/collections/${id}`);
  return response.data;
};

// --- Library ---

// Library items are Excalidraw library items - dynamic structure from Excalidraw
type LibraryItem = Record<string, unknown>;

export const getLibrary = async (): Promise<LibraryItem[]> => {
  const response = await api.get<{ items: LibraryItem[] }>("/library");
  return response.data.items;
};

export const updateLibrary = async (items: LibraryItem[]): Promise<LibraryItem[]> => {
  const response = await api.put<{ items: LibraryItem[] }>("/library", { items });
  return response.data.items;
};
