/**
 * Configuration validation and environment variable management
 */
import dotenv from "dotenv";

dotenv.config();

interface Config {
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  frontendUrl: string;
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

const getRequiredEnv = (key: string): string => {
  const value = process.env[key];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const getOptionalEnv = (key: string, defaultValue: string): string => {
  return process.env[key] || defaultValue;
};

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
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  frontendUrl: getOptionalEnv("FRONTEND_URL", "http://localhost:6767"),
  jwtSecret: getRequiredEnv("JWT_SECRET"),
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
  if (config.jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters long in production");
  }
  if (config.jwtSecret === "your-secret-key-change-in-production") {
    throw new Error("JWT_SECRET must be changed from default value in production");
  }
}

// Validate frontend URL format
try {
  new URL(config.frontendUrl);
} catch {
  throw new Error(`Invalid FRONTEND_URL format: ${config.frontendUrl}`);
}

console.log("Configuration validated successfully");