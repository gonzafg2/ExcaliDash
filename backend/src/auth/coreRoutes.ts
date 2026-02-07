import express, { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { PrismaClient } from "../generated/client";
import { StringValue } from "ms";
import { logAuditEvent } from "../utils/audit";
import {
  authEnabledToggleSchema,
  loginSchema,
  registerSchema,
} from "./schemas";
import { getTokenLookupCandidates, hashTokenForStorage } from "./tokenSecurity";

type RegisterCoreRoutesDeps = {
  router: express.Router;
  prisma: PrismaClient;
  requireAuth: express.RequestHandler;
  optionalAuth: express.RequestHandler;
  loginAttemptRateLimiter: express.RequestHandler;
  ensureAuthEnabled: (res: Response) => Promise<boolean>;
  ensureSystemConfig: () => Promise<{
    id: string;
    authEnabled: boolean;
    registrationEnabled: boolean;
  }>;
  findUserByIdentifier: (identifier: string) => Promise<{
    id: string;
    username: string | null;
    email: string;
    passwordHash: string;
    name: string;
    role: string;
    isActive: boolean;
    mustResetPassword: boolean;
  } | null>;
  sanitizeText: (input: unknown, maxLength?: number) => string;
  requireCsrf: (req: Request, res: Response) => boolean;
  isJwtPayload: (decoded: unknown) => decoded is {
    userId: string;
    email: string;
    type: "access" | "refresh";
    impersonatorId?: string;
  };
  config: {
    jwtSecret: string;
    jwtAccessExpiresIn: string;
    enableRefreshTokenRotation: boolean;
    enableAuditLogging: boolean;
  };
  generateTokens: (
    userId: string,
    email: string,
    options?: { impersonatorId?: string }
  ) => { accessToken: string; refreshToken: string };
  getRefreshTokenExpiresAt: () => Date;
  isMissingRefreshTokenTableError: (error: unknown) => boolean;
  bootstrapUserId: string;
  defaultSystemConfigId: string;
};

class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const registerCoreRoutes = (deps: RegisterCoreRoutesDeps) => {
  const {
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
    bootstrapUserId,
    defaultSystemConfigId,
  } = deps;
  const getUserTrashCollectionId = (userId: string): string => `trash:${userId}`;

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
        where: { id: bootstrapUserId },
        select: { id: true, isActive: true },
      });
      const isBootstrapFlow =
        Boolean(bootstrapUser) &&
        bootstrapUser?.isActive === false &&
        activeUsers === 0 &&
        bootstrapUser.id === bootstrapUserId;

      if (isBootstrapFlow) {
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const sanitizedName = sanitizeText(name, 100);

        const user = await prisma.user.update({
          where: { id: bootstrapUserId },
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

        const trashCollectionId = getUserTrashCollectionId(user.id);
        const existingTrash = await prisma.collection.findFirst({
          where: { id: trashCollectionId, userId: user.id },
        });
        if (!existingTrash) {
          await prisma.collection.create({
            data: {
              id: trashCollectionId,
              name: "Trash",
              userId: user.id,
            },
          });
        }

        const { accessToken, refreshToken } = generateTokens(user.id, user.email);

        if (config.enableRefreshTokenRotation) {
          const expiresAt = getRefreshTokenExpiresAt();
          await prisma.refreshToken.create({
            data: { userId: user.id, token: hashTokenForStorage(refreshToken), expiresAt },
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

      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      const sanitizedName = sanitizeText(name, 100);

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

      const trashCollectionId = getUserTrashCollectionId(user.id);
      const existingTrash = await prisma.collection.findFirst({
        where: { id: trashCollectionId, userId: user.id },
      });
      if (!existingTrash) {
        await prisma.collection.create({
          data: {
            id: trashCollectionId,
            name: "Trash",
            userId: user.id,
          },
        });
      }

      const { accessToken, refreshToken } = generateTokens(user.id, user.email);

      if (config.enableRefreshTokenRotation) {
        const expiresAt = getRefreshTokenExpiresAt();

        try {
          await prisma.refreshToken.create({
            data: {
              userId: user.id,
              token: hashTokenForStorage(refreshToken),
              expiresAt,
            },
          });
        } catch {
          if (process.env.NODE_ENV === "development") {
            console.debug("Refresh token storage skipped (feature disabled or table missing)");
          }
        }
      }

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

      const identifier = parsed.data.email || parsed.data.username || parsed.data.identifier || "";
      const { password } = parsed.data;

      const bootstrapUser = await prisma.user.findUnique({
        where: { id: bootstrapUserId },
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

      const passwordValid = await bcrypt.compare(password, user.passwordHash);

      if (!passwordValid) {
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

      const { accessToken, refreshToken } = generateTokens(user.id, user.email);

      if (config.enableRefreshTokenRotation) {
        const expiresAt = getRefreshTokenExpiresAt();

        try {
          await prisma.refreshToken.create({
            data: {
              userId: user.id,
              token: hashTokenForStorage(refreshToken),
              expiresAt,
            },
          });
        } catch {
          if (process.env.NODE_ENV === "development") {
            console.debug("Refresh token rotation skipped (feature disabled or table missing)");
          }
        }
      }

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

        if (config.enableRefreshTokenRotation) {
          try {
            const { accessToken, refreshToken: newRefreshToken } = generateTokens(
              user.id,
              user.email,
              { impersonatorId: decoded.impersonatorId }
            );

            const expiresAt = getRefreshTokenExpiresAt();

            await prisma.$transaction(async (tx) => {
              const storedToken = await tx.refreshToken.findFirst({
                where: {
                  OR: getTokenLookupCandidates(oldRefreshToken).map((candidate) => ({
                    token: candidate,
                  })),
                },
              });

              if (!storedToken || storedToken.userId !== user.id || storedToken.revoked) {
                throw new HttpError(401, "Invalid or revoked refresh token");
              }

              if (new Date() > storedToken.expiresAt) {
                throw new HttpError(401, "Refresh token has expired");
              }

              const revoked = await tx.refreshToken.updateMany({
                where: { id: storedToken.id, revoked: false },
                data: { revoked: true },
              });
              if (revoked.count !== 1) {
                throw new HttpError(401, "Invalid or revoked refresh token");
              }

              await tx.refreshToken.create({
                data: {
                  userId: user.id,
                  token: hashTokenForStorage(newRefreshToken),
                  expiresAt,
                },
              });
            });

            return res.json({
              accessToken,
              refreshToken: newRefreshToken,
            });
          } catch (error) {
            if (error instanceof HttpError) {
              return res.status(error.statusCode).json({
                error: "Unauthorized",
                message: error.message,
              });
            }

            if (isMissingRefreshTokenTableError(error)) {
              if (process.env.NODE_ENV === "development") {
                console.debug("Refresh token rotation skipped (feature disabled or table missing)");
              }
            } else {
              console.error("Refresh token rotation error:", error);
              return res.status(500).json({
                error: "Internal server error",
                message: "Failed to rotate refresh token",
              });
            }
          }
        }

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
      } catch {
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
        where: { id: bootstrapUserId },
        select: { id: true, isActive: true },
      });
      const activeUsers = await prisma.user.count({ where: { isActive: true } });
      const bootstrapRequired = Boolean(bootstrapUser && bootstrapUser.isActive === false) && activeUsers === 0;

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

  router.post("/auth-enabled", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!requireCsrf(req, res)) return;
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

      const parsed = authEnabledToggleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Bad request", message: "Invalid toggle payload" });
      }

      const systemConfig = await ensureSystemConfig();
      const current = systemConfig.authEnabled;
      const next = parsed.data.enabled;

      if (!current && next) {
        const bootstrap = await prisma.user.findUnique({
          where: { id: bootstrapUserId },
          select: { id: true },
        });
        if (!bootstrap) {
          await prisma.user.create({
            data: {
              id: bootstrapUserId,
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
        where: { id: defaultSystemConfigId },
        update: { authEnabled: next },
        create: {
          id: defaultSystemConfigId,
          authEnabled: next,
          registrationEnabled: systemConfig.registrationEnabled,
        },
      });

      const bootstrapUser = await prisma.user.findUnique({
        where: { id: bootstrapUserId },
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
};
