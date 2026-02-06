/**
 * Authentication routes for user registration and login
 */
import express, { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import ms, { type StringValue } from "ms";
import { z } from "zod";
import { PrismaClient } from "./generated/client";
import { config } from "./config";
import { requireAuth, optionalAuth } from "./middleware/auth";
import { sanitizeText } from "./security";
import rateLimit, { MemoryStore } from "express-rate-limit";
import { logAuditEvent } from "./utils/audit";
import crypto from "crypto";

interface JwtPayload {
  userId: string;
  email: string;
  type: "access" | "refresh";
  impersonatorId?: string;
}

/**
 * Type guard to check if decoded JWT is our expected payload structure
 */
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

const loginAttemptRateLimiter = async (req: Request, res: Response, next: express.NextFunction) => {
  await ensureLoginAttemptLimiter();
  if (!loginRateLimitConfig.enabled) return next();
  return (loginAttemptLimiter as ReturnType<typeof rateLimit>)(req, res, next);
};

// Rate limiting for authenticated account/admin actions (more lenient)
const accountActionRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 60,
  message: {
    error: "Too many requests",
    message: "Too many requests, please try again later",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Validation schemas
const registerSchema = z.object({
  username: z.string().trim().min(3).max(50).optional(),
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(8).max(100),
  name: z.string().trim().min(1).max(100),
});

const loginSchema = z
  .object({
    identifier: z.string().trim().min(1).max(255).optional(),
    email: z.string().email().toLowerCase().trim().optional(),
    username: z.string().trim().min(1).max(255).optional(),
    password: z.string(),
  })
  .refine((data) => Boolean(data.identifier || data.email || data.username), {
    message: "identifier/email/username is required",
  });

const registrationToggleSchema = z.object({
  enabled: z.boolean(),
});

const adminRoleUpdateSchema = z.object({
  identifier: z.string().trim().min(1).max(255),
  role: z.enum(["ADMIN", "USER"]),
});

const authEnabledToggleSchema = z.object({
  enabled: z.boolean(),
});

const adminCreateUserSchema = z.object({
  username: z.string().trim().min(3).max(50).optional(),
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(8).max(100),
  name: z.string().trim().min(1).max(100),
  role: z.enum(["ADMIN", "USER"]).optional(),
  mustResetPassword: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const adminUpdateUserSchema = z.object({
  username: z.string().trim().min(3).max(50).nullable().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  role: z.enum(["ADMIN", "USER"]).optional(),
  mustResetPassword: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const impersonateSchema = z
  .object({
    userId: z.string().trim().min(1).optional(),
    identifier: z.string().trim().min(1).optional(),
  })
  .refine((data) => Boolean(data.userId || data.identifier), {
    message: "userId/identifier is required",
  });

const loginRateLimitUpdateSchema = z.object({
  enabled: z.boolean(),
  windowMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1000),
  max: z.number().int().min(1).max(10_000),
});

const loginRateLimitResetSchema = z.object({
  identifier: z.string().trim().min(1).max(255),
});

const generateTempPassword = (): string => {
  // 24 chars base64-ish
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

const countActiveAdmins = async () => {
  return prisma.user.count({
    where: { role: "ADMIN", isActive: true },
  });
};

/**
 * Generate JWT tokens (access and refresh)
 * Note: expiresIn accepts string (like "15m", "7d") or number (seconds)
 */
const generateTokens = (
  userId: string,
  email: string,
  options?: { impersonatorId?: string }
) => {
  // jwt.sign accepts StringValue | number for expiresIn
  // Our config provides strings which are compatible with StringValue
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

const getRefreshTokenExpiresAt = (): Date =>
  resolveExpiresAt(config.jwtRefreshExpiresIn, 7 * 24 * 60 * 60 * 1000);

/**
 * POST /auth/register
 * Register a new user
 */
router.post("/register", loginAttemptRateLimiter, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    const parsed = registerSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid registration data",
      });
    }

    const { email, password, name, username } = parsed.data;

    const systemConfig = await ensureSystemConfig();

    const activeUsers = await prisma.user.count({ where: { isActive: true } });
    const bootstrapUser = await prisma.user.findUnique({
      where: { id: BOOTSTRAP_USER_ID },
      select: { id: true, isActive: true },
    });
    const isBootstrapFlow =
      Boolean(bootstrapUser) &&
      bootstrapUser?.isActive === false &&
      activeUsers === 0 &&
      bootstrapUser.id === BOOTSTRAP_USER_ID;

    // Bootstrap flow: first registration activates the bootstrap admin user
    // created during migration and retains ownership of migrated data.
    if (isBootstrapFlow) {
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      const sanitizedName = sanitizeText(name, 100);

      const user = await prisma.user.update({
        where: { id: BOOTSTRAP_USER_ID },
        data: {
          email,
          username: username ?? null,
          passwordHash,
          name: sanitizedName,
          role: "ADMIN",
          mustResetPassword: false,
          isActive: true,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          mustResetPassword: true,
        },
      });

      // Create trash collection if it doesn't exist (shared across all users)
      const existingTrash = await prisma.collection.findUnique({
        where: { id: "trash" },
      });
      if (!existingTrash) {
        await prisma.collection.create({
          data: {
            id: "trash",
            name: "Trash",
            userId: user.id, // Shared, but pick a stable owner
          },
        });
      }

      const { accessToken, refreshToken } = generateTokens(user.id, user.email);

      if (config.enableRefreshTokenRotation) {
        const expiresAt = getRefreshTokenExpiresAt();
        await prisma.refreshToken.create({
          data: { userId: user.id, token: refreshToken, expiresAt },
        });
      }

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: user.id,
          action: "bootstrap_admin",
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
        });
      }

      return res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          mustResetPassword: user.mustResetPassword,
        },
        accessToken,
        refreshToken,
        registrationEnabled: systemConfig.registrationEnabled,
        bootstrapped: true,
      });
    }

    if (!systemConfig.registrationEnabled) {
      return res.status(403).json({
        error: "Forbidden",
        message: "User registration is disabled.",
      });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(409).json({
        error: "Conflict",
        message: "User with this email already exists",
      });
    }

    if (username) {
      const existingUsername = await prisma.user.findFirst({
        where: { username },
        select: { id: true },
      });
      if (existingUsername) {
        return res.status(409).json({
          error: "Conflict",
          message: "User with this username already exists",
        });
      }
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Sanitize name
    const sanitizedName = sanitizeText(name, 100);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: sanitizedName,
        username: username ?? null,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        mustResetPassword: true,
        createdAt: true,
      },
    });

    // Create trash collection if it doesn't exist (shared across all users)
    // Only create if it doesn't exist - don't update if it does
    const existingTrash = await prisma.collection.findUnique({
      where: { id: "trash" },
    });
    if (!existingTrash) {
      await prisma.collection.create({
        data: {
          id: "trash",
          name: "Trash",
          userId: user.id, // Use first user's ID, but collection is shared
        },
      });
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user.id, user.email);

    // Store refresh token in database for rotation tracking (if enabled)
    if (config.enableRefreshTokenRotation) {
      const expiresAt = getRefreshTokenExpiresAt();

      try {
        await prisma.refreshToken.create({
          data: {
            userId: user.id,
            token: refreshToken,
            expiresAt,
          },
        });
      } catch (error) {
        // Gracefully handle missing table (feature disabled)
        if (process.env.NODE_ENV === "development") {
          console.debug("Refresh token storage skipped (feature disabled or table missing)");
        }
      }
    }

    // Log user registration (if audit logging enabled)
    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: user.id,
        action: "user_registered",
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
      });
    }

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        mustResetPassword: user.mustResetPassword,
      },
      accessToken,
      refreshToken,
      registrationEnabled: systemConfig.registrationEnabled,
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to register user",
    });
  }
});

/**
 * POST /auth/login
 * Login with email and password
 */
router.post("/login", loginAttemptRateLimiter, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    const parsed = loginSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid login credentials",
      });
    }

    const identifier =
      parsed.data.email ||
      parsed.data.username ||
      parsed.data.identifier ||
      "";
    const { password } = parsed.data;

    // Block login until bootstrap is completed (so migrated data remains reachable)
    const bootstrapUser = await prisma.user.findUnique({
      where: { id: BOOTSTRAP_USER_ID },
      select: { id: true, isActive: true },
    });
    if (bootstrapUser && bootstrapUser.isActive === false) {
      const activeUsers = await prisma.user.count({ where: { isActive: true } });
      if (activeUsers === 0) {
      return res.status(409).json({
        error: "Bootstrap required",
        message: "Initial admin account has not been configured yet. Register to bootstrap.",
      });
      }
    }

    const user = await findUserByIdentifier(identifier);

    if (!user) {
      // Don't reveal if user exists (prevent user enumeration)
      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid email or password",
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Account is inactive",
      });
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, user.passwordHash);

    if (!passwordValid) {
      // Log failed login attempt (if audit logging enabled)
      if (config.enableAuditLogging) {
        await logAuditEvent({
          action: "login_failed",
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { identifier },
        });
      }

      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid email or password",
      });
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user.id, user.email);

    // Store refresh token in database for rotation tracking (if enabled)
    if (config.enableRefreshTokenRotation) {
      const expiresAt = getRefreshTokenExpiresAt();

      try {
        await prisma.refreshToken.create({
          data: {
            userId: user.id,
            token: refreshToken,
            expiresAt,
          },
        });
      } catch (error) {
        // Gracefully handle missing table (feature disabled)
        if (process.env.NODE_ENV === "development") {
          console.debug("Refresh token rotation skipped (feature disabled or table missing)");
        }
      }
    }

    // Log successful login (if audit logging enabled)
    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: user.id,
        action: "login",
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
      });
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        mustResetPassword: user.mustResetPassword,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to login",
    });
  }
});

/**
 * POST /auth/refresh
 * Refresh access token using refresh token (with rotation)
 */
router.post("/refresh", async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    const { refreshToken: oldRefreshToken } = req.body;

    if (!oldRefreshToken || typeof oldRefreshToken !== "string") {
      return res.status(400).json({
        error: "Bad request",
        message: "Refresh token required",
      });
    }

    try {
      const decoded = jwt.verify(oldRefreshToken, config.jwtSecret);
      
      if (!isJwtPayload(decoded)) {
        return res.status(401).json({
          error: "Unauthorized",
          message: "Invalid token payload",
        });
      }

      if (decoded.type !== "refresh") {
        return res.status(401).json({
          error: "Unauthorized",
          message: "Invalid token type",
        });
      }

      // Verify user still exists and is active
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, email: true, isActive: true },
      });

      if (!user || !user.isActive) {
        return res.status(401).json({
          error: "Unauthorized",
          message: "User account not found or inactive",
        });
      }

      // If refresh token rotation is enabled, check database and rotate
      if (config.enableRefreshTokenRotation) {
        try {
          // Check if refresh token exists in database and is not revoked
          const storedToken = await prisma.refreshToken.findUnique({
            where: { token: oldRefreshToken },
          });

          if (!storedToken || storedToken.revoked || storedToken.userId !== user.id) {
            return res.status(401).json({
              error: "Unauthorized",
              message: "Invalid or revoked refresh token",
            });
          }

          // Check if token has expired
          if (new Date() > storedToken.expiresAt) {
            // Mark as revoked
            await prisma.refreshToken.update({
              where: { id: storedToken.id },
              data: { revoked: true },
            });
            return res.status(401).json({
              error: "Unauthorized",
              message: "Refresh token has expired",
            });
          }

          // Revoke old refresh token
          await prisma.refreshToken.update({
            where: { id: storedToken.id },
            data: { revoked: true },
          });

          // Generate new tokens (rotation)
          const { accessToken, refreshToken: newRefreshToken } = generateTokens(
            user.id,
            user.email,
            { impersonatorId: decoded.impersonatorId }
          );

          // Store new refresh token
          const expiresAt = getRefreshTokenExpiresAt();

          await prisma.refreshToken.create({
            data: {
              userId: user.id,
              token: newRefreshToken,
              expiresAt,
            },
          });

          return res.json({ 
            accessToken,
            refreshToken: newRefreshToken,
          });
        } catch (error) {
          // If table doesn't exist (feature disabled), fall back to old behavior
          if (process.env.NODE_ENV === "development") {
            console.debug("Refresh token rotation skipped (feature disabled or table missing)");
          }
          // Fall through to old behavior below
        }
      }

      // Old behavior: just generate new access token (no rotation)
      const signOptions: SignOptions = {
        expiresIn: config.jwtAccessExpiresIn as StringValue,
      };
      const accessToken = jwt.sign(
        {
          userId: user.id,
          email: user.email,
          type: "access",
          impersonatorId: decoded.impersonatorId,
        },
        config.jwtSecret,
        signOptions
      );

      res.json({ accessToken });
    } catch (error) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid or expired refresh token",
      });
    }
  } catch (error) {
    console.error("Refresh token error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to refresh token",
    });
  }
});

/**
 * GET /auth/me
 * Get current user information
 */
router.get("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User not authenticated",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        role: true,
        mustResetPassword: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        error: "Not found",
        message: "User not found",
      });
    }

    res.json({ user });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to get user information",
    });
  }
});

/**
 * GET /auth/status
 * Lightweight auth + registration status (supports bootstrap UX)
 */
router.get("/status", optionalAuth, async (req: Request, res: Response) => {
  try {
    const systemConfig = await ensureSystemConfig();
    if (!systemConfig.authEnabled) {
      return res.json({
        enabled: false,
        authenticated: false,
        authEnabled: false,
        registrationEnabled: false,
        bootstrapRequired: false,
        user: null,
      });
    }

    const bootstrapUser = await prisma.user.findUnique({
      where: { id: BOOTSTRAP_USER_ID },
      select: { id: true, isActive: true },
    });
    const activeUsers = await prisma.user.count({ where: { isActive: true } });
    const bootstrapRequired =
      Boolean(bootstrapUser && bootstrapUser.isActive === false) && activeUsers === 0;

    res.json({
      enabled: true,
      authEnabled: true,
      authenticated: Boolean(req.user),
      registrationEnabled: systemConfig.registrationEnabled,
      bootstrapRequired,
      user: req.user
        ? {
            id: req.user.id,
            username: req.user.username ?? null,
            email: req.user.email,
            name: req.user.name,
            role: req.user.role,
            mustResetPassword: req.user.mustResetPassword ?? false,
            impersonatorId: req.user.impersonatorId,
          }
        : null,
    });
  } catch (error) {
    console.error("Auth status error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to fetch auth status",
    });
  }
});

/**
 * POST /auth/auth-enabled
 * Enable/disable authentication mode.
 *
 * - Enabling auth is allowed without login (single-user mode).
 * - Disabling auth requires an authenticated ADMIN.
 */
router.post("/auth-enabled", optionalAuth, async (req: Request, res: Response) => {
  try {
    const parsed = authEnabledToggleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Bad request", message: "Invalid toggle payload" });
    }

    const systemConfig = await ensureSystemConfig();
    const current = systemConfig.authEnabled;
    const next = parsed.data.enabled;

    if (current && !next) {
      if (!req.user) {
        return res
          .status(401)
          .json({ error: "Unauthorized", message: "User not authenticated" });
      }
      if (req.user.role !== "ADMIN") {
        return res
          .status(403)
          .json({ error: "Forbidden", message: "Admin access required" });
      }
    }

    // Ensure the bootstrap user exists for the bootstrap registration flow.
    if (!current && next) {
      const bootstrap = await prisma.user.findUnique({
        where: { id: BOOTSTRAP_USER_ID },
        select: { id: true },
      });
      if (!bootstrap) {
        await prisma.user.create({
          data: {
            id: BOOTSTRAP_USER_ID,
            email: "bootstrap@excalidash.local",
            username: null,
            passwordHash: "",
            name: "Bootstrap Admin",
            role: "ADMIN",
            mustResetPassword: true,
            isActive: false,
          },
        });
      }
    }

    const updated = await prisma.systemConfig.upsert({
      where: { id: DEFAULT_SYSTEM_CONFIG_ID },
      update: { authEnabled: next },
      create: {
        id: DEFAULT_SYSTEM_CONFIG_ID,
        authEnabled: next,
        registrationEnabled: systemConfig.registrationEnabled,
      },
    });

    const bootstrapUser = await prisma.user.findUnique({
      where: { id: BOOTSTRAP_USER_ID },
      select: { id: true, isActive: true },
    });
    const activeUsers = await prisma.user.count({ where: { isActive: true } });
    const bootstrapRequired =
      Boolean(updated.authEnabled && bootstrapUser && bootstrapUser.isActive === false) &&
      activeUsers === 0;

    res.json({ authEnabled: updated.authEnabled, bootstrapRequired });
  } catch (error) {
    console.error("Auth enabled toggle error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to update authentication mode",
    });
  }
});

/**
 * POST /auth/registration/toggle
 * Enable/disable registration (admin-only)
 */
router.post("/registration/toggle", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!requireAdmin(req, res)) return;

    const parsed = registrationToggleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Bad request", message: "Invalid toggle payload" });
    }

    const updated = await prisma.systemConfig.upsert({
      where: { id: DEFAULT_SYSTEM_CONFIG_ID },
      update: { registrationEnabled: parsed.data.enabled },
      create: { id: DEFAULT_SYSTEM_CONFIG_ID, registrationEnabled: parsed.data.enabled },
    });

    res.json({ registrationEnabled: updated.registrationEnabled });
  } catch (error) {
    console.error("Registration toggle error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to update registration setting",
    });
  }
});

/**
 * POST /auth/admins
 * Promote/demote a user (admin-only)
 */
router.post("/admins", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!requireAdmin(req, res)) return;

    const parsed = adminRoleUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Bad request", message: "Invalid admin update payload" });
    }

    const target = await findUserByIdentifier(parsed.data.identifier);
    if (!target) {
      return res.status(404).json({ error: "Not found", message: "User not found" });
    }

    if (target.id === req.user.id && parsed.data.role !== "ADMIN") {
      return res.status(409).json({
        error: "Conflict",
        message: "You cannot change your own role from ADMIN",
      });
    }

    if (target.role === "ADMIN" && parsed.data.role !== "ADMIN" && target.isActive) {
      const admins = await countActiveAdmins();
      if (admins <= 1) {
        return res.status(409).json({
          error: "Conflict",
          message: "There must be at least one active admin",
        });
      }
    }

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { role: parsed.data.role },
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        role: true,
        mustResetPassword: true,
        isActive: true,
      },
    });

    res.json({ user: updated });
  } catch (error) {
    console.error("Admin role update error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to update user role",
    });
  }
});

/**
 * GET /auth/users
 * List users (admin-only)
 */
router.get("/users", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!requireAdmin(req, res)) return;

    const users = await prisma.user.findMany({
      orderBy: [{ createdAt: "asc" }],
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        role: true,
        mustResetPassword: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({ users });
  } catch (error) {
    console.error("List users error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to list users",
    });
  }
});

/**
 * GET /auth/rate-limit/login
 * Get login rate limit config (admin-only)
 */
router.get("/rate-limit/login", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!requireAdmin(req, res)) return;

    const systemConfig = await ensureSystemConfig();
    const cfg = parseLoginRateLimitConfig(systemConfig);
    res.json({ config: cfg });
  } catch (error) {
    console.error("Get login rate limit config error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to fetch login rate limit config",
    });
  }
});

/**
 * PUT /auth/rate-limit/login
 * Update login rate limit config (admin-only)
 */
router.put("/rate-limit/login", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!requireAdmin(req, res)) return;

    const parsed = loginRateLimitUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid rate limit config",
      });
    }

    const updated = await prisma.systemConfig.update({
      where: { id: DEFAULT_SYSTEM_CONFIG_ID },
      data: {
        authLoginRateLimitEnabled: parsed.data.enabled,
        authLoginRateLimitWindowMs: parsed.data.windowMs,
        authLoginRateLimitMax: parsed.data.max,
      },
    });

    loginRateLimitConfig = parseLoginRateLimitConfig(updated);
    buildLoginAttemptLimiter(loginRateLimitConfig);

    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: req.user.id,
        action: "admin_login_rate_limit_updated",
        resource: "system_config",
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
        details: { ...loginRateLimitConfig },
      });
    }

    res.json({ config: loginRateLimitConfig });
  } catch (error) {
    console.error("Update login rate limit config error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to update login rate limit config",
    });
  }
});

/**
 * POST /auth/rate-limit/login/reset
 * Reset login rate limit for an identifier (admin-only)
 */
router.post("/rate-limit/login/reset", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!requireAdmin(req, res)) return;

    const parsed = loginRateLimitResetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid reset payload",
      });
    }

    await ensureLoginAttemptLimiter();

    const identifier = parsed.data.identifier.trim().toLowerCase();
    const key = `login:${identifier}`;

    try {
      await loginAttemptLimiter?.resetKey(key);
    } catch (error) {
      // Best-effort; store may not support resetKey
      if (process.env.NODE_ENV === "development") {
        console.debug("Rate limit reset skipped:", error);
      }
    }

    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: req.user.id,
        action: "admin_login_rate_limit_reset",
        resource: `rate_limit:${key}`,
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
        details: { identifier },
      });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Reset login rate limit error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to reset login rate limit",
    });
  }
});

/**
 * POST /auth/users
 * Create user (admin-only)
 */
router.post("/users", requireAuth, accountActionRateLimiter, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!requireAdmin(req, res)) return;

    const parsed = adminCreateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid user payload",
      });
    }

    const { email, password, name, username, role, mustResetPassword, isActive } = parsed.data;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({
        error: "Conflict",
        message: "User with this email already exists",
      });
    }

    if (username) {
      const existingUsername = await prisma.user.findFirst({
        where: { username },
        select: { id: true },
      });
      if (existingUsername) {
        return res.status(409).json({
          error: "Conflict",
          message: "User with this username already exists",
        });
      }
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const sanitizedName = sanitizeText(name, 100);

    const user = await prisma.user.create({
      data: {
        email,
        username: username ?? null,
        passwordHash,
        name: sanitizedName,
        role: role ?? "USER",
        mustResetPassword: mustResetPassword ?? false,
        isActive: isActive ?? true,
      },
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        role: true,
        mustResetPassword: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: req.user.id,
        action: "admin_user_created",
        resource: `user:${user.id}`,
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
        details: { createdUserId: user.id },
      });
    }

    res.status(201).json({ user });
  } catch (error) {
    console.error("Create user error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to create user",
    });
  }
});

/**
 * PATCH /auth/users/:id
 * Update user (admin-only)
 */
router.patch("/users/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!requireAdmin(req, res)) return;

    const userId = String(req.params.id || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "Bad request", message: "Invalid user id" });
    }

    const parsed = adminUpdateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Bad request", message: "Invalid update payload" });
    }

    // Prevent admin locking themselves out accidentally.
    if (userId === req.user.id && parsed.data.isActive === false) {
      return res.status(409).json({
        error: "Conflict",
        message: "You cannot deactivate your own account",
      });
    }

    if (userId === req.user.id && parsed.data.role && parsed.data.role !== "ADMIN") {
      return res.status(409).json({
        error: "Conflict",
        message: "You cannot change your own role from ADMIN",
      });
    }

    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, isActive: true },
    });

    if (!current) {
      return res.status(404).json({ error: "Not found", message: "User not found" });
    }

    const nextRole = typeof parsed.data.role === "undefined" ? current.role : parsed.data.role;
    const nextActive =
      typeof parsed.data.isActive === "undefined" ? current.isActive : parsed.data.isActive;

    const removingAdmin =
      current.role === "ADMIN" &&
      current.isActive &&
      (nextRole !== "ADMIN" || nextActive === false);

    if (removingAdmin) {
      const admins = await countActiveAdmins();
      if (admins <= 1) {
        return res.status(409).json({
          error: "Conflict",
          message: "There must be at least one active admin",
        });
      }
    }

    const data: Record<string, unknown> = {};
    if (typeof parsed.data.username !== "undefined") data.username = parsed.data.username;
    if (typeof parsed.data.name !== "undefined") data.name = sanitizeText(parsed.data.name, 100);
    if (typeof parsed.data.role !== "undefined") data.role = parsed.data.role;
    if (typeof parsed.data.mustResetPassword !== "undefined")
      data.mustResetPassword = parsed.data.mustResetPassword;
    if (typeof parsed.data.isActive !== "undefined") data.isActive = parsed.data.isActive;

    const updated = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        role: true,
        mustResetPassword: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: req.user.id,
        action: "admin_user_updated",
        resource: `user:${updated.id}`,
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
        details: { updatedUserId: updated.id, fields: Object.keys(data) },
      });
    }

    res.json({ user: updated });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to update user",
    });
  }
});

/**
 * POST /auth/users/:id/reset-password
 * Generate a temporary password for a user (admin-only).
 * The user will be forced to set a new password on next sign-in.
 */
router.post("/users/:id/reset-password", requireAuth, accountActionRateLimiter, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!requireAdmin(req, res)) return;

    // Avoid foot-guns while impersonating (admin actions should be from the real admin session).
    if (req.user.impersonatorId) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Password resets are not allowed while impersonating",
      });
    }

    const userId = String(req.params.id || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "Bad request", message: "Invalid user id" });
    }

    if (userId === req.user.id) {
      return res.status(409).json({
        error: "Conflict",
        message: "Use Profile → Change Password for your own account",
      });
    }

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        isActive: true,
      },
    });

    if (!target) {
      return res.status(404).json({ error: "Not found", message: "User not found" });
    }

    const tempPassword = generateTempPassword();
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(tempPassword, saltRounds);

    await prisma.user.update({
      where: { id: target.id },
      data: {
        passwordHash,
        mustResetPassword: true,
        isActive: true,
      },
    });

    // Revoke refresh tokens (best-effort) to force re-login and/or block existing sessions.
    try {
      await prisma.refreshToken.updateMany({
        where: { userId: target.id, revoked: false },
        data: { revoked: true },
      });
    } catch (error) {
      if (process.env.NODE_ENV === "development") {
        console.debug("Refresh token revocation skipped (feature disabled or table missing)");
      }
    }

    // Reset login rate limit for this identifier (best-effort).
    try {
      await ensureLoginAttemptLimiter();
      const key = `login:${target.email.toLowerCase()}`;
      await loginAttemptLimiter?.resetKey(key);
    } catch (error) {
      if (process.env.NODE_ENV === "development") {
        console.debug("Rate limit reset skipped:", error);
      }
    }

    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: req.user.id,
        action: "admin_password_reset_generated",
        resource: `user:${target.id}`,
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
        details: { targetUserId: target.id, targetEmail: target.email },
      });
    }

    res.json({
      user: { id: target.id, email: target.email, username: target.username, role: target.role },
      tempPassword,
    });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to reset password",
    });
  }
});

/**
 * POST /auth/impersonate
 * Generate tokens for another user (admin-only)
 */
router.post("/impersonate", requireAuth, accountActionRateLimiter, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!requireAdmin(req, res)) return;

    const parsed = impersonateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Bad request", message: "Invalid impersonation payload" });
    }

    const target =
      parsed.data.userId
        ? await prisma.user.findUnique({ where: { id: parsed.data.userId } })
        : await findUserByIdentifier(parsed.data.identifier || "");

    if (!target) {
      return res.status(404).json({ error: "Not found", message: "User not found" });
    }

    if (!target.isActive) {
      return res.status(403).json({ error: "Forbidden", message: "Target user is inactive" });
    }

    const { accessToken, refreshToken } = generateTokens(target.id, target.email, {
      impersonatorId: req.user.id,
    });

    if (config.enableRefreshTokenRotation) {
      const expiresAt = getRefreshTokenExpiresAt();
      try {
        await prisma.refreshToken.create({
          data: { userId: target.id, token: refreshToken, expiresAt },
        });
      } catch (error) {
        if (process.env.NODE_ENV === "development") {
          console.debug("Refresh token storage skipped (feature disabled or table missing)");
        }
      }
    }

    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: req.user.id,
        action: "impersonation_started",
        resource: `user:${target.id}`,
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
        details: { targetUserId: target.id },
      });
    }

    res.json({
      user: {
        id: target.id,
        username: target.username ?? null,
        email: target.email,
        name: target.name,
        role: target.role,
        mustResetPassword: target.mustResetPassword,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error("Impersonation error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to impersonate user",
    });
  }
});

/**
 * POST /auth/password-reset-request
 * Request a password reset (sends reset token via email)
 * Only available if ENABLE_PASSWORD_RESET=true
 */
const passwordResetRequestSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

router.post("/password-reset-request", loginAttemptRateLimiter, async (req: Request, res: Response) => {
  if (!(await ensureAuthEnabled(res))) return;
  // Check if password reset feature is enabled
  if (!config.enablePasswordReset) {
    return res.status(404).json({
      error: "Not found",
      message: "Password reset feature is not enabled",
    });
  }
  try {
    const parsed = passwordResetRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid email address",
      });
    }

    const { email } = parsed.data;

    // Find user (don't reveal if user exists to prevent enumeration)
    const user = await prisma.user.findUnique({
      where: { email },
    });

    // Always return success to prevent user enumeration
    // In production, you would send an email here
    if (user && user.isActive) {
      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 1); // Token expires in 1 hour

      // Invalidate any existing reset tokens for this user
      await prisma.passwordResetToken.updateMany({
        where: { userId: user.id, used: false },
        data: { used: true },
      });

      // Create new reset token
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          token: resetToken,
          expiresAt,
        },
      });

      // Log password reset request (if audit logging enabled)
      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: user.id,
          action: "password_reset_requested",
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
        });
      }

      // In production, send email with reset link
      // For now, we'll return the token in development (remove in production!)
      if (config.nodeEnv === "development") {
        console.log(`[DEV] Password reset token for ${email}: ${resetToken}`);
        const baseUrlRaw = config.frontendUrl?.split(",")[0]?.trim();
        const baseUrlWithProtocol = baseUrlRaw
          ? /^https?:\/\//i.test(baseUrlRaw)
            ? baseUrlRaw
            : `http://${baseUrlRaw}`
          : "http://localhost:6767";
        const baseUrl = baseUrlWithProtocol.replace(/\/$/, "");
        console.log(`[DEV] Reset URL: ${baseUrl}/reset-password?token=${resetToken}`);
      }
    }

    // Always return success message (security best practice)
    res.json({
      message: "If an account with that email exists, a password reset link has been sent.",
    });
  } catch (error) {
    console.error("Password reset request error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to process password reset request",
    });
  }
});

/**
 * POST /auth/password-reset-confirm
 * Confirm password reset with token
 * Only available if ENABLE_PASSWORD_RESET=true
 */
const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(100),
});

router.post("/password-reset-confirm", loginAttemptRateLimiter, async (req: Request, res: Response) => {
  if (!(await ensureAuthEnabled(res))) return;
  // Check if password reset feature is enabled
  if (!config.enablePasswordReset) {
    return res.status(404).json({
      error: "Not found",
      message: "Password reset feature is not enabled",
    });
  }
  try {
    const parsed = passwordResetConfirmSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid reset data",
      });
    }

    const { token, password } = parsed.data;

    // Find reset token
    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!resetToken || resetToken.used) {
      return res.status(400).json({
        error: "Invalid token",
        message: "Password reset token is invalid or has already been used",
      });
    }

    if (new Date() > resetToken.expiresAt) {
      return res.status(400).json({
        error: "Expired token",
        message: "Password reset token has expired",
      });
    }

    if (!resetToken.user.isActive) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Account is inactive",
      });
    }

    // Hash new password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Update user password
    await prisma.user.update({
      where: { id: resetToken.userId },
      data: { passwordHash, mustResetPassword: false },
    });

    // Mark reset token as used
    await prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { used: true },
    });

    // Revoke all refresh tokens for this user (force re-login) - if rotation enabled
    if (config.enableRefreshTokenRotation) {
      try {
        await prisma.refreshToken.updateMany({
          where: { userId: resetToken.userId, revoked: false },
          data: { revoked: true },
        });
      } catch (error) {
        // Gracefully handle missing table
        if (process.env.NODE_ENV === "development") {
          console.debug("Refresh token revocation skipped (feature disabled or table missing)");
        }
      }
    }

    // Log password change (if audit logging enabled)
    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: resetToken.userId,
        action: "password_changed",
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
      });
    }

    res.json({
      message: "Password has been reset successfully",
    });
  } catch (error) {
    console.error("Password reset confirm error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to reset password",
    });
  }
});

/**
 * PUT /auth/profile
 * Update user profile (name)
 */
const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

router.put("/profile", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User not authenticated",
      });
    }
    if (req.user.impersonatorId) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Profile updates are not allowed while impersonating",
      });
    }

    const parsed = updateProfileSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid name format",
      });
    }

    const { name } = parsed.data;
    const sanitizedName = sanitizeText(name, 100);

    // Update user name
    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: { name: sanitizedName },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Log profile update (if audit logging enabled)
    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: req.user.id,
        action: "profile_updated",
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
        details: { field: "name" },
      });
    }

    res.json({ user: updatedUser });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to update profile",
    });
  }
});

/**
 * PUT /auth/email
 * Change email (requires current password)
 */
const updateEmailSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  currentPassword: z.string().min(1).max(100),
});

router.put("/email", requireAuth, accountActionRateLimiter, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User not authenticated",
      });
    }
    if (req.user.impersonatorId) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Email changes are not allowed while impersonating",
      });
    }

    const parsed = updateEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid email update data",
      });
    }

    const newEmail = parsed.data.email;

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User account not found or inactive",
      });
    }

    if (!user.passwordHash) {
      return res.status(400).json({
        error: "Bad request",
        message: "Cannot change email for this account",
      });
    }

    const passwordValid = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
    if (!passwordValid) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Current password is incorrect",
      });
    }

    if (newEmail !== user.email) {
      const existingUser = await prisma.user.findUnique({
        where: { email: newEmail },
        select: { id: true },
      });

      if (existingUser && existingUser.id !== user.id) {
        return res.status(409).json({
          error: "Conflict",
          message: "User with this email already exists",
        });
      }
    }

    const previousEmail = user.email;

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { email: newEmail },
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        role: true,
        mustResetPassword: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Revoke all refresh tokens for this user (force re-login) - if rotation enabled
    if (config.enableRefreshTokenRotation) {
      try {
        await prisma.refreshToken.updateMany({
          where: { userId: updatedUser.id, revoked: false },
          data: { revoked: true },
        });
      } catch (error) {
        if (process.env.NODE_ENV === "development") {
          console.debug("Refresh token revocation skipped (feature disabled or table missing)");
        }
      }
    }

    const { accessToken, refreshToken } = generateTokens(updatedUser.id, updatedUser.email);

    if (config.enableRefreshTokenRotation) {
      const expiresAt = getRefreshTokenExpiresAt();
      try {
        await prisma.refreshToken.create({
          data: { userId: updatedUser.id, token: refreshToken, expiresAt },
        });
      } catch (error) {
        if (process.env.NODE_ENV === "development") {
          console.debug("Refresh token storage skipped (feature disabled or table missing)");
        }
      }
    }

    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: updatedUser.id,
        action: "email_updated",
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
        details: { previousEmail, newEmail: updatedUser.email },
      });
    }

    res.json({
      user: updatedUser,
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error("Update email error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to update email",
    });
  }
});

/**
 * POST /auth/change-password
 * Change password (requires current password)
 */
const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8).max(100),
});

router.post("/change-password", requireAuth, accountActionRateLimiter, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User not authenticated",
      });
    }
    if (req.user.impersonatorId) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Password changes are not allowed while impersonating",
      });
    }

    const parsed = changePasswordSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid password data",
      });
    }

    const { currentPassword, newPassword } = parsed.data;

    // Get user with password hash
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, passwordHash: true, isActive: true },
    });

    if (!user || !user.isActive) {
      return res.status(404).json({
        error: "Not found",
        message: "User not found",
      });
    }

    // Verify current password
    const passwordValid = await bcrypt.compare(currentPassword, user.passwordHash);

    if (!passwordValid) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Current password is incorrect",
      });
    }

    // Hash new password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustResetPassword: false },
    });

    // Revoke all refresh tokens for this user (force re-login) - if rotation enabled
    if (config.enableRefreshTokenRotation) {
      try {
        await prisma.refreshToken.updateMany({
          where: { userId: user.id, revoked: false },
          data: { revoked: true },
        });
      } catch (error) {
        // Gracefully handle missing table
        if (process.env.NODE_ENV === "development") {
          console.debug("Refresh token revocation skipped (feature disabled or table missing)");
        }
      }
    }

    // Log password change (if audit logging enabled)
    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: user.id,
        action: "password_changed",
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
        details: { method: "change_password" },
      });
    }

    res.json({
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to change password",
    });
  }
});

/**
 * POST /auth/must-reset-password
 * Complete a forced password reset (only when mustResetPassword=true)
 */
const mustResetPasswordSchema = z.object({
  newPassword: z.string().min(8).max(100),
});

router.post("/must-reset-password", requireAuth, accountActionRateLimiter, async (req: Request, res: Response) => {
  try {
    if (!(await ensureAuthEnabled(res))) return;
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User not authenticated",
      });
    }
    if (req.user.impersonatorId) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Password changes are not allowed while impersonating",
      });
    }

    const parsed = mustResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid password data",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, isActive: true, mustResetPassword: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User account not found or inactive",
      });
    }

    if (!user.mustResetPassword) {
      return res.status(409).json({
        error: "Conflict",
        message: "Password reset is not required for this account",
      });
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(parsed.data.newPassword, saltRounds);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustResetPassword: false },
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        role: true,
        mustResetPassword: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Revoke all refresh tokens for this user (force old sessions to re-auth) - if rotation enabled
    if (config.enableRefreshTokenRotation) {
      try {
        await prisma.refreshToken.updateMany({
          where: { userId: updatedUser.id, revoked: false },
          data: { revoked: true },
        });
      } catch (error) {
        if (process.env.NODE_ENV === "development") {
          console.debug("Refresh token revocation skipped (feature disabled or table missing)");
        }
      }
    }

    const { accessToken, refreshToken } = generateTokens(updatedUser.id, updatedUser.email);

    if (config.enableRefreshTokenRotation) {
      const expiresAt = getRefreshTokenExpiresAt();
      try {
        await prisma.refreshToken.create({
          data: { userId: updatedUser.id, token: refreshToken, expiresAt },
        });
      } catch (error) {
        if (process.env.NODE_ENV === "development") {
          console.debug("Refresh token storage skipped (feature disabled or table missing)");
        }
      }
    }

    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: updatedUser.id,
        action: "password_reset_required_completed",
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
      });
    }

    res.json({
      user: updatedUser,
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error("Must reset password error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to reset password",
    });
  }
});

export default router;
