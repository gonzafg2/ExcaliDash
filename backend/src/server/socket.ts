import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { PrismaClient } from "../generated/client";
import { AuthModeService } from "../auth/authMode";
import { ACCESS_TOKEN_COOKIE_NAME, parseCookieHeader } from "../auth/cookies";
import { BOOTSTRAP_USER_ID } from "../auth/authMode";
import {
  SHARE_SESSION_COOKIE_NAME,
  parseShareSessionToken,
  normalizeDrawingPermission,
  getDrawingAccess,
  canEditDrawing,
  canViewDrawing,
  type DrawingPrincipal,
} from "../authz/sharing";

interface User {
  id: string;
  name: string;
  initials: string;
  color: string;
  socketId: string;
  isActive: boolean;
}

type RegisterSocketHandlersDeps = {
  io: Server;
  prisma: PrismaClient;
  authModeService: AuthModeService;
  jwtSecret: string;
};

export const registerSocketHandlers = ({
  io,
  prisma,
  authModeService,
  jwtSecret,
}: RegisterSocketHandlersDeps) => {
  const roomUsers = new Map<string, User[]>();
  const socketPrincipalMap = new Map<string, DrawingPrincipal>();

  const toPresenceName = (value: unknown): string => {
    if (typeof value !== "string") return "User";
    const trimmed = value.trim().slice(0, 120);
    return trimmed.length > 0 ? trimmed : "User";
  };

  const toPresenceInitials = (name: string): string => {
    // Keep consistent with frontend `getInitialsFromName`.
    const trimmed = name.trim();
    if (!trimmed) return "U";
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
    }
    return trimmed.slice(0, 2).toUpperCase();
  };

  const toPresenceColor = (value: unknown): string => {
    if (typeof value !== "string") return "#4f46e5";
    const trimmed = value.trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
      return trimmed;
    }
    return "#4f46e5";
  };

  const getSocketAuthUserId = async (token?: string): Promise<string | null> => {
    const authEnabled = await authModeService.getAuthEnabled();
    if (!authEnabled) {
      return BOOTSTRAP_USER_ID;
    }

    if (!token) return null;

    try {
      const decoded = jwt.verify(token, jwtSecret) as Record<string, unknown>;
      if (
        typeof decoded.userId !== "string" ||
        typeof decoded.email !== "string" ||
        decoded.type !== "access"
      ) {
        return null;
      }

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, isActive: true },
      });

      if (!user || !user.isActive) return null;
      return user.id;
    } catch {
      return null;
    }
  };

  const getSocketSharePrincipal = async (cookieHeader: string | undefined): Promise<DrawingPrincipal | null> => {
    if (!cookieHeader) return null;
    const cookies = parseCookieHeader(cookieHeader);
    const token = cookies[SHARE_SESSION_COOKIE_NAME];
    if (!token || token.trim().length === 0) return null;
    const parsed = parseShareSessionToken(token, jwtSecret);
    if (!parsed) return null;

    const share = await prisma.drawingLinkShare.findUnique({
      where: { id: parsed.shareId },
      select: { id: true, drawingId: true, permission: true, revokedAt: true, expiresAt: true },
    });
    if (!share || share.revokedAt) return null;
    if (share.drawingId !== parsed.drawingId) return null;
    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) return null;
    const permission = normalizeDrawingPermission(share.permission);
    if (!permission || permission !== parsed.permission) return null;

    return { kind: "share", shareId: share.id, drawingId: share.drawingId, permission };
  };

  io.use(async (socket, next) => {
    try {
      const tokenFromAuth = socket.handshake.auth?.token as string | undefined;
      const tokenFromCookie = (() => {
        const cookies = parseCookieHeader(socket.handshake.headers.cookie);
        const value = cookies[ACCESS_TOKEN_COOKIE_NAME];
        return typeof value === "string" && value.trim().length > 0 ? value : undefined;
      })();
      const token = tokenFromAuth || tokenFromCookie;
      const authEnabled = await authModeService.getAuthEnabled();
      const userId = await getSocketAuthUserId(token);

      if (userId) {
        socketPrincipalMap.set(socket.id, { kind: "user", userId });
        return next();
      }

      // Allow unauthenticated share-session principals when auth is enabled.
      if (authEnabled) {
        const sharePrincipal = await getSocketSharePrincipal(socket.handshake.headers.cookie);
        if (sharePrincipal) {
          socketPrincipalMap.set(socket.id, sharePrincipal);
          return next();
        }

        // Google-Docs-style "anyone with the link": allow anonymous sockets and enforce access on join-room
        // using getDrawingAccess (which now consults active link-share policies).
        return next();
      }

      return next(new Error("Authentication required"));
    } catch {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    const principal = socketPrincipalMap.get(socket.id) || null;
    const authorizedDrawingAccess = new Map<string, "view" | "edit" | "owner">();

    socket.on(
      "join-room",
      async (
        {
          drawingId,
          user,
        }: {
          drawingId: string;
          user: Omit<User, "socketId" | "isActive">;
        },
        ack?: (payload: { user: Omit<User, "socketId" | "isActive"> }) => void
      ) => {
        try {
          const access = await getDrawingAccess({
            prisma,
            principal,
            drawingId,
          });
          if (!canViewDrawing(access)) {
            socket.emit("error", { message: "You do not have access to this drawing" });
            return;
          }

          const roomId = `drawing_${drawingId}`;
          socket.join(roomId);
          authorizedDrawingAccess.set(drawingId, access === "owner" ? "owner" : access);

          let trustedUserId =
            typeof user?.id === "string" && user.id.trim().length > 0
              ? user.id.trim().slice(0, 200)
              : socket.id;
          let trustedName = toPresenceName(user?.name);

          if (!principal || principal.kind === "share") {
            // Never trust client-provided ids for anonymous/share-link sessions; prevent spoofing/collisions.
            const prefix = principal?.kind === "share" ? `share:${principal.shareId}` : "anon";
            trustedUserId = `${prefix}:${socket.id}`.slice(0, 200);
          } else if (principal?.kind === "user" && principal.userId !== BOOTSTRAP_USER_ID) {
            const account = await prisma.user.findUnique({
              where: { id: principal.userId },
              select: { id: true, name: true },
            });
            if (account) {
              trustedUserId = account.id;
              trustedName = toPresenceName(account.name);
            }
          }

          const newUser: User = {
            id: trustedUserId,
            name: trustedName,
            initials: toPresenceInitials(trustedName),
            color: toPresenceColor(user?.color),
            socketId: socket.id,
            isActive: true,
          };

          const currentUsers = roomUsers.get(roomId) || [];
          const filteredUsers = currentUsers.filter((u) => u.id !== newUser.id);
          filteredUsers.push(newUser);
          roomUsers.set(roomId, filteredUsers);

          io.to(roomId).emit("presence-update", filteredUsers);
          // Let the client know what the server will use as its canonical presence identity.
          if (typeof ack === "function") {
            ack({
              user: {
                id: newUser.id,
                name: newUser.name,
                initials: newUser.initials,
                color: newUser.color,
              },
            });
          }
        } catch (err) {
          console.error("Error in join-room handler:", err);
          socket.emit("error", { message: "Failed to join room" });
        }
      }
    );

    socket.on("cursor-move", (data) => {
      const drawingId = typeof data?.drawingId === "string" ? data.drawingId : null;
      if (!drawingId || !authorizedDrawingAccess.has(drawingId)) {
        return;
      }
      const roomId = `drawing_${drawingId}`;
      // Don't trust client-provided identity fields; use the server-side presence user.
      const users = roomUsers.get(roomId) || [];
      const self = users.find((u) => u.socketId === socket.id);
      if (!self) return;
      socket.volatile.to(roomId).emit("cursor-move", {
        ...data,
        drawingId,
        userId: self.id,
        username: self.name,
        color: self.color,
      });
    });

    socket.on("element-update", async (data) => {
      const drawingId = typeof data?.drawingId === "string" ? data.drawingId : null;
      if (!drawingId || !authorizedDrawingAccess.has(drawingId)) {
        return;
      }

      // Enforce edit permission for every mutation event.
      // We rely on the access computed during join-room to avoid any mismatch between the
      // socket principal and follow-up DB lookups (and to keep this handler fast).
      const joinedAccess = authorizedDrawingAccess.get(drawingId) ?? "none";
      if (!canEditDrawing(joinedAccess)) {
        socket.emit("error", { message: "Read-only access: cannot edit this drawing" });
        return;
      }

      const roomId = `drawing_${drawingId}`;
      socket.to(roomId).emit("element-update", data);
    });

    socket.on(
      "user-activity",
      ({ drawingId, isActive }: { drawingId: string; isActive: boolean }) => {
        if (!authorizedDrawingAccess.has(drawingId)) {
          return;
        }
        const roomId = `drawing_${drawingId}`;
        const users = roomUsers.get(roomId);
        if (users) {
          const user = users.find((u) => u.socketId === socket.id);
          if (user) {
            user.isActive = isActive;
            io.to(roomId).emit("presence-update", users);
          }
        }
      }
    );

    socket.on("disconnect", () => {
      socketPrincipalMap.delete(socket.id);
      roomUsers.forEach((users, roomId) => {
        const index = users.findIndex((u) => u.socketId === socket.id);
        if (index !== -1) {
          users.splice(index, 1);
          roomUsers.set(roomId, users);
          io.to(roomId).emit("presence-update", users);
        }
      });
    });
  });
};
