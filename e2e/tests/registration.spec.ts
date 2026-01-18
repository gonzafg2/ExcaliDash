import { test, expect } from "./fixtures";
import { API_URL } from "./helpers/api";

const registerUser = async (request: any, payload: any) => {
  const csrfResponse = await request.get(`${API_URL}/csrf-token`);
  if (!csrfResponse.ok()) {
    throw new Error(`Failed to get CSRF token: ${csrfResponse.status()}`);
  }
  const data = (await csrfResponse.json()) as { token: string; header?: string };
  const headerName = data.header || "x-csrf-token";

  return request.post(`${API_URL}/auth/register`, {
    headers: {
      "Content-Type": "application/json",
      [headerName]: data.token,
    },
    data: payload,
  });
};

test.describe("Registration", () => {
  test("allows admin to enable registration and create user", async ({ page, request }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: /Enable registration/i }).click();
    await expect(page.getByText(/Registration is enabled/i)).toBeVisible();

    const registerResponse = await registerUser(request, {
      username: `newuser-${Date.now()}`,
      password: "password123",
    });
    expect(registerResponse.status()).toBe(201);
  });

  test("blocks registration when disabled", async ({ page, request }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: /Disable registration/i }).click();
    await expect(page.getByText(/Registration is disabled/i)).toBeVisible();

    const registerResponse = await registerUser(request, {
      username: "blocked",
      password: "password123",
    });
    expect(registerResponse.status()).toBe(403);
  });
});
