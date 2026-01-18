import type { Page } from "@playwright/test";
import { PrismaClient } from "../../backend/src/generated/client";
import { test, expect } from "./fixtures";

const AUTH_USERNAME = process.env.AUTH_USERNAME || "admin";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "admin123";
const DATABASE_URL = process.env.DATABASE_URL;

const ensureLoggedOut = async (page: Page) => {
  await page.context().clearCookies();
  await page.goto("/");
  const signInPrompt = page.getByText("Sign in to access your drawings");
  if (await signInPrompt.isVisible().catch(() => false)) {
    return;
  }
  await page.goto("/settings");
  const logoutButton = page.getByRole("button", { name: /Log out/i });
  if (await logoutButton.isVisible().catch(() => false)) {
    await logoutButton.click();
  }
  await expect(signInPrompt).toBeVisible();
};

const login = async (page: Page, password: string) => {
  await page.getByLabel("Username or Email").fill(AUTH_USERNAME);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
};

const waitForResetOrDashboard = async (page: Page) => {
  const resetPrompt = page.getByText("Reset the admin password");
  const dashboardReady = page.getByPlaceholder("Search drawings...");
  const settingsHeader = page.getByRole("heading", { name: "Settings" });

  await Promise.race([
    resetPrompt.waitFor({ state: "visible", timeout: 15000 }).catch(() => null),
    dashboardReady.waitFor({ state: "visible", timeout: 15000 }).catch(() => null),
    settingsHeader.waitFor({ state: "visible", timeout: 15000 }).catch(() => null),
  ]);

  if (await resetPrompt.isVisible().catch(() => false)) {
    return "reset" as const;
  }

  if (await dashboardReady.isVisible().catch(() => false)) {
    return "dashboard" as const;
  }

  if (await settingsHeader.isVisible().catch(() => false)) {
    return "settings" as const;
  }

  return "unknown" as const;
};

const ensureDashboard = async (page: Page) => {
  await expect(page.getByPlaceholder("Search drawings...")).toBeVisible({ timeout: 30000 });
};

const setMustResetPassword = async (enabled: boolean) => {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is not set for e2e test.");
  }

  const prisma = new PrismaClient({
    datasources: {
      db: { url: DATABASE_URL },
    },
  });

  try {
    const admin = await prisma.user.findFirst({
      where: { username: AUTH_USERNAME },
      select: { id: true },
    });

    if (!admin) {
      throw new Error(`Admin user ${AUTH_USERNAME} not found.`);
    }

    await prisma.user.update({
      where: { id: admin.id },
      data: { mustResetPassword: enabled },
    });
  } finally {
    await prisma.$disconnect();
  }
};

test.describe("Admin password reset", () => {
  test.use({ skipAuth: true });

  test("prompts and clears reset requirement for generated admin password", async ({ page }) => {
    await ensureLoggedOut(page);

    await login(page, AUTH_PASSWORD);
    let initialState = await waitForResetOrDashboard(page);
    if (initialState === "settings") {
      await page.goto("/");
      initialState = await waitForResetOrDashboard(page);
    }
    if (initialState === "reset") {
      await page.getByLabel("Current Password").fill(AUTH_PASSWORD);
      await page.getByLabel("New Password").fill(AUTH_PASSWORD);
      await page.getByLabel("Confirm Password").fill(AUTH_PASSWORD);
      await page.getByRole("button", { name: "Reset password" }).click();
      await expect(page.getByPlaceholder("Search drawings...")).toBeVisible({ timeout: 30000 });
    }

    await setMustResetPassword(true);
    await ensureLoggedOut(page);

    await login(page, AUTH_PASSWORD);
    await expect(page.getByText("Reset the admin password")).toBeVisible({ timeout: 30000 });
    await page.getByLabel("Current Password").fill(AUTH_PASSWORD);
    await page.getByLabel("New Password").fill(AUTH_PASSWORD);
    await page.getByLabel("Confirm Password").fill(AUTH_PASSWORD);
    await page.getByRole("button", { name: "Reset password" }).click();

    await page.goto("/");
    await ensureDashboard(page);

    await ensureLoggedOut(page);
    await login(page, AUTH_PASSWORD);
    await ensureDashboard(page);
  });
});
