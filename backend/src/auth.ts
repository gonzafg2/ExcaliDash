import express, { Request, Response } from "express";
import crypto from "crypto";
import jwt, { SignOptions } from "jsonwebtoken";
import ms, { type StringValue } from "ms";
import { PrismaClient, Prisma } from "./generated/client";
import { config } from "./config";
import { requireAuth, optionalAuth } from "./middleware/auth";
import { getCsrfTokenHeader, sanitizeText, validateCsrfToken } from "./security";
import rateLimit, { MemoryStore } from "express-rate-limit";
import { registerAccountRoutes } from "./auth/accountRoutes";
import { registerAdminRoutes } from "./auth/adminRoutes";
import { registerCoreRoutes } from "./auth/coreRoutes";

interface JwtPayload {
  userId: string;
  email: string;
  type: "access" | "refresh";
  impersonatorId?: string;
}

const isJwtPayload = (decoded: unknown): decoded is JwtPayload => {
  if (typeof decoded !== "object" || decoded === null) {
    return false;
  }
  const payload = decoded as Record<string, unknown>;
  return (
    typeof payload.userId === "string" &&
    typeof payload.email === "string" &&
    (payload.type === "access" || payload.type === "refresh")
  );
};

const router = express.Router();
const prisma = new PrismaClient();

const BOOTSTRAP_USER_ID = "bootstrap-admin";
const DEFAULT_SYSTEM_CONFIG_ID = "default";

const ensureSystemConfig = async () => {
  return prisma.systemConfig.upsert({
    where: { id: DEFAULT_SYSTEM_CONFIG_ID },
    update: {},
    create: {
      id: DEFAULT_SYSTEM_CONFIG_ID,
      authEnabled: false,
      registrationEnabled: false,
      authLoginRateLimitEnabled: true,
      authLoginRateLimitWindowMs: 15 * 60 * 1000,
      authLoginRateLimitMax: 20,
    },
  });
};

const ensureAuthEnabled = async (res: Response): Promise<boolean> => {
  const systemConfig = await ensureSystemConfig();
  if (!systemConfig.authEnabled) {
    res.status(404).json({
      error: "Not found",
      message: "Authentication is disabled",
    });
    return false;
  }
  return true;
};

type LoginRateLimitConfig = {
  enabled: boolean;
  windowMs: number;
  max: number;
};

const DEFAULT_LOGIN_RATE_LIMIT: LoginRateLimitConfig = {
  enabled: true,
  windowMs: 15 * 60 * 1000,
  max: 20,
};

let loginRateLimitConfig: LoginRateLimitConfig = { ...DEFAULT_LOGIN_RATE_LIMIT };
let loginAttemptLimiter: ReturnType<typeof rateLimit> | null = null;
let loginLimiterInitPromise: Promise<void> | null = null;

const parseLoginRateLimitConfig = (systemConfig: Awaited<ReturnType<typeof ensureSystemConfig>>): LoginRateLimitConfig => {
  const enabled = typeof systemConfig.authLoginRateLimitEnabled === "boolean" ? systemConfig.authLoginRateLimitEnabled : DEFAULT_LOGIN_RATE_LIMIT.enabled;
  const windowMs =
    Number.isFinite(Number(systemConfig.authLoginRateLimitWindowMs)) && Number(systemConfig.authLoginRateLimitWindowMs) > 0
      ? Number(systemConfig.authLoginRateLimitWindowMs)
      : DEFAULT_LOGIN_RATE_LIMIT.windowMs;
  const max =
    Number.isFinite(Number(systemConfig.authLoginRateLimitMax)) && Number(systemConfig.authLoginRateLimitMax) > 0
      ? Number(systemConfig.authLoginRateLimitMax)
      : DEFAULT_LOGIN_RATE_LIMIT.max;
  return { enabled, windowMs, max };
};

const resolveAuthIdentifier = (req: Request): string | null => {
  const body = (req.body || {}) as Record<string, unknown>;
  const raw =
    (typeof body.email === "string" && body.email) ||
    (typeof body.username === "string" && body.username) ||
    (typeof body.identifier === "string" && body.identifier) ||
    null;
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed.slice(0, 255) : null;
};

const buildLoginAttemptLimiter = (cfg: LoginRateLimitConfig) => {
  const store = new MemoryStore();
  const limiter = rateLimit({
    windowMs: cfg.windowMs,
    max: cfg.max,
    message: {
      error: "Too many requests",
      message: "Too many login attempts, please try again later",
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: {
      trustProxy: false,
    },
    store,
    keyGenerator: (req) => {
      const identifier = resolveAuthIdentifier(req as Request);
      if (identifier) return `login:${identifier}`;
      const ip = (req as Request).ip || "unknown";
      return `login-ip:${ip}`;
    },
  });

  loginAttemptLimiter = limiter;
};

const initLoginAttemptLimiter = async () => {
  const systemConfig = await ensureSystemConfig();
  loginRateLimitConfig = parseLoginRateLimitConfig(systemConfig);
  buildLoginAttemptLimiter(loginRateLimitConfig);
};

const ensureLoginAttemptLimiter = async () => {
  if (loginAttemptLimiter) return;
  if (!loginLimiterInitPromise) {
    loginLimiterInitPromise = initLoginAttemptLimiter().finally(() => {
      loginLimiterInitPromise = null;
    });
  }
  await loginLimiterInitPromise;
};

const applyLoginRateLimitConfig = (
  systemConfig: Pick<Awaited<ReturnType<typeof ensureSystemConfig>>, "authLoginRateLimitEnabled" | "authLoginRateLimitWindowMs" | "authLoginRateLimitMax">
): LoginRateLimitConfig => {
  loginRateLimitConfig = parseLoginRateLimitConfig(systemConfig as Awaited<ReturnType<typeof ensureSystemConfig>>);
  buildLoginAttemptLimiter(loginRateLimitConfig);
  return loginRateLimitConfig;
};

const resetLoginAttemptKey = async (identifier: string): Promise<void> => {
  await ensureLoginAttemptLimiter();
  const key = `login:${identifier}`;
  try {
    await loginAttemptLimiter?.resetKey(key);
  } catch (error) {
    if (process.env.NODE_ENV === "development") {
      console.debug("Rate limit reset skipped:", error);
    }
  }
};

const loginAttemptRateLimiter = async (req: Request, res: Response, next: express.NextFunction) => {
  await ensureLoginAttemptLimiter();
  if (!loginRateLimitConfig.enabled) return next();
  return (loginAttemptLimiter as ReturnType<typeof rateLimit>)(req, res, next);
};

const accountActionRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: {
    error: "Too many requests",
    message: "Too many requests, please try again later",
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    trustProxy: false,
  },
});

const generateTempPassword = (): string => {
  const buf = crypto.randomBytes(18);
  return buf.toString("base64").replace(/[+/=]/g, "").slice(0, 24);
};

const findUserByIdentifier = async (identifier: string) => {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) return null;

  const looksLikeEmail = trimmed.includes("@");
  if (looksLikeEmail) {
    return prisma.user.findUnique({
      where: { email: trimmed.toLowerCase() },
    });
  }

  return prisma.user.findFirst({
    where: {
      OR: [{ username: trimmed }, { email: trimmed.toLowerCase() }],
    },
  });
};

const requireAdmin = (
  req: Request,
  res: Response
): req is Request & { user: NonNullable<Request["user"]> } => {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized", message: "User not authenticated" });
    return false;
  }
  if (req.user.role !== "ADMIN") {
    res.status(403).json({ error: "Forbidden", message: "Admin access required" });
    return false;
  }
  return true;
};

const CSRF_CLIENT_COOKIE_NAME = "excalidash-csrf-client";

const parseCookies = (cookieHeader: string | undefined): Record<string, string> => {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValueParts] = part.split("=");
    const key = rawKey?.trim();
    if (!key) continue;
    const rawValue = rawValueParts.join("=").trim();
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  }
  return cookies;
};

const getCsrfClientCookieValue = (req: Request): string | null => {
  const cookies = parseCookies(req.headers.cookie);
  const value = cookies[CSRF_CLIENT_COOKIE_NAME];
  if (!value) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) return null;
  return value;
};

const getLegacyClientId = (req: Request): string => {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";
  return `${ip}:${userAgent}`.slice(0, 256);
};

const getCsrfValidationClientIds = (req: Request): string[] => {
  const candidates: string[] = [];
  const cookieValue = getCsrfClientCookieValue(req);
  if (cookieValue) {
    candidates.push(`cookie:${cookieValue}`);
  }
  const legacyClientId = getLegacyClientId(req);
  if (!candidates.includes(legacyClientId)) {
    candidates.push(legacyClientId);
  }
  return candidates;
};

const requireCsrf = (req: Request, res: Response): boolean => {
  const headerName = getCsrfTokenHeader();
  const tokenHeader = req.headers[headerName];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;

  if (!token) {
    res.status(403).json({
      error: "CSRF token missing",
      message: `Missing ${headerName} header`,
    });
    return false;
  }

  const clientIds = getCsrfValidationClientIds(req);
  const isValidToken = clientIds.some((clientId) => validateCsrfToken(clientId, token));
  if (!isValidToken) {
    res.status(403).json({
      error: "CSRF token invalid",
      message: "Invalid or expired CSRF token. Please refresh and try again.",
    });
    return false;
  }

  return true;
};

const countActiveAdmins = async () => {
  return prisma.user.count({
    where: { role: "ADMIN", isActive: true },
  });
};

const generateTokens = (
  userId: string,
  email: string,
  options?: { impersonatorId?: string }
) => {
  const signOptions: SignOptions = {
    expiresIn: config.jwtAccessExpiresIn as StringValue,
  };
  const accessToken = jwt.sign(
    { userId, email, type: "access", impersonatorId: options?.impersonatorId },
    config.jwtSecret,
    signOptions
  );

  const refreshSignOptions: SignOptions = {
    expiresIn: config.jwtRefreshExpiresIn as StringValue,
  };
  const refreshToken = jwt.sign(
    { userId, email, type: "refresh", impersonatorId: options?.impersonatorId },
    config.jwtSecret,
    refreshSignOptions
  );

  return { accessToken, refreshToken };
};

const resolveExpiresAt = (expiresIn: string, fallbackMs: number): Date => {
  const parsed = ms(expiresIn as StringValue);
  const ttlMs = typeof parsed === "number" && parsed > 0 ? parsed : fallbackMs;
  return new Date(Date.now() + ttlMs);
};

const isMissingRefreshTokenTableError = (error: unknown): boolean => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2021") {
      return true;
    }
  }

  const message =
    typeof error === "object" && error && "message" in error
      ? String((error as any).message)
      : "";
  return /no such table:\s*RefreshToken/i.test(message);
};

const getRefreshTokenExpiresAt = (): Date =>
  resolveExpiresAt(config.jwtRefreshExpiresIn, 7 * 24 * 60 * 60 * 1000);

registerCoreRoutes({
  router,
  prisma,
  requireAuth,
  optionalAuth,
  loginAttemptRateLimiter,
  ensureAuthEnabled,
  ensureSystemConfig,
  findUserByIdentifier,
  sanitizeText,
  requireCsrf,
  isJwtPayload,
  config,
  generateTokens,
  getRefreshTokenExpiresAt,
  isMissingRefreshTokenTableError,
  bootstrapUserId: BOOTSTRAP_USER_ID,
  defaultSystemConfigId: DEFAULT_SYSTEM_CONFIG_ID,
});

registerAdminRoutes({
  router,
  prisma,
  requireAuth,
  accountActionRateLimiter,
  ensureAuthEnabled,
  ensureSystemConfig,
  parseLoginRateLimitConfig,
  applyLoginRateLimitConfig,
  resetLoginAttemptKey,
  requireAdmin,
  findUserByIdentifier,
  countActiveAdmins,
  sanitizeText,
  generateTempPassword,
  generateTokens,
  getRefreshTokenExpiresAt,
  config,
  defaultSystemConfigId: DEFAULT_SYSTEM_CONFIG_ID,
});

registerAccountRoutes({
  router,
  prisma,
  requireAuth,
  loginAttemptRateLimiter,
  accountActionRateLimiter,
  ensureAuthEnabled,
  sanitizeText,
  config,
  generateTokens,
  getRefreshTokenExpiresAt,
});

export default router;
