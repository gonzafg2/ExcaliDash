/**
 * Authentication middleware for protecting routes
 */
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { PrismaClient } from "../generated/client";

const prisma = new PrismaClient();
const DEFAULT_SYSTEM_CONFIG_ID = "default";
const BOOTSTRAP_USER_ID = "bootstrap-admin";

type AuthEnabledCache = {
  value: boolean;
  fetchedAt: number;
};

let authEnabledCache: AuthEnabledCache | null = null;
const AUTH_ENABLED_TTL_MS = 0;

const getAuthEnabled = async (): Promise<boolean> => {
  const now = Date.now();
  if (authEnabledCache && now - authEnabledCache.fetchedAt < AUTH_ENABLED_TTL_MS) {
    return authEnabledCache.value;
  }

  const systemConfig = await prisma.systemConfig.upsert({
    where: { id: DEFAULT_SYSTEM_CONFIG_ID },
    update: {},
    create: {
      id: DEFAULT_SYSTEM_CONFIG_ID,
      authEnabled: false,
      registrationEnabled: false,
    },
    select: { authEnabled: true },
  });

  authEnabledCache = { value: systemConfig.authEnabled, fetchedAt: now };
  return systemConfig.authEnabled;
};

const getBootstrapActingUser = async () => {
  const user = await prisma.user.findUnique({
    where: { id: BOOTSTRAP_USER_ID },
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

  if (user) return user;

  return prisma.user.create({
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
};

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username?: string | null;
        email: string;
        name: string;
        role: string;
        mustResetPassword?: boolean;
        impersonatorId?: string;
      };
    }
  }
}

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
  const impersonatorOk =
    typeof payload.impersonatorId === "undefined" || typeof payload.impersonatorId === "string";
  return (
    typeof payload.userId === "string" &&
    typeof payload.email === "string" &&
    (payload.type === "access" || payload.type === "refresh") &&
    impersonatorOk
  );
};

/**
 * Extract JWT token from Authorization header
 */
const extractToken = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== "string") return null;

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return null;
  }

  return parts[1];
};

/**
 * Verify and decode JWT token
 */
const verifyToken = (token: string): JwtPayload | null => {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (!isJwtPayload(decoded)) {
      return null;
    }
    if (decoded.type !== "access") {
      return null; // Only accept access tokens in middleware
    }
    return decoded;
  } catch {
    return null;
  }
};

const normalizeRequestPath = (req: Request): string => {
  const raw = (req.originalUrl || req.url || "").split("?")[0] || "";
  // In some deployments the backend may see a /api prefix.
  return raw.replace(/^\/api(?=\/)/, "");
};

const isAllowedWhileMustResetPassword = (req: Request): boolean => {
  const path = normalizeRequestPath(req);

  // Permit fetching current user and changing password.
  if (req.method === "GET" && path === "/auth/me") return true;
  if (req.method === "POST" && path === "/auth/change-password") return true;
  if (req.method === "POST" && path === "/auth/must-reset-password") return true;

  return false;
};

/**
 * Require authentication middleware
 * Protects routes that require a valid JWT token
 */
export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // Single-user mode: authentication disabled -> treat all requests as the bootstrap user.
  try {
    const authEnabled = await getAuthEnabled();
    if (!authEnabled) {
      const user = await getBootstrapActingUser();
      req.user = {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        role: user.role,
        mustResetPassword: user.mustResetPassword,
      };
      return next();
    }
  } catch (error) {
    console.error("Error reading auth mode:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to read authentication mode",
    });
    return;
  }

  const token = extractToken(req);

  if (!token) {
    res.status(401).json({
      error: "Unauthorized",
      message: "Authentication token required",
    });
    return;
  }

  const payload = verifyToken(token);

  if (!payload) {
    res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired token",
    });
    return;
  }

  // Verify user still exists and is active
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
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

    if (!user || !user.isActive) {
      res.status(401).json({
        error: "Unauthorized",
        message: "User account not found or inactive",
      });
      return;
    }

    if (user.mustResetPassword && !isAllowedWhileMustResetPassword(req)) {
      res.status(403).json({
        error: "Forbidden",
        code: "MUST_RESET_PASSWORD",
        message: "You must reset your password before using the app",
      });
      return;
    }

    // Attach user to request
    req.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
      mustResetPassword: user.mustResetPassword,
      impersonatorId: payload.impersonatorId,
    };

    next();
  } catch (error) {
    console.error("Error verifying user:", error);
    res.status(500).json({
      error: "Internal server error",
      message: "Failed to verify user",
    });
  }
};

/**
 * Optional authentication middleware
 * Attaches user to request if token is present, but doesn't require it
 */
export const optionalAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authEnabled = await getAuthEnabled();
    if (!authEnabled) {
      return next();
    }
  } catch (error) {
    console.error("Error reading auth mode:", error);
    return next();
  }

  const token = extractToken(req);

  if (!token) {
    return next();
  }

  const payload = verifyToken(token);

  if (!payload) {
    return next();
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
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

    if (user && user.isActive) {
      req.user = {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        role: user.role,
        mustResetPassword: user.mustResetPassword,
        impersonatorId: payload.impersonatorId,
      };
    }
  } catch (error) {
    // Silently fail for optional auth
    console.error("Error in optional auth:", error);
  }

  next();
};
