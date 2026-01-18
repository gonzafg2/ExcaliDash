import { defineConfig, devices } from "@playwright/test";
import path from "path";
import os from "os";

// Centralized test environment URLs
const FRONTEND_PORT = 5173;
const BACKEND_PORT = 8000;
const FRONTEND_URL = process.env.BASE_URL || `http://localhost:${FRONTEND_PORT}`;
const BACKEND_URL = process.env.API_URL || `http://localhost:${BACKEND_PORT}`;
const API_URL = BACKEND_URL;
const AUTH_USERNAME = process.env.AUTH_USERNAME || "admin";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "admin123";
const AUTH_SESSION_SECRET = process.env.AUTH_SESSION_SECRET || "e2e-auth-secret";
const E2E_DB_NAME = process.env.E2E_DB_NAME || `e2e-${Date.now()}.db`;
const DATABASE_URL = process.env.DATABASE_URL || `file:${path.join(os.tmpdir(), E2E_DB_NAME)}`;

process.env.AUTH_USERNAME = AUTH_USERNAME;
process.env.AUTH_PASSWORD = AUTH_PASSWORD;
process.env.AUTH_SESSION_SECRET = AUTH_SESSION_SECRET;
process.env.AUTH_EMAIL = process.env.AUTH_EMAIL || "admin@example.com";
process.env.AUTH_MIN_PASSWORD_LENGTH = process.env.AUTH_MIN_PASSWORD_LENGTH || "7";
process.env.E2E_DB_NAME = E2E_DB_NAME;
process.env.DATABASE_URL = DATABASE_URL;
process.env.VITE_API_URL = process.env.VITE_API_URL || "/api";

/**
 * Playwright configuration for E2E browser testing
 * 
 * Environment variables:
 * - BASE_URL: Frontend URL (default: http://localhost:5173)
 * - API_URL: Backend API URL (default: http://localhost:8000)
 * - HEADED: Run in headed mode (default: false)
 * - NO_SERVER: Skip starting servers (default: false)
 */
export default defineConfig({
  testDir: "./tests",

  // Run tests in parallel
  fullyParallel: false,

  // Fail the build on test.only() in CI
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Limit parallel workers in CI
  workers: process.env.CI ? 1 : 1,

  // Reporter configuration
  reporter: [
    ["list"],
    [
      "html",
      {
        // Useful when a previous Docker run produced root-owned artifacts.
        // Allows local runs to redirect output without editing the config.
        outputFolder: process.env.PLAYWRIGHT_REPORT_DIR || "playwright-report",
      },
    ],
  ],

  // Output folder for test artifacts
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results",

  // Global timeout for each test
  timeout: 60000,

  // Expect timeout
  expect: {
    timeout: 10000,
  },

  use: {
    // Base URL for page.goto()
    baseURL: FRONTEND_URL,

    // Load shared auth state
    storageState: path.resolve(__dirname, "tests/.auth/storageState.json"),

    // Collect trace on first retry
    trace: "on-first-retry",

    // Screenshot on failure
    screenshot: "only-on-failure",

    // Video on failure
    video: "on-first-retry",

    // Headed mode based on env var
    headless: process.env.HEADED !== "true",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Viewport for consistent screenshots
        viewport: { width: 1280, height: 720 },
      },
    },
  ],

  // Run local dev servers before tests (skip if NO_SERVER or CI)
  webServer: (process.env.CI || process.env.NO_SERVER === "true")
    ? undefined
    : [
        {
          command: "cd ../backend && npx prisma db push && npx ts-node src/index.ts",
          url: `${BACKEND_URL}/health`,
          reuseExistingServer: false,
          timeout: 120000,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            // Prisma resolves relative SQLite paths from the schema directory (backend/prisma).
            DATABASE_URL,
            FRONTEND_URL,
            CSRF_MAX_REQUESTS: "10000",
            AUTH_USERNAME,
            AUTH_PASSWORD,
            AUTH_MIN_PASSWORD_LENGTH: "7",
            AUTH_SESSION_SECRET,
            AUTH_SESSION_TTL_HOURS: "4",
            RATE_LIMIT_MAX_REQUESTS: "20000",
            NODE_ENV: "e2e",
            TS_NODE_TRANSPILE_ONLY: "1",
          },
        },
        {
          command: "cd ../frontend && npm run dev -- --host",
          url: FRONTEND_URL,
          reuseExistingServer: false,
          timeout: 120000,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            VITE_API_URL: "/api",
            API_URL,
          },
        },
      ],

  globalSetup: require.resolve("./tests/global-setup"),
  globalTeardown: require.resolve("./tests/global-teardown"),
});

