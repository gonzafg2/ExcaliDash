/**
 * Configuration validation and environment variable management
 */
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";

dotenv.config();

interface Config {
  port: number;
  nodeEnv: string;
  databaseUrl?: string;
  frontendUrl?: string;
  jwtSecret: string;
  jwtAccessExpiresIn: string;
  jwtRefreshExpiresIn: string;
  rateLimitMaxRequests: number;
  csrfMaxRequests: number;
  csrfSecret: string | null;
  // Feature flags - all default to false for backward compatibility
  enablePasswordReset: boolean;
  enableRefreshTokenRotation: boolean;
  enableAuditLogging: boolean;
}

const getOptionalEnv = (key: string, defaultValue: string): string => {
  return process.env[key] || defaultValue;
};

const resolveJwtSecret = (nodeEnv: string): string => {
  const provided = process.env.JWT_SECRET;
  if (provided && provided.trim().length > 0) {
    return provided;
  }

  if (nodeEnv === "production") {
    throw new Error("Missing required environment variable: JWT_SECRET");
  }

  const generated = crypto.randomBytes(32).toString("hex");
  console.warn(
    "[security] JWT_SECRET is not set (non-production). Using an ephemeral secret; tokens will be invalidated on restart."
  );
  return generated;
};

const parseFrontendUrl = (raw: string | undefined): string | undefined => {
  if (!raw || raw.trim().length === 0) return undefined;
  const normalized = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .join(",");
  return normalized.length > 0 ? normalized : undefined;
};

const resolveDatabaseUrl = (rawUrl?: string) => {
  const backendRoot = path.resolve(__dirname, "../");
  const defaultDbPath = path.resolve(backendRoot, "prisma/dev.db");

  if (!rawUrl || rawUrl.trim().length === 0) {
    return `file:${defaultDbPath}`;
  }

  if (!rawUrl.startsWith("file:")) {
    return rawUrl;
  }

  const filePath = rawUrl.replace(/^file:/, "");
  const prismaDir = path.resolve(backendRoot, "prisma");
  const normalizedRelative = filePath.replace(/^\.\/?/, "");
  const hasLeadingPrismaDir =
    normalizedRelative === "prisma" || normalizedRelative.startsWith("prisma/");

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(hasLeadingPrismaDir ? backendRoot : prismaDir, normalizedRelative);

  return `file:${absolutePath}`;
};

// Ensure DATABASE_URL is resolved before any PrismaClient is created.
process.env.DATABASE_URL = resolveDatabaseUrl(process.env.DATABASE_URL);

const getOptionalBoolean = (key: string, defaultValue: boolean): boolean => {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
};

const getRequiredEnvNumber = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for environment variable ${key}: must be a positive number`);
  }
  return parsed;
};

export const config: Config = {
  port: getRequiredEnvNumber("PORT", 8000),
  nodeEnv: getOptionalEnv("NODE_ENV", "development"),
  databaseUrl: process.env.DATABASE_URL,
  frontendUrl: parseFrontendUrl(process.env.FRONTEND_URL),
  jwtSecret: resolveJwtSecret(getOptionalEnv("NODE_ENV", "development")),
  jwtAccessExpiresIn: getOptionalEnv("JWT_ACCESS_EXPIRES_IN", "15m"),
  jwtRefreshExpiresIn: getOptionalEnv("JWT_REFRESH_EXPIRES_IN", "7d"),
  rateLimitMaxRequests: getRequiredEnvNumber("RATE_LIMIT_MAX_REQUESTS", 1000),
  csrfMaxRequests: getRequiredEnvNumber("CSRF_MAX_REQUESTS", 60),
  csrfSecret: process.env.CSRF_SECRET || null,
  // Feature flags - disabled by default for backward compatibility
  enablePasswordReset: getOptionalBoolean("ENABLE_PASSWORD_RESET", false),
  enableRefreshTokenRotation: getOptionalBoolean("ENABLE_REFRESH_TOKEN_ROTATION", false),
  enableAuditLogging: getOptionalBoolean("ENABLE_AUDIT_LOGGING", false),
};

// Validate JWT_SECRET strength in production
if (config.nodeEnv === "production") {
  const normalizedSecret = config.jwtSecret.trim();
  const insecureJwtSecretPlaceholders = new Set([
    "your-secret-key-change-in-production",
    "change-this-secret-in-production-min-32-chars",
  ]);

  if (config.jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters long in production");
  }
  if (
    insecureJwtSecretPlaceholders.has(normalizedSecret)
  ) {
    throw new Error("JWT_SECRET must be changed from placeholder/default value in production");
  }
}

console.log("Configuration validated successfully");
