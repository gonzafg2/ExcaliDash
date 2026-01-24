/**
 * Authentication routes for user registration and login
 */
import express, { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import type { StringValue } from "ms";
import { z } from "zod";
import { PrismaClient } from "./generated/client";
import { config } from "./config";
import { requireAuth } from "./middleware/auth";
import { sanitizeText } from "./security";
import rateLimit from "express-rate-limit";
import { logAuditEvent } from "./utils/audit";
import crypto from "crypto";

interface JwtPayload {
  userId: string;
  email: string;
  type: "access" | "refresh";
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

// Rate limiting for auth endpoints (stricter than general rate limiting)
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window
  message: {
    error: "Too many requests",
    message: "Too many authentication attempts, please try again later",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Validation schemas
const registerSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(8).max(100),
  name: z.string().trim().min(1).max(100),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string(),
});

/**
 * Generate JWT tokens (access and refresh)
 * Note: expiresIn accepts string (like "15m", "7d") or number (seconds)
 */
const generateTokens = (userId: string, email: string) => {
  // jwt.sign accepts StringValue | number for expiresIn
  // Our config provides strings which are compatible with StringValue
  const signOptions: SignOptions = {
    expiresIn: config.jwtAccessExpiresIn as StringValue,
  };
  const accessToken = jwt.sign(
    { userId, email, type: "access" },
    config.jwtSecret,
    signOptions
  );

  const refreshSignOptions: SignOptions = {
    expiresIn: config.jwtRefreshExpiresIn as StringValue,
  };
  const refreshToken = jwt.sign(
    { userId, email, type: "refresh" },
    config.jwtSecret,
    refreshSignOptions
  );

  return { accessToken, refreshToken };
};

/**
 * POST /auth/register
 * Register a new user
 */
router.post("/register", authRateLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid registration data",
      });
    }

    const { email, password, name } = parsed.data;

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
      },
      select: {
        id: true,
        email: true,
        name: true,
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
      const expiresAt = new Date();
      expiresAt.setTime(expiresAt.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

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
      },
      accessToken,
      refreshToken,
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
router.post("/login", authRateLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Invalid login credentials",
      });
    }

    const { email, password } = parsed.data;

    // Find user
    const user = await prisma.user.findUnique({
      where: { email },
    });

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
          details: { email },
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
      const expiresAt = new Date();
      expiresAt.setTime(expiresAt.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

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
          const { accessToken, refreshToken: newRefreshToken } = generateTokens(user.id, user.email);

          // Store new refresh token
          const expiresAt = new Date();
          expiresAt.setTime(expiresAt.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

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
        { userId: user.id, email: user.email, type: "access" },
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
        email: true,
        name: true,
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
 * POST /auth/password-reset-request
 * Request a password reset (sends reset token via email)
 * Only available if ENABLE_PASSWORD_RESET=true
 */
const passwordResetRequestSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

router.post("/password-reset-request", authRateLimiter, async (req: Request, res: Response) => {
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
        console.log(`[DEV] Reset URL: ${config.frontendUrl}/reset-password?token=${resetToken}`);
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

router.post("/password-reset-confirm", authRateLimiter, async (req: Request, res: Response) => {
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
      data: { passwordHash },
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
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User not authenticated",
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
 * POST /auth/change-password
 * Change password (requires current password)
 */
const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8).max(100),
});

router.post("/change-password", requireAuth, authRateLimiter, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User not authenticated",
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
      data: { passwordHash },
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

export default router;