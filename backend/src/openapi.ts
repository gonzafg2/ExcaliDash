/**
 * OpenAPI spec generator for ExcaliDash API.
 *
 * Reads the existing Zod schemas and route definitions to produce an
 * openapi.json file.  Run with:  npm run openapi
 */

import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import fs from "fs";
import path from "path";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// ---------------------------------------------------------------------------
// Reusable schemas
// ---------------------------------------------------------------------------

const ErrorResponse = z
  .object({
    error: z.string(),
    message: z.string().optional(),
  })
  .openapi("ErrorResponse");

const bearerAuth = registry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

const authed = [{ [bearerAuth.name]: [] }];

// ---------------------------------------------------------------------------
// Auth – Core
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/auth/register",
  tags: ["Auth"],
  summary: "Register a new user",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email(),
            password: z.string().min(12),
            name: z.string().min(1),
            username: z.string().optional(),
            setupCode: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "User registered" },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
    409: { description: "Email already in use" },
  },
});

registry.registerPath({
  method: "post",
  path: "/auth/login",
  tags: ["Auth"],
  summary: "Login with credentials",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            identifier: z.string().optional(),
            email: z.string().email().optional(),
            username: z.string().optional(),
            password: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Login successful (sets httpOnly cookies)" },
    401: { description: "Invalid credentials" },
  },
});

registry.registerPath({
  method: "post",
  path: "/auth/refresh",
  tags: ["Auth"],
  summary: "Refresh access token via refresh cookie",
  responses: {
    200: { description: "Token refreshed" },
    401: { description: "Invalid or expired refresh token" },
  },
});

registry.registerPath({
  method: "post",
  path: "/auth/logout",
  tags: ["Auth"],
  summary: "Logout (clears cookies)",
  responses: { 200: { description: "Logged out" } },
});

registry.registerPath({
  method: "get",
  path: "/auth/me",
  tags: ["Auth"],
  summary: "Get current user profile",
  security: authed,
  responses: {
    200: { description: "Current user info" },
    401: { description: "Not authenticated" },
  },
});

registry.registerPath({
  method: "get",
  path: "/auth/status",
  tags: ["Auth"],
  summary: "Get auth system status (auth mode, registration open, etc.)",
  responses: { 200: { description: "Auth status" } },
});

registry.registerPath({
  method: "post",
  path: "/auth/onboarding-choice",
  tags: ["Auth"],
  summary: "Complete auth onboarding choice (enable/disable auth)",
  request: {
    body: { content: { "application/json": { schema: z.object({ enableAuth: z.boolean() }) } } },
  },
  responses: { 200: { description: "Onboarding completed" } },
});

registry.registerPath({
  method: "post",
  path: "/auth/auth-enabled",
  tags: ["Auth"],
  summary: "Toggle auth enabled/disabled (admin only)",
  security: authed,
  request: {
    body: { content: { "application/json": { schema: z.object({ enabled: z.boolean() }) } } },
  },
  responses: { 200: { description: "Auth toggled" } },
});

registry.registerPath({
  method: "post",
  path: "/auth/stop-impersonation",
  tags: ["Auth"],
  summary: "Stop impersonating a user",
  security: authed,
  responses: { 200: { description: "Impersonation stopped" } },
});

// ---------------------------------------------------------------------------
// Auth – Account
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/auth/password-reset-request",
  tags: ["Auth – Account"],
  summary: "Request password reset email",
  request: {
    body: { content: { "application/json": { schema: z.object({ email: z.string().email() }) } } },
  },
  responses: { 200: { description: "Reset email sent (if account exists)" } },
});

registry.registerPath({
  method: "post",
  path: "/auth/password-reset-confirm",
  tags: ["Auth – Account"],
  summary: "Confirm password reset with token",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ token: z.string(), password: z.string().min(12) }),
        },
      },
    },
  },
  responses: { 200: { description: "Password reset" }, 400: { description: "Invalid token" } },
});

registry.registerPath({
  method: "put",
  path: "/auth/profile",
  tags: ["Auth – Account"],
  summary: "Update current user profile",
  security: authed,
  request: {
    body: { content: { "application/json": { schema: z.object({ name: z.string().min(1).max(100) }) } } },
  },
  responses: { 200: { description: "Profile updated" } },
});

registry.registerPath({
  method: "put",
  path: "/auth/email",
  tags: ["Auth – Account"],
  summary: "Update current user email",
  security: authed,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ email: z.string().email(), currentPassword: z.string() }),
        },
      },
    },
  },
  responses: { 200: { description: "Email updated" }, 401: { description: "Wrong password" } },
});

registry.registerPath({
  method: "post",
  path: "/auth/change-password",
  tags: ["Auth – Account"],
  summary: "Change password",
  security: authed,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ currentPassword: z.string(), newPassword: z.string().min(12) }),
        },
      },
    },
  },
  responses: { 200: { description: "Password changed" } },
});

registry.registerPath({
  method: "post",
  path: "/auth/must-reset-password",
  tags: ["Auth – Account"],
  summary: "Forced password reset (when mustResetPassword is true)",
  security: authed,
  request: {
    body: {
      content: { "application/json": { schema: z.object({ newPassword: z.string().min(12) }) } },
    },
  },
  responses: { 200: { description: "Password reset completed" } },
});

// ---------------------------------------------------------------------------
// Auth – Admin
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/auth/registration/toggle",
  tags: ["Auth – Admin"],
  summary: "Toggle registration open/closed",
  security: authed,
  request: {
    body: { content: { "application/json": { schema: z.object({ enabled: z.boolean() }) } } },
  },
  responses: { 200: { description: "Registration toggled" } },
});

registry.registerPath({
  method: "post",
  path: "/auth/admins",
  tags: ["Auth – Admin"],
  summary: "Promote/demote user to admin",
  security: authed,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ identifier: z.string(), role: z.enum(["ADMIN", "USER"]) }),
        },
      },
    },
  },
  responses: { 200: { description: "Role updated" } },
});

registry.registerPath({
  method: "get",
  path: "/auth/users",
  tags: ["Auth – Admin"],
  summary: "List all users (admin only)",
  security: authed,
  responses: { 200: { description: "Array of users" } },
});

registry.registerPath({
  method: "post",
  path: "/auth/users",
  tags: ["Auth – Admin"],
  summary: "Admin create a new user",
  security: authed,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email(),
            password: z.string().min(12),
            name: z.string().min(1),
            username: z.string().optional(),
            role: z.enum(["ADMIN", "USER"]).optional(),
            mustResetPassword: z.boolean().optional(),
            isActive: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: { 201: { description: "User created" } },
});

registry.registerPath({
  method: "patch",
  path: "/auth/users/{id}",
  tags: ["Auth – Admin"],
  summary: "Admin update user",
  security: authed,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            username: z.string().nullable().optional(),
            name: z.string().optional(),
            role: z.enum(["ADMIN", "USER"]).optional(),
            mustResetPassword: z.boolean().optional(),
            isActive: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: { 200: { description: "User updated" } },
});

registry.registerPath({
  method: "post",
  path: "/auth/users/{id}/reset-password",
  tags: ["Auth – Admin"],
  summary: "Admin reset user password",
  security: authed,
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: "Temporary password generated" } },
});

registry.registerPath({
  method: "get",
  path: "/auth/impersonation-targets",
  tags: ["Auth – Admin"],
  summary: "List users available for impersonation",
  security: authed,
  responses: { 200: { description: "Array of impersonation targets" } },
});

registry.registerPath({
  method: "post",
  path: "/auth/impersonate",
  tags: ["Auth – Admin"],
  summary: "Impersonate a user (admin only)",
  security: authed,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            userId: z.string().optional(),
            identifier: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: { 200: { description: "Impersonation started" } },
});

registry.registerPath({
  method: "get",
  path: "/auth/rate-limit/login",
  tags: ["Auth – Admin"],
  summary: "Get login rate limit config",
  security: authed,
  responses: { 200: { description: "Rate limit settings" } },
});

registry.registerPath({
  method: "put",
  path: "/auth/rate-limit/login",
  tags: ["Auth – Admin"],
  summary: "Update login rate limit config",
  security: authed,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ enabled: z.boolean(), windowMs: z.number(), max: z.number() }),
        },
      },
    },
  },
  responses: { 200: { description: "Rate limit updated" } },
});

registry.registerPath({
  method: "post",
  path: "/auth/rate-limit/login/reset",
  tags: ["Auth – Admin"],
  summary: "Reset login rate limit for a user",
  security: authed,
  request: {
    body: {
      content: { "application/json": { schema: z.object({ identifier: z.string() }) } },
    },
  },
  responses: { 200: { description: "Rate limit reset" } },
});

// ---------------------------------------------------------------------------
// Auth – OIDC
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/auth/oidc/start",
  tags: ["Auth – OIDC"],
  summary: "Start OIDC authentication flow (redirect to provider)",
  responses: { 302: { description: "Redirect to OIDC provider" } },
});

registry.registerPath({
  method: "get",
  path: "/auth/oidc/callback",
  tags: ["Auth – OIDC"],
  summary: "OIDC callback (processes provider response)",
  responses: { 302: { description: "Redirect to frontend after authentication" } },
});

// ---------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/drawings",
  tags: ["Drawings"],
  summary: "List user drawings with pagination",
  security: authed,
  request: {
    query: z.object({
      collectionId: z.string().optional(),
      sort: z.enum(["name", "updatedAt", "createdAt"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
      includeData: z.string().optional(),
    }),
  },
  responses: { 200: { description: "Paginated drawings list" } },
});

registry.registerPath({
  method: "get",
  path: "/drawings/shared",
  tags: ["Drawings"],
  summary: "List drawings shared with the current user",
  security: authed,
  responses: { 200: { description: "Paginated shared drawings" } },
});

registry.registerPath({
  method: "get",
  path: "/drawings/{id}",
  tags: ["Drawings"],
  summary: "Get a single drawing by ID",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Drawing data" },
    404: { description: "Drawing not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/drawings",
  tags: ["Drawings"],
  summary: "Create a new drawing",
  security: authed,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            collectionId: z.string().nullable().optional(),
            elements: z.array(z.any()).optional(),
            appState: z.record(z.string(), z.any()).optional(),
            files: z.record(z.string(), z.any()).nullable().optional(),
            preview: z.string().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: { 201: { description: "Drawing created" } },
});

registry.registerPath({
  method: "put",
  path: "/drawings/{id}",
  tags: ["Drawings"],
  summary: "Update a drawing",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            collectionId: z.string().nullable().optional(),
            elements: z.array(z.any()).optional(),
            appState: z.record(z.string(), z.any()).optional(),
            files: z.record(z.string(), z.any()).nullable().optional(),
            preview: z.string().nullable().optional(),
            version: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Drawing updated" },
    404: { description: "Drawing not found" },
    409: { description: "Version conflict" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/drawings/{id}",
  tags: ["Drawings"],
  summary: "Delete a drawing (soft-delete to trash)",
  security: authed,
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: "Drawing deleted" } },
});

registry.registerPath({
  method: "post",
  path: "/drawings/{id}/duplicate",
  tags: ["Drawings"],
  summary: "Duplicate a drawing",
  security: authed,
  request: { params: z.object({ id: z.string() }) },
  responses: { 201: { description: "Drawing duplicated" } },
});

// ---------------------------------------------------------------------------
// Drawings – Sharing
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/drawings/{id}/share-resolve",
  tags: ["Drawings – Sharing"],
  summary: "Resolve share link to drawing access",
  security: authed,
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: "Share resolution" } },
});

registry.registerPath({
  method: "get",
  path: "/drawings/{id}/sharing",
  tags: ["Drawings – Sharing"],
  summary: "Get sharing info for a drawing",
  security: authed,
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: "Sharing info (permissions + link shares)" } },
});

registry.registerPath({
  method: "post",
  path: "/drawings/{id}/permissions",
  tags: ["Drawings – Sharing"],
  summary: "Grant user permission on a drawing",
  security: authed,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            identifier: z.string(),
            permission: z.enum(["view", "edit"]),
          }),
        },
      },
    },
  },
  responses: { 201: { description: "Permission granted" } },
});

registry.registerPath({
  method: "delete",
  path: "/drawings/{id}/permissions/{permId}",
  tags: ["Drawings – Sharing"],
  summary: "Revoke a user permission",
  security: authed,
  request: { params: z.object({ id: z.string(), permId: z.string() }) },
  responses: { 200: { description: "Permission revoked" } },
});

registry.registerPath({
  method: "post",
  path: "/drawings/{id}/link-shares",
  tags: ["Drawings – Sharing"],
  summary: "Create a shareable link for a drawing",
  security: authed,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            permission: z.enum(["view", "edit"]).optional(),
            expiresAt: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: { 201: { description: "Link share created" } },
});

registry.registerPath({
  method: "delete",
  path: "/drawings/{id}/link-shares/{shareId}",
  tags: ["Drawings – Sharing"],
  summary: "Revoke a link share",
  security: authed,
  request: { params: z.object({ id: z.string(), shareId: z.string() }) },
  responses: { 200: { description: "Link share revoked" } },
});

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/collections",
  tags: ["Collections"],
  summary: "List user collections",
  security: authed,
  responses: { 200: { description: "Array of collections" } },
});

registry.registerPath({
  method: "post",
  path: "/collections",
  tags: ["Collections"],
  summary: "Create a new collection",
  security: authed,
  request: {
    body: {
      content: { "application/json": { schema: z.object({ name: z.string().min(1).max(100) }) } },
    },
  },
  responses: { 201: { description: "Collection created" } },
});

registry.registerPath({
  method: "put",
  path: "/collections/{id}",
  tags: ["Collections"],
  summary: "Rename a collection",
  security: authed,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: z.object({ name: z.string().min(1).max(100) }) } },
    },
  },
  responses: { 200: { description: "Collection updated" } },
});

registry.registerPath({
  method: "delete",
  path: "/collections/{id}",
  tags: ["Collections"],
  summary: "Delete a collection",
  security: authed,
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: "Collection deleted" } },
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/library",
  tags: ["Library"],
  summary: "Get user library items",
  security: authed,
  responses: { 200: { description: "Library items array" } },
});

registry.registerPath({
  method: "put",
  path: "/library",
  tags: ["Library"],
  summary: "Replace user library items",
  security: authed,
  request: {
    body: {
      content: { "application/json": { schema: z.object({ items: z.array(z.any()) }) } },
    },
  },
  responses: { 200: { description: "Library updated" } },
});

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/export/excalidash",
  tags: ["Import / Export"],
  summary: "Export all drawings as ZIP archive",
  security: authed,
  responses: {
    200: { description: "ZIP archive download" },
  },
});

registry.registerPath({
  method: "post",
  path: "/import/excalidash/verify",
  tags: ["Import / Export"],
  summary: "Verify an ExcaliDash ZIP archive before import",
  security: authed,
  responses: {
    200: { description: "Verification result (counts, conflicts)" },
    400: { description: "Invalid archive" },
  },
});

registry.registerPath({
  method: "post",
  path: "/import/excalidash",
  tags: ["Import / Export"],
  summary: "Import drawings from ExcaliDash ZIP archive",
  security: authed,
  responses: {
    200: { description: "Import result" },
    400: { description: "Invalid archive" },
  },
});

registry.registerPath({
  method: "post",
  path: "/import/sqlite/legacy/verify",
  tags: ["Import / Export"],
  summary: "Verify a legacy SQLite database before import",
  security: authed,
  responses: {
    200: { description: "Verification result" },
    400: { description: "Invalid database" },
  },
});

registry.registerPath({
  method: "post",
  path: "/import/sqlite/legacy",
  tags: ["Import / Export"],
  summary: "Import drawings from legacy SQLite database",
  security: authed,
  responses: {
    200: { description: "Import result" },
    400: { description: "Invalid database" },
  },
});

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Health check",
  responses: {
    200: {
      description: "Service healthy",
      content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/csrf-token",
  tags: ["System"],
  summary: "Get CSRF token",
  responses: { 200: { description: "CSRF token in response header" } },
});

registry.registerPath({
  method: "get",
  path: "/system/update-check",
  tags: ["System"],
  summary: "Check for available updates",
  responses: { 200: { description: "Update check result" } },
});

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

const generator = new OpenApiGeneratorV31(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.1.0",
  info: {
    title: "ExcaliDash API",
    version: require("../package.json").version,
    description:
      "Self-hosted collaborative drawing dashboard built on Excalidraw.",
  },
  servers: [{ url: "http://localhost:8000", description: "Local development" }],
});

const outPath = path.resolve(__dirname, "../openapi.json");
fs.writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n");
console.log(`OpenAPI spec written to ${outPath}`);
