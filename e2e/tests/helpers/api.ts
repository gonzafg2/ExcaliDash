import { APIRequestContext } from "@playwright/test";

import { expect } from "@playwright/test";

// Default ports match the Playwright config
const DEFAULT_BACKEND_PORT = 8000;

export const API_URL = process.env.API_URL || `http://localhost:${DEFAULT_BACKEND_PORT}`;

const AUTH_USERNAME = process.env.AUTH_USERNAME || "admin";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "admin123";

// Track authenticated API contexts
const authenticatedContexts = new WeakSet<APIRequestContext>();

/**
 * Ensure the API request context is authenticated
 */
export async function ensureAuthenticated(request: APIRequestContext): Promise<void> {
  if (authenticatedContexts.has(request)) return;

  // Check current auth status
  const statusResp = await request.get(`${API_URL}/auth/status`);
  if (!statusResp.ok()) {
    if (statusResp.status() === 401) {
      authenticatedContexts.delete(request);
    }
    throw new Error(`Failed to check auth status: ${statusResp.status()}`);
  }

  const status = (await statusResp.json()) as {
    enabled: boolean;
    authenticated: boolean;
    bootstrapRequired?: boolean;
  };

  if (!status.enabled) {
    // Auth is disabled, mark as "authenticated"
    authenticatedContexts.add(request);
    return;
  }

  if (status.authenticated) {
    authenticatedContexts.add(request);
    return;
  }

  if (status.bootstrapRequired) {
    const bootstrapHeaders = await withCsrfHeaders(request, {
      "Content-Type": "application/json",
    });
    const bootstrapResp = await request.post(`${API_URL}/auth/bootstrap`, {
      headers: bootstrapHeaders,
      data: {
        username: AUTH_USERNAME,
        password: AUTH_PASSWORD,
      },
    });

    if (!bootstrapResp.ok()) {
      const text = await bootstrapResp.text();
      throw new Error(`API bootstrap failed: ${bootstrapResp.status()} ${text}`);
    }

    authenticatedContexts.add(request);
    return;
  }

  // Need to login
  let loginHeaders = await withCsrfHeaders(request, {
    "Content-Type": "application/json",
  });
  let loginResp = await request.post(`${API_URL}/auth/login`, {
    headers: loginHeaders,
    data: {
      username: AUTH_USERNAME,
      password: AUTH_PASSWORD,
    },
  });

  if (!loginResp.ok() && loginResp.status() === 403) {
    await refreshCsrfInfo(request);
    loginHeaders = await withCsrfHeaders(request, {
      "Content-Type": "application/json",
    });
    loginResp = await request.post(`${API_URL}/auth/login`, {
      headers: loginHeaders,
      data: {
        username: AUTH_USERNAME,
        password: AUTH_PASSWORD,
      },
    });
  }

  if (!loginResp.ok()) {
    const text = await loginResp.text();
    throw new Error(`API authentication failed: ${loginResp.status()} ${text}`);
  }

  authenticatedContexts.add(request);
}

type CsrfTokenResponse = {
  token: string;
  header?: string;
};

type CsrfInfo = {
  token: string;
  headerName: string;
};

const buildBaseHeaders = (_request: APIRequestContext): Record<string, string> => ({
  origin: process.env.BASE_URL || "http://localhost:5173",
});

// Cache CSRF tokens per Playwright request context so parallel tests don't race.
const csrfInfoByRequest = new WeakMap<APIRequestContext, CsrfInfo>();
const csrfFetchByRequest = new WeakMap<APIRequestContext, Promise<CsrfInfo>>();

const fetchCsrfInfo = async (request: APIRequestContext): Promise<CsrfInfo> => {
  const response = await request.get(`${API_URL}/csrf-token`, {
    headers: buildBaseHeaders(request),
  });
  if (!response.ok()) {
    const text = await response.text();
    throw new Error(
      `Failed to fetch CSRF token: ${response.status()} ${text || "(empty response)"}`
    );
  }

  const data = (await response.json()) as CsrfTokenResponse;
  if (!data || typeof data.token !== "string" || data.token.trim().length === 0) {
    throw new Error("Failed to fetch CSRF token: missing token in response");
  }

  const headerName =
    typeof data.header === "string" && data.header.trim().length > 0
      ? data.header
      : "x-csrf-token";

  return { token: data.token, headerName };
};

const getCsrfInfo = async (request: APIRequestContext): Promise<CsrfInfo> => {
  const cached = csrfInfoByRequest.get(request);
  if (cached) return cached;

  const inFlight = csrfFetchByRequest.get(request);
  if (inFlight) return inFlight;

  const promise = fetchCsrfInfo(request)
    .then((info) => {
      csrfInfoByRequest.set(request, info);
      return info;
    })
    .finally(() => {
      csrfFetchByRequest.delete(request);
    });

  csrfFetchByRequest.set(request, promise);
  return promise;
};

const refreshCsrfInfo = async (request: APIRequestContext): Promise<CsrfInfo> => {
  const promise = fetchCsrfInfo(request)
    .then((info) => {
      csrfInfoByRequest.set(request, info);
      return info;
    })
    .finally(() => {
      csrfFetchByRequest.delete(request);
    });

  csrfFetchByRequest.set(request, promise);
  return promise;
};

export const refreshCsrfToken = async (request: APIRequestContext): Promise<void> => {
  authenticatedContexts.delete(request);
  await refreshCsrfInfo(request);
};

export async function getCsrfHeaders(
  request: APIRequestContext
): Promise<Record<string, string>> {
  const info = await getCsrfInfo(request);
  return { [info.headerName]: info.token };
}

const withCsrfHeaders = async (
  request: APIRequestContext,
  headers: Record<string, string> = {}
): Promise<Record<string, string>> => ({
  ...buildBaseHeaders(request),
  ...headers,
  ...(await getCsrfHeaders(request)),
});

export interface DrawingRecord {
  id: string;
  name: string;
  collectionId: string | null;
  preview?: string | null;
  version?: number;
  createdAt?: number | string;
  updatedAt?: number | string;
  elements?: any[];
  appState?: Record<string, any> | null;
  files?: Record<string, any>;
}

export interface CollectionRecord {
  id: string;
  name: string;
  createdAt?: number | string;
}

export interface CreateDrawingOptions {
  name?: string;
  elements?: any[];
  appState?: Record<string, any>;
  files?: Record<string, any>;
  preview?: string | null;
  collectionId?: string | null;
}

export interface ListDrawingsOptions {
  search?: string;
  collectionId?: string | null;
  includeData?: boolean;
}

const defaultDrawingPayload = () => ({
  name: `E2E Drawing ${Date.now()}`,
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
  preview: null,
  collectionId: null as string | null,
});

export async function createDrawing(
  request: APIRequestContext,
  overrides: CreateDrawingOptions = {}
): Promise<DrawingRecord> {
  await ensureAuthenticated(request);

  const payload = { ...defaultDrawingPayload(), ...overrides };
  const headers = await withCsrfHeaders(request, { "Content-Type": "application/json" });

  let response = await request.post(`${API_URL}/drawings`, {
    headers,
    data: payload,
  });

  if (!response.ok() && response.status() === 401) {
    authenticatedContexts.delete(request);
    await ensureAuthenticated(request);
    const retryHeaders = await withCsrfHeaders(request, {
      "Content-Type": "application/json",
    });
    response = await request.post(`${API_URL}/drawings`, {
      headers: retryHeaders,
      data: payload,
    });
  }

  if (!response.ok() && response.status() === 503) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await request.post(`${API_URL}/drawings`, {
      headers,
      data: payload,
    });
  }

  // Retry once with a fresh token in case it expired or the cache was primed under
  // a different clientId (rare, but can happen under parallelism / CI proxies).
  if (!response.ok() && response.status() === 403) {
    await refreshCsrfInfo(request);
    const retryHeaders = await withCsrfHeaders(request, {
      "Content-Type": "application/json",
    });
    response = await request.post(`${API_URL}/drawings`, {
      headers: retryHeaders,
      data: payload,
    });
  }

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Failed to create drawing: ${response.status()} ${text}`);
  }

  const created = (await response.json()) as DrawingRecord;
  try {
    await request.get(`${API_URL}/drawings/${created.id}`);
  } catch {
    // Ignore warm-up failures to keep tests resilient.
  }
  return created;
}

export async function getDrawing(
  request: APIRequestContext,
  id: string
): Promise<DrawingRecord> {
  await ensureAuthenticated(request);

  let response = await request.get(`${API_URL}/drawings/${id}`);

  if (!response.ok() && response.status() === 401) {
    authenticatedContexts.delete(request);
    await ensureAuthenticated(request);
    response = await request.get(`${API_URL}/drawings/${id}`);
  }

  if (!response.ok() && response.status() === 503) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await request.get(`${API_URL}/drawings/${id}`);
  }

  expect(response.ok()).toBe(true);
  return (await response.json()) as DrawingRecord;
}

export async function deleteDrawing(
  request: APIRequestContext,
  id: string
): Promise<void> {
  await ensureAuthenticated(request);
  let headers = await withCsrfHeaders(request);
  let response = await request.delete(`${API_URL}/drawings/${id}`, { headers });

  if (!response.ok() && response.status() === 401) {
    authenticatedContexts.delete(request);
    await ensureAuthenticated(request);
    headers = await withCsrfHeaders(request);
    response = await request.delete(`${API_URL}/drawings/${id}`, { headers });
  }

  if (!response.ok() && response.status() === 503) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await request.delete(`${API_URL}/drawings/${id}`, { headers });
  }

  if (!response.ok() && response.status() === 403) {
    await refreshCsrfInfo(request);
    headers = await withCsrfHeaders(request);
    response = await request.delete(`${API_URL}/drawings/${id}`, { headers });
  }

  if (!response.ok()) {
    // Ignore not found to keep cleanup idempotent
    if (response.status() !== 404) {
      const text = await response.text();
      throw new Error(`Failed to delete drawing ${id}: ${response.status()} ${text}`);
    }
  }

  try {
    await request.get(`${API_URL}/drawings/${id}`);
  } catch {
    // Ignore cache warm-up failures.
  }
}

export async function listDrawings(
  request: APIRequestContext,
  options: ListDrawingsOptions = {}
): Promise<DrawingRecord[]> {
  await ensureAuthenticated(request);
  const params = new URLSearchParams();
  if (options.search) params.set("search", options.search);
  if (options.collectionId !== undefined) {
    params.set(
      "collectionId",
      options.collectionId === null ? "null" : String(options.collectionId)
    );
  }
  if (options.includeData) params.set("includeData", "true");

  const query = params.toString();
  let response = await request.get(
    `${API_URL}/drawings${query ? `?${query}` : ""}`
  );

  if (!response.ok() && response.status() === 401) {
    authenticatedContexts.delete(request);
    await ensureAuthenticated(request);
    response = await request.get(
      `${API_URL}/drawings${query ? `?${query}` : ""}`
    );
  }

  if (!response.ok() && response.status() === 503) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await request.get(
      `${API_URL}/drawings${query ? `?${query}` : ""}`
    );
  }

  expect(response.ok()).toBe(true);
  return (await response.json()) as DrawingRecord[];
}

export async function createCollection(
  request: APIRequestContext,
  name: string
): Promise<CollectionRecord> {
  await ensureAuthenticated(request);
  const headers = await withCsrfHeaders(request, { "Content-Type": "application/json" });

  let response = await request.post(`${API_URL}/collections`, {
    headers,
    data: { name },
  });

  if (!response.ok() && response.status() === 401) {
    authenticatedContexts.delete(request);
    await ensureAuthenticated(request);
    const retryHeaders = await withCsrfHeaders(request, {
      "Content-Type": "application/json",
    });
    response = await request.post(`${API_URL}/collections`, {
      headers: retryHeaders,
      data: { name },
    });
  }

  if (!response.ok() && response.status() === 503) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await request.post(`${API_URL}/collections`, {
      headers,
      data: { name },
    });
  }

  if (!response.ok() && response.status() === 403) {
    await refreshCsrfInfo(request);
    const retryHeaders = await withCsrfHeaders(request, {
      "Content-Type": "application/json",
    });
    response = await request.post(`${API_URL}/collections`, {
      headers: retryHeaders,
      data: { name },
    });
  }

  expect(response.ok()).toBe(true);
  return (await response.json()) as CollectionRecord;
}

export async function listCollections(
  request: APIRequestContext
): Promise<CollectionRecord[]> {
  await ensureAuthenticated(request);
  let response = await request.get(`${API_URL}/collections`);

  if (!response.ok() && response.status() === 401) {
    authenticatedContexts.delete(request);
    await ensureAuthenticated(request);
    response = await request.get(`${API_URL}/collections`);
  }

  if (!response.ok() && response.status() === 503) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await request.get(`${API_URL}/collections`);
  }

  expect(response.ok()).toBe(true);
  return (await response.json()) as CollectionRecord[];
}

export async function deleteCollection(
  request: APIRequestContext,
  id: string
): Promise<void> {
  await ensureAuthenticated(request);
  let headers = await withCsrfHeaders(request);
  let response = await request.delete(`${API_URL}/collections/${id}`, { headers });

  if (!response.ok() && response.status() === 401) {
    authenticatedContexts.delete(request);
    await ensureAuthenticated(request);
    headers = await withCsrfHeaders(request);
    response = await request.delete(`${API_URL}/collections/${id}`, { headers });
  }

  if (!response.ok() && response.status() === 503) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await request.delete(`${API_URL}/collections/${id}`, { headers });
  }

  if (!response.ok() && response.status() === 403) {
    await refreshCsrfInfo(request);
    headers = await withCsrfHeaders(request);
    response = await request.delete(`${API_URL}/collections/${id}`, { headers });
  }

  if (!response.ok()) {
    if (response.status() !== 404) {
      const text = await response.text();
      throw new Error(`Failed to delete collection ${id}: ${response.status()} ${text}`);
    }
  }

  try {
    await request.get(`${API_URL}/collections`);
  } catch {
    // Ignore cache warm-up failures.
  }
}
