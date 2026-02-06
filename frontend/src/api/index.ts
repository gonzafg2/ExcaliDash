import axios from "axios";
import type { Drawing, Collection, DrawingSummary } from "../types";

export const API_URL = import.meta.env.VITE_API_URL || "/api";

export const api = axios.create({
  baseURL: API_URL,
});

// Re-export axios for type checking
export { default as axios } from 'axios';
export const isAxiosError = axios.isAxiosError;

// Export api instance for direct use
export { api as default };

// JWT Token Management
const TOKEN_KEY = 'excalidash-access-token';
const REFRESH_TOKEN_KEY = 'excalidash-refresh-token';

const getAuthToken = (): string | null => {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
};

// CSRF Token Management
let csrfToken: string | null = null;
let csrfHeaderName: string = "x-csrf-token";
let csrfTokenPromise: Promise<void> | null = null;

/**
 * Fetch a fresh CSRF token from the server
 */
export const fetchCsrfToken = async (): Promise<void> => {
  try {
    const response = await axios.get<{ token: string; header: string }>(
      `${API_URL}/csrf-token`
    );
    csrfToken = response.data.token;
    csrfHeaderName = response.data.header || "x-csrf-token";
  } catch (error) {
    console.error("Failed to fetch CSRF token:", error);
    throw error;
  }
};

/**
 * Ensure we have a valid CSRF token, fetching one if needed
 */
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

/**
 * Clear the cached CSRF token (useful for handling 403 errors)
 */
export const clearCsrfToken = (): void => {
  csrfToken = null;
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
      const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
      if (refreshToken && !error.config.url?.includes('/auth/')) {
        try {
          const refreshResponse = await axios.post(`${API_URL}/auth/refresh`, {
            refreshToken,
          });
          localStorage.setItem(TOKEN_KEY, refreshResponse.data.accessToken);
          
          // Update refresh token if rotation returned a new one
          if (refreshResponse.data.refreshToken) {
            localStorage.setItem(REFRESH_TOKEN_KEY, refreshResponse.data.refreshToken);
          }
          
          // Retry original request with new token
          error.config.headers.Authorization = `Bearer ${refreshResponse.data.accessToken}`;
          return api(error.config);
        } catch {
          // Refresh failed, clear tokens and redirect to login
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(REFRESH_TOKEN_KEY);
          localStorage.removeItem('excalidash-user');
          window.location.href = '/login';
          return Promise.reject(error);
        }
      } else {
        // No refresh token or auth endpoint, redirect to login
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(REFRESH_TOKEN_KEY);
        localStorage.removeItem('excalidash-user');
        if (!error.config.url?.includes('/auth/')) {
          window.location.href = '/login';
        }
      }
    }

    // If we get a 403 with CSRF error, clear token and retry once
    if (
      error.response?.status === 403 &&
      error.response?.data?.error?.includes("CSRF")
    ) {
      clearCsrfToken();

      // Retry the request once with a fresh token
      const originalRequest = error.config;
      if (!originalRequest._csrfRetry) {
        originalRequest._csrfRetry = true;
        await fetchCsrfToken();
        if (csrfToken) {
          originalRequest.headers[csrfHeaderName] = csrfToken;
        }
        return api(originalRequest);
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
  return deserializeTimestamps(drawing as HasTimestamps & DrawingSummary);
};

const deserializeDrawing = (drawing: unknown): Drawing => {
  if (typeof drawing !== 'object' || drawing === null) {
    throw new Error('Invalid drawing data');
  }
  return deserializeTimestamps(drawing as HasTimestamps & Drawing);
};

export function getDrawings(
  search?: string,
  collectionId?: string | null
): Promise<DrawingSummary[]>;

export function getDrawings(
  search: string | undefined,
  collectionId: string | null | undefined,
  options: { includeData: true }
): Promise<Drawing[]>;

export async function getDrawings(
  search?: string,
  collectionId?: string | null,
  options?: { includeData?: boolean }
) {
  const params: Record<string, string> = {};
  if (search) params.search = search;
  if (collectionId !== undefined)
    params.collectionId = collectionId === null ? "null" : collectionId;
  if (options?.includeData) {
    params.includeData = "true";
    const response = await api.get<Drawing[]>("/drawings", { params });
    return response.data.map(deserializeDrawing);
  }
  const response = await api.get<DrawingSummary[]>("/drawings", { params });
  return response.data.map(deserializeDrawingSummary);
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
  const response = await api.put<{ success: true }>(`/drawings/${id}`, data);
  return response.data;
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
