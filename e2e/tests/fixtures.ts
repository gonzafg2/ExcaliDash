import { test as base, expect } from "@playwright/test";
import { ensurePageAuthenticated } from "./helpers/auth";

 type Fixtures = {
  skipAuth: boolean;
};

export const test = base.extend<Fixtures>({
  skipAuth: [false, { option: true }],
});

test.beforeEach(async ({ page, skipAuth }) => {
  if (skipAuth) {
    return;
  }

  await ensurePageAuthenticated(page);

  let authCheckInFlight: Promise<void> | null = null;
  const maybeReauthenticate = async () => {
    if (authCheckInFlight) {
      return authCheckInFlight;
    }

    authCheckInFlight = (async () => {
      const loginPrompt = page.getByText("Sign in to access your drawings");
      if (await loginPrompt.isVisible({ timeout: 3000 }).catch(() => false)) {
        await ensurePageAuthenticated(page, { skipNavigation: true });
      }
    })().finally(() => {
      authCheckInFlight = null;
    });

    return authCheckInFlight;
  };

  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) {
      return;
    }

    await maybeReauthenticate();
  });

  page.on("response", async (response) => {
    if (!response.url().includes("/auth/status")) {
      return;
    }

    try {
      const status = (await response.json()) as { authenticated?: boolean };
      if (status && status.authenticated === false) {
        await maybeReauthenticate();
      }
    } catch {
      // Ignore parse errors to avoid flakiness.
    }
  });
});


export { expect };

