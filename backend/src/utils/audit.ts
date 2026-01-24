/**
 * Audit logging utility for security events
 */
import { PrismaClient } from "../generated/client";

const prisma = new PrismaClient();

export interface AuditLogData {
  userId?: string;
  action: string;
  resource?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
}

/**
 * Log a security event to the audit log
 * This should be called for important security-related actions
 * Gracefully handles missing audit log table (feature disabled)
 */
export const logAuditEvent = async (data: AuditLogData): Promise<void> => {
  try {
    // Check if audit logging is enabled via config
    const { config } = await import("../config");
    if (!config.enableAuditLogging) {
      return; // Feature disabled, silently skip
    }

    await prisma.auditLog.create({
      data: {
        userId: data.userId || null,
        action: data.action,
        resource: data.resource || null,
        ipAddress: data.ipAddress || null,
        userAgent: data.userAgent || null,
        details: data.details ? JSON.stringify(data.details) : null,
      },
    });
  } catch (error) {
    // Don't fail the request if audit logging fails
    // This handles cases where the table doesn't exist (feature disabled)
    // or other database errors
    if (process.env.NODE_ENV === "development") {
      console.debug("Audit logging skipped (feature disabled or table missing):", error);
    }
  }
};

/**
 * Get audit logs for a user (or all users if userId is not provided)
 * Returns empty array if audit logging is disabled or table doesn't exist
 */
export const getAuditLogs = async (
  userId?: string,
  limit: number = 100
): Promise<unknown[]> => {
  try {
    // Check if audit logging is enabled via config
    const { config } = await import("../config");
    if (!config.enableAuditLogging) {
      return []; // Feature disabled, return empty array
    }

    const logs = await prisma.auditLog.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    return logs.map((log) => ({
      ...log,
      details: log.details ? JSON.parse(log.details) : null,
    }));
  } catch (error) {
    // Gracefully handle missing table or other errors
    if (process.env.NODE_ENV === "development") {
      console.debug("Failed to retrieve audit logs (feature disabled or table missing):", error);
    }
    return [];
  }
};
