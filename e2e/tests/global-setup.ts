import { promises as fs } from "fs";
import path from "path";
import { request } from "@playwright/test";
import { ensureApiAuthenticated } from "./helpers/auth";

const AUTH_STATE_PATH = path.resolve(__dirname, ".auth/storageState.json");

const waitForServer = async (baseURL: string) => {
  const apiRequest = await request.newContext({ baseURL });
  const timeoutMs = 60000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await apiRequest.get("/health");
      if (response.ok()) {
        await apiRequest.dispose();
        return;
      }
    } catch {
      // Ignore connection errors while server boots.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  await apiRequest.dispose();
  throw new Error(`Backend did not become ready within ${timeoutMs}ms`);
};

const globalSetup = async () => {
  const baseURL = process.env.API_URL || "http://localhost:8000";
  await waitForServer(baseURL);

  const apiRequest = await request.newContext({
    baseURL,
    extraHTTPHeaders: {
      Connection: "close",
    },
  });

  try {
    await ensureApiAuthenticated(apiRequest);
    await fs.mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true });
    await apiRequest.storageState({ path: AUTH_STATE_PATH });
  } finally {
    await apiRequest.dispose();
  }
};

export default globalSetup;
