import { APIRequestContext, Page } from "@playwright/test";
import { API_URL, getCsrfHeaders, refreshCsrfToken } from "./api";

const BASE_URL = process.env.API_URL || API_URL;

type AuthStatus = {
  enabled: boolean;
  authenticated: boolean;
  bootstrapRequired?: boolean;
};

const AUTH_USERNAME = process.env.AUTH_USERNAME || "admin";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "admin123";

const fetchAuthStatus = async (request: APIRequestContext): Promise<AuthStatus> => {
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await request.get(`${BASE_URL}/auth/status`);
      if (response.ok()) {
        return (await response.json()) as AuthStatus;
      }

      const text = await response.text();
      if (response.status() === 429 && attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000 + attempt * 500));
        continue;
      }

      throw new Error(`Failed to fetch auth status: ${response.status()} ${text}`);
    } catch (error) {
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 + attempt * 250));
        continue;
      }
      throw error;
    }
  }

  throw new Error("Failed to fetch auth status");
};

export const ensureApiAuthenticated = async (request: APIRequestContext) => {
  const status = await fetchAuthStatus(request);
  if (!status.enabled || status.authenticated) {
    return;
  }

  if (status.bootstrapRequired) {
    let response = await request.post(`${BASE_URL}/auth/bootstrap`, {
      headers: {
        "Content-Type": "application/json",
        ...(await getCsrfHeaders(request)),
      },
      data: {
        username: AUTH_USERNAME,
        password: AUTH_PASSWORD,
      },
    });

    if (!response.ok() && response.status() === 403) {
      await refreshCsrfToken(request);
      response = await request.post(`${BASE_URL}/auth/bootstrap`, {
        headers: {
          "Content-Type": "application/json",
          ...(await getCsrfHeaders(request)),
        },
        data: {
          username: AUTH_USERNAME,
          password: AUTH_PASSWORD,
        },
      });
    }

    if (!response.ok()) {
      const text = await response.text();
      throw new Error(`Failed to bootstrap test session: ${response.status()} ${text}`);
    }

    return;
  }

  let response = await request.post(`${BASE_URL}/auth/login`, {
    headers: {
      "Content-Type": "application/json",
      ...(await getCsrfHeaders(request)),
    },
    data: {
      username: AUTH_USERNAME,
      password: AUTH_PASSWORD,
    },
  });

  if (!response.ok() && response.status() === 403) {
    await refreshCsrfToken(request);
    const freshHeaders = {
      "Content-Type": "application/json",
      ...(await getCsrfHeaders(request)),
    };
    response = await request.post(`${BASE_URL}/auth/login`, {
      headers: freshHeaders,
      data: {
        username: AUTH_USERNAME,
        password: AUTH_PASSWORD,
      },
    });
  }

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Failed to authenticate test session: ${response.status()} ${text}`);
  }
};

type EnsureAuthOptions = {
  skipNavigation?: boolean;
};

export const ensurePageAuthenticated = async (
  page: Page,
  { skipNavigation = false }: EnsureAuthOptions = {}
) => {
  await ensureApiAuthenticated(page.request);
  const storageState = await page.request.storageState();
  if (storageState.cookies.length > 0) {
    await page.context().addCookies(
      storageState.cookies.filter((cookie) => cookie.name && cookie.value)
    );
  }

  if (!skipNavigation) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
  }

  const dashboardReady = page.getByPlaceholder("Search drawings...");
  const identifierField = page.getByLabel("Username or Email");
  const passwordField = page.getByLabel("Password");

  if (skipNavigation) {
    if (await identifierField.isVisible({ timeout: 1000 }).catch(() => false)) {
      await identifierField.fill(AUTH_USERNAME);
      await passwordField.fill(AUTH_PASSWORD);

      const confirmPasswordField = page.getByLabel("Confirm Password");
      if (await confirmPasswordField.isVisible().catch(() => false)) {
        await confirmPasswordField.fill(AUTH_PASSWORD);
      }

      await page
        .getByRole("button", { name: /sign in|create admin|create account/i })
        .click();
      await dashboardReady.waitFor({ state: "visible", timeout: 30000 });
    }
    return;
  }

  await Promise.race([
    dashboardReady.waitFor({ state: "visible", timeout: 15000 }),
    identifierField.waitFor({ state: "visible", timeout: 15000 }),
  ]);

  if (await dashboardReady.isVisible().catch(() => false)) {
    return;
  }

  if (await identifierField.isVisible().catch(() => false)) {
    await identifierField.fill(AUTH_USERNAME);
    await passwordField.fill(AUTH_PASSWORD);

    const confirmPasswordField = page.getByLabel("Confirm Password");
    if (await confirmPasswordField.isVisible().catch(() => false)) {
      await confirmPasswordField.fill(AUTH_PASSWORD);
    }

    await page
      .getByRole("button", { name: /sign in|create admin|create account/i })
      .click();
    await dashboardReady.waitFor({ state: "visible", timeout: 30000 });
    return;
  }

  await dashboardReady.waitFor({ state: "visible", timeout: 15000 });
};
