import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { promises as fsPromises } from "fs";
import { createServer } from "http";
import { Server } from "socket.io";
import { Worker } from "worker_threads";
import multer from "multer";
import archiver from "archiver";
import JSZip from "jszip";
import { z } from "zod";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import { PrismaClient, Prisma } from "./generated/client";
import {
  sanitizeDrawingData,
  validateImportedDrawing,
  sanitizeText,
  sanitizeSvg,
  elementSchema,
  appStateSchema,
  createCsrfToken,
  validateCsrfToken,
  getCsrfTokenHeader,
  getOriginFromReferer,
} from "./security";
import { config } from "./config";
import { requireAuth } from "./middleware/auth";
import { errorHandler, asyncHandler } from "./middleware/errorHandler";
import authRouter from "./auth";
import { logAuditEvent } from "./utils/audit";

const backendRoot = path.resolve(__dirname, "../");
console.log("Resolved DATABASE_URL:", process.env.DATABASE_URL);

const normalizeOrigins = (rawOrigins?: string | null): string[] => {
  const fallback = "http://localhost:6767";
  if (!rawOrigins || rawOrigins.trim().length === 0) {
    return [fallback];
  }

  const ensureProtocol = (origin: string) =>
    /^https?:\/\//i.test(origin) ? origin : `http://${origin}`;

  const removeTrailingSlash = (origin: string) =>
    origin.endsWith("/") ? origin.slice(0, -1) : origin;

  const parsed = rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map(ensureProtocol)
    .map(removeTrailingSlash);

  return parsed.length > 0 ? parsed : [fallback];
};

const allowedOrigins = normalizeOrigins(config.frontendUrl);
console.log("Allowed origins:", allowedOrigins);

const isDev = (process.env.NODE_ENV || "development") !== "production";
const isLocalDevOrigin = (origin: string): boolean => {
  // Allow any localhost/127.0.0.1 port in dev (Vite often picks a free port).
  return (
    /^http:\/\/localhost:\d+$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1:\d+$/i.test(origin)
  );
};

const isAllowedOrigin = (origin?: string): boolean => {
  if (!origin) return true; // non-browser clients / same-origin
  if (allowedOrigins.includes(origin)) return true;
  if (isDev && isLocalDevOrigin(origin)) return true;
  return false;
};

const uploadDir = path.resolve(__dirname, "../uploads");

let cachedBackendVersion: string | null = null;
const getBackendVersion = (): string => {
  if (cachedBackendVersion) return cachedBackendVersion;
  try {
    const raw = fs.readFileSync(path.resolve(backendRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    cachedBackendVersion = typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    cachedBackendVersion = "unknown";
  }
  return cachedBackendVersion;
};

const sanitizePathSegment = (input: string, fallback: string): string => {
  const value = typeof input === "string" ? input.trim() : "";
  const cleaned = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
};

const makeUniqueName = (base: string, used: Set<string>): string => {
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}__${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
};

const initializeUploadDir = async () => {
  try {
    await fsPromises.mkdir(uploadDir, { recursive: true });
  } catch (error) {
    console.error("Failed to create upload directory:", error);
  }
};

const app = express();

// Trust proxy headers (X-Forwarded-For, X-Real-IP) from nginx
// Required for correct client IP detection when running behind a reverse proxy
// Fix for issue #38: Use 'true' to handle multiple proxy layers (e.g., Traefik, Synology NAS)
// This ensures Express extracts the real client IP from the leftmost X-Forwarded-For value
const trustProxyConfig = process.env.TRUST_PROXY || "true";
const trustProxyValue = trustProxyConfig === "true"
  ? true
  : trustProxyConfig === "false"
  ? false
  : parseInt(trustProxyConfig, 10) || 1;
app.set("trust proxy", trustProxyValue);

if (trustProxyValue === true) {
  console.log("[config] trust proxy: enabled (handles multiple proxy layers)");
} else {
  console.log(`[config] trust proxy: ${trustProxyValue}`);
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin ?? undefined)),
    credentials: true,
  },
  maxHttpBufferSize: 1e8,
});
const prisma = new PrismaClient();
const parseJsonField = <T>(
  rawValue: string | null | undefined,
  fallback: T
): T => {
  if (!rawValue) return fallback;
  try {
    return JSON.parse(rawValue) as T;
  } catch (error) {
    console.warn("Failed to parse JSON field", {
      error,
      valuePreview: rawValue.slice(0, 50),
    });
    return fallback;
  }
};

const DRAWINGS_CACHE_TTL_MS = (() => {
  const parsed = Number(process.env.DRAWINGS_CACHE_TTL_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 5_000;
  }
  return parsed;
})();
type DrawingsCacheEntry = { body: Buffer; expiresAt: number };
const drawingsCache = new Map<string, DrawingsCacheEntry>();

const buildDrawingsCacheKey = (keyParts: {
  searchTerm: string;
  collectionFilter: string;
  includeData: boolean;
}) =>
  JSON.stringify([
    keyParts.searchTerm,
    keyParts.collectionFilter,
    keyParts.includeData ? "full" : "summary",
  ]);

const getCachedDrawingsBody = (key: string): Buffer | null => {
  const entry = drawingsCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    drawingsCache.delete(key);
    return null;
  }
  return entry.body;
};

const cacheDrawingsResponse = (key: string, payload: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(payload));
  drawingsCache.set(key, {
    body,
    expiresAt: Date.now() + DRAWINGS_CACHE_TTL_MS,
  });
  return body;
};

const invalidateDrawingsCache = () => {
  drawingsCache.clear();
};

/**
 * Ensure trash collection exists (shared across all users)
 * This is needed because Prisma enforces foreign key constraints
 * The trash collection is shared - drawings are still filtered by userId
 */
const ensureTrashCollection = async (userId: string): Promise<void> => {
  const trashCollection = await prisma.collection.findUnique({
    where: { id: "trash" },
  });
  
  if (!trashCollection) {
    // Create trash collection (use first user's ID, but it's shared)
    await prisma.collection.create({
      data: {
        id: "trash",
        name: "Trash",
        userId, // Use current user's ID, but collection is shared
      },
    });
  }
  // If it already exists, don't update it - it's shared
};

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of drawingsCache.entries()) {
    if (now > entry.expiresAt) {
      drawingsCache.delete(key);
    }
  }
}, 60_000).unref();

const PORT = config.port;

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "db") {
      const isSqliteDb =
        file.originalname.endsWith(".db") ||
        file.originalname.endsWith(".sqlite");
      if (!isSqliteDb) {
        return cb(new Error("Only .db or .sqlite files are allowed"));
      }
    }
    cb(null, true);
  },
});

// Request ID middleware (must be early in the chain)
app.use((req, res, next) => {
  const requestId = uuidv4();
  req.headers["x-request-id"] = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
});

// HTTPS enforcement in production
if (config.nodeEnv === "production") {
  app.use((req, res, next) => {
    if (req.header("x-forwarded-proto") !== "https") {
      res.redirect(`https://${req.header("host")}${req.url}`);
    } else {
      next();
    }
  });
}

// Helmet security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'", // Required for Excalidraw
          "'unsafe-eval'", // Required for Excalidraw
          "https://cdn.jsdelivr.net",
          "https://unpkg.com",
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'", // Required for Excalidraw
          "https://fonts.googleapis.com",
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
  })
);

app.use(
  cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin ?? undefined)),
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-csrf-token"],
    exposedHeaders: ["x-csrf-token", "x-request-id"],
  })
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Request logging middleware
app.use((req, res, next) => {
  const requestId = req.headers["x-request-id"] || "unknown";
  const contentLength = req.headers["content-length"];
  const userEmail = req.user?.email || "anonymous";
  
  if (contentLength) {
    const sizeInMB = parseInt(contentLength, 10) / 1024 / 1024;
    if (sizeInMB > 10) {
      console.log(
        `[LARGE REQUEST] ${req.method} ${req.path} - ${sizeInMB.toFixed(
          2
        )}MB - User: ${userEmail} - RequestID: ${requestId}`
      );
    }
  }
  
  console.log(
    `[REQUEST] ${req.method} ${req.path} - User: ${userEmail} - IP: ${req.ip} - RequestID: ${requestId}`
  );
  
  next();
});

const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of requestCounts.entries()) {
    if (now > data.resetTime) {
      requestCounts.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

// General rate limiting with express-rate-limit
const generalRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: config.rateLimitMaxRequests,
  message: {
    error: "Rate limit exceeded",
    message: "Too many requests, please try again later",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalRateLimiter);

// CSRF Protection Middleware
// Generates a unique client ID based on IP and User-Agent for token association
const getClientId = (req: express.Request): string => {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";
  const clientId = `${ip}:${userAgent}`.slice(0, 256);

  // Debug logging for CSRF troubleshooting (issue #38)
  if (process.env.DEBUG_CSRF === "true") {
    console.log("[CSRF DEBUG] getClientId", {
      method: req.method,
      path: req.path,
      ip,
      remoteAddress: req.connection.remoteAddress,
      "x-forwarded-for": req.headers["x-forwarded-for"],
      "x-real-ip": req.headers["x-real-ip"],
      userAgent: userAgent.slice(0, 100),
      clientIdPreview: clientId.slice(0, 60) + "...",
      trustProxySetting: req.app.get("trust proxy"),
    });
  }

  return clientId;
};

// Rate limiter specifically for CSRF token generation to prevent store exhaustion
const csrfRateLimit = new Map<string, { count: number; resetTime: number }>();
const CSRF_RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const CSRF_MAX_REQUESTS = (() => {
  const parsed = Number(process.env.CSRF_MAX_REQUESTS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 60; // 1 per second average
  }
  return parsed;
})();

// CSRF token endpoint - clients should call this to get a token
app.get("/csrf-token", (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const now = Date.now();
  const clientLimit = csrfRateLimit.get(ip);

  if (clientLimit && now < clientLimit.resetTime) {
    if (clientLimit.count >= CSRF_MAX_REQUESTS) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        message: "Too many CSRF token requests",
      });
    }
    clientLimit.count++;
  } else {
    csrfRateLimit.set(ip, { count: 1, resetTime: now + CSRF_RATE_LIMIT_WINDOW });
  }

  // Cleanup old rate limit entries occasionally
  if (Math.random() < 0.01) {
    for (const [key, data] of csrfRateLimit.entries()) {
      if (now > data.resetTime) csrfRateLimit.delete(key);
    }
  }

  const clientId = getClientId(req);
  const token = createCsrfToken(clientId);

  res.json({
    token,
    header: getCsrfTokenHeader()
  });
});

// CSRF validation middleware for state-changing requests
const csrfProtectionMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  // Skip CSRF validation for safe methods (GET, HEAD, OPTIONS)
  // Note: /csrf-token is a GET endpoint, so it's automatically exempt
  const safeMethods = ["GET", "HEAD", "OPTIONS"];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Origin/Referer check for defense in depth
  const origin = req.headers["origin"];
  const referer = req.headers["referer"];

  // If Origin is present, it must match allowed origins
  const originValue = Array.isArray(origin) ? origin[0] : origin;
  const refererValue = Array.isArray(referer) ? referer[0] : referer;

  if (originValue) {
    if (!isAllowedOrigin(originValue)) {
      return res.status(403).json({
        error: "CSRF origin mismatch",
        message: "Origin not allowed",
      });
    }
  } else if (refererValue) {
    // If no Origin but Referer exists, validate its *origin* (avoid prefix bypass)
    const refererOrigin = getOriginFromReferer(refererValue);
    if (!refererOrigin || !isAllowedOrigin(refererOrigin)) {
      return res.status(403).json({
        error: "CSRF referer mismatch",
        message: "Referer not allowed",
      });
    }
  }
  // Note: If neither Origin nor Referer is present, we proceed to token check.
  // Some legitimate clients/proxies might strip these, so we don't block strictly on their absence,
  // but relying on the token is the primary defense.

  const clientId = getClientId(req);
  const headerName = getCsrfTokenHeader();
  const tokenHeader = req.headers[headerName];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;

  if (!token) {
    return res.status(403).json({
      error: "CSRF token missing",
      message: `Missing ${headerName} header`,
    });
  }

  if (!validateCsrfToken(clientId, token)) {
    return res.status(403).json({
      error: "CSRF token invalid",
      message: "Invalid or expired CSRF token. Please refresh and try again.",
    });
  }

  next();
};

// Apply CSRF protection to all routes (except auth endpoints)
app.use((req, res, next) => {
  // Skip CSRF for auth endpoints
  if (req.path.startsWith("/auth/")) {
    return next();
  }
  csrfProtectionMiddleware(req, res, next);
});

// Authentication routes (no CSRF required, uses JWT)
app.use("/auth", authRouter);

// Files field can contain arbitrary file metadata, so we use unknown and validate structure
const filesFieldSchema = z
  .union([z.record(z.string(), z.unknown()), z.null()])
  .optional()
  .transform((value) => (value === null ? undefined : value));

const drawingBaseSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  collectionId: z.union([z.string().trim().min(1), z.null()]).optional(),
  preview: z.string().nullable().optional(),
});

const drawingCreateSchema = drawingBaseSchema
  .extend({
    elements: elementSchema.array().default([]),
    appState: appStateSchema.default({}),
    files: filesFieldSchema,
  })
  .refine(
    (data) => {
      try {
        const sanitized = sanitizeDrawingData(data);
        Object.assign(data, sanitized);
        return true;
      } catch (error) {
        console.error("Sanitization failed:", error);
        return false;
      }
    },
    {
      message: "Invalid or malicious drawing data detected",
    }
  );

const drawingUpdateSchema = drawingBaseSchema
  .extend({
    elements: elementSchema.array().optional(),
    appState: appStateSchema.optional(),
    files: filesFieldSchema,
  })
  .refine(
    (data) => {
      try {
        const sanitizedData = { ...data };
        if (data.elements !== undefined || data.appState !== undefined) {
          const fullData = {
            elements: Array.isArray(data.elements) ? data.elements : [],
            appState:
              typeof data.appState === "object" && data.appState !== null
                ? data.appState
                : {},
            files: data.files || {},
            preview: data.preview,
            name: data.name,
            collectionId: data.collectionId,
          };
          const sanitized = sanitizeDrawingData(fullData);
          sanitizedData.elements = sanitized.elements;
          sanitizedData.appState = sanitized.appState;
          if (data.files !== undefined) sanitizedData.files = sanitized.files;
          if (data.preview !== undefined)
            sanitizedData.preview = sanitized.preview;
          Object.assign(data, sanitizedData);
        }
        return true;
      } catch (error) {
        console.error("Sanitization failed:", error);
        if (
          data.elements === undefined &&
          data.appState === undefined &&
          (data.name !== undefined ||
            data.preview !== undefined ||
            data.collectionId !== undefined)
        ) {
          return true;
        }
        return false;
      }
    },
    {
      message: "Invalid or malicious drawing data detected",
    }
  );

const respondWithValidationErrors = (
  res: express.Response,
  issues: z.ZodIssue[]
) => {
  // In production, don't expose validation details
  if (config.nodeEnv === "production") {
    res.status(400).json({
      error: "Validation error",
      message: "Invalid request data",
    });
  } else {
    res.status(400).json({
      error: "Invalid drawing payload",
      details: issues,
    });
  }
};

// Collection name validation schema
const collectionNameSchema = z.string().trim().min(1).max(100);

const validateSqliteHeader = (filePath: string): boolean => {
  try {
    const buffer = Buffer.alloc(16);
    const fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);

    if (bytesRead < 16) {
      console.warn("File too small to be a valid SQLite database");
      return false;
    }

    const expectedHeader = Buffer.from([
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61,
      0x74, 0x20, 0x33, 0x00,
    ]);

    const isValid = buffer.equals(expectedHeader);
    if (!isValid) {
      console.warn("Invalid SQLite file header detected", {
        filePath,
        header: buffer.toString("hex"),
        expected: expectedHeader.toString("hex"),
      });
    }

    return isValid;
  } catch (error) {
    console.error("Failed to validate SQLite header:", error);
    return false;
  }
};
const verifyDatabaseIntegrityAsync = (filePath: string): Promise<boolean> => {
  if (!validateSqliteHeader(filePath)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const worker = new Worker(
      path.resolve(__dirname, "./workers/db-verify.js"),
      {
        workerData: { filePath },
      }
    );
    let timeoutHandle: NodeJS.Timeout;
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    worker.on("message", (isValid: boolean) => finish(isValid));
    worker.on("error", (err) => {
      console.error("Worker error:", err);
      finish(false);
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        finish(false);
      }
    });

    timeoutHandle = setTimeout(() => {
      console.warn("Integrity check worker timed out", { filePath });
      worker.terminate();
      finish(false);
    }, 10000);
  });
};

const removeFileIfExists = async (filePath?: string) => {
  if (!filePath) return;
  try {
    await fsPromises.access(filePath).catch(() => {
      return;
    });
    await fsPromises.unlink(filePath);
  } catch (error) {
    console.error("Failed to remove file", { filePath, error });
  }
};

interface User {
  id: string;
  name: string;
  initials: string;
  color: string;
  socketId: string;
  isActive: boolean;
}

const roomUsers = new Map<string, User[]>();

io.on("connection", (socket) => {
  socket.on(
    "join-room",
    ({
      drawingId,
      user,
    }: {
      drawingId: string;
      user: Omit<User, "socketId" | "isActive">;
    }) => {
      const roomId = `drawing_${drawingId}`;
      socket.join(roomId);

      const newUser: User = { ...user, socketId: socket.id, isActive: true };

      const currentUsers = roomUsers.get(roomId) || [];
      const filteredUsers = currentUsers.filter((u) => u.id !== user.id);
      filteredUsers.push(newUser);
      roomUsers.set(roomId, filteredUsers);

      io.to(roomId).emit("presence-update", filteredUsers);
    }
  );

  socket.on("cursor-move", (data) => {
    const roomId = `drawing_${data.drawingId}`;
    socket.volatile.to(roomId).emit("cursor-move", data);
  });

  socket.on("element-update", (data) => {
    const roomId = `drawing_${data.drawingId}`;
    socket.to(roomId).emit("element-update", data);
  });

  socket.on(
    "user-activity",
    ({ drawingId, isActive }: { drawingId: string; isActive: boolean }) => {
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

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Health check endpoint doesn't require auth

app.get("/drawings", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { search, collectionId, includeData } = req.query;
  const where: Prisma.DrawingWhereInput = {
    userId: req.user.id, // Filter by user
  };
  const searchTerm =
    typeof search === "string" && search.trim().length > 0
      ? search.trim()
      : undefined;

  if (searchTerm) {
    where.name = { contains: searchTerm };
  }

  let collectionFilterKey = "default";
  if (collectionId === "null") {
    where.collectionId = null;
    collectionFilterKey = "null";
  } else if (collectionId) {
    const normalizedCollectionId = String(collectionId);
    // Special handling for trash collection
    if (normalizedCollectionId === "trash") {
      where.collectionId = "trash";
      collectionFilterKey = "trash";
    } else {
      // Verify collection belongs to user
      const collection = await prisma.collection.findFirst({
        where: {
          id: normalizedCollectionId,
          userId: req.user.id,
        },
      });
      if (!collection) {
        return res.status(404).json({ error: "Collection not found" });
      }
      where.collectionId = normalizedCollectionId;
      collectionFilterKey = `id:${normalizedCollectionId}`;
    }
  } else {
    where.OR = [{ collectionId: { not: "trash" } }, { collectionId: null }];
  }

    const shouldIncludeData =
      typeof includeData === "string"
        ? includeData.toLowerCase() === "true" || includeData === "1"
        : false;

    const cacheKey = buildDrawingsCacheKey({
      searchTerm: searchTerm ?? "",
      collectionFilter: collectionFilterKey,
      includeData: shouldIncludeData,
    });

    const cachedBody = getCachedDrawingsBody(cacheKey);
    if (cachedBody) {
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Content-Type", "application/json");
      return res.send(cachedBody);
    }

    const summarySelect: Prisma.DrawingSelect = {
      id: true,
      name: true,
      collectionId: true,
      preview: true,
      version: true,
      createdAt: true,
      updatedAt: true,
    };

    const queryOptions: Prisma.DrawingFindManyArgs = {
      where,
      orderBy: { updatedAt: "desc" },
    };

    if (!shouldIncludeData) {
      queryOptions.select = summarySelect;
    }

    const drawings = await prisma.drawing.findMany(queryOptions);

    type DrawingResponse = Prisma.DrawingGetPayload<typeof queryOptions>;
    type DrawingWithParsedData = Omit<DrawingResponse, "elements" | "appState" | "files"> & {
      elements: unknown[];
      appState: Record<string, unknown>;
      files: Record<string, unknown>;
    };

    let responsePayload: DrawingResponse[] | DrawingWithParsedData[] = drawings;

    if (shouldIncludeData) {
      responsePayload = drawings.map((d): DrawingWithParsedData => ({
        ...d,
        elements: parseJsonField(d.elements, []),
        appState: parseJsonField(d.appState, {}),
        files: parseJsonField(d.files, {}),
      }));
    }

    const body = cacheDrawingsResponse(cacheKey, responsePayload);
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Content-Type", "application/json");
    return res.send(body);
}));

app.get("/drawings/:id", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { id } = req.params;
  console.log("[API] Fetching drawing", { id, userId: req.user.id });
  const drawing = await prisma.drawing.findFirst({
    where: {
      id,
      userId: req.user.id, // Ensure user owns the drawing
    },
  });

  if (!drawing) {
    console.warn("[API] Drawing not found", { id, userId: req.user.id });
    return res.status(404).json({ error: "Drawing not found" });
  }

  res.json({
    ...drawing,
    elements: JSON.parse(drawing.elements),
    appState: JSON.parse(drawing.appState),
    files: JSON.parse(drawing.files || "{}"),
  });
}));

app.post("/drawings", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const isImportedDrawing = req.headers["x-imported-file"] === "true";

  if (isImportedDrawing && !validateImportedDrawing(req.body)) {
    return res.status(400).json({
      error: "Invalid imported drawing file",
      message:
        "The imported file contains potentially malicious content or invalid structure",
    });
  }

  const parsed = drawingCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return respondWithValidationErrors(res, parsed.error.issues);
  }

  const payload = parsed.data;
  const drawingName = payload.name ?? "Untitled Drawing";
  let targetCollectionId =
    payload.collectionId === undefined ? null : payload.collectionId;

  // Verify collection belongs to user if provided (except for special "trash" collection)
  if (targetCollectionId && targetCollectionId !== "trash") {
    const collection = await prisma.collection.findFirst({
      where: {
        id: targetCollectionId,
        userId: req.user.id,
      },
    });
    if (!collection) {
      return res.status(404).json({ error: "Collection not found" });
    }
  } else if (targetCollectionId === "trash") {
    // Ensure trash collection exists for this user
    await ensureTrashCollection(req.user.id);
  }

  const newDrawing = await prisma.drawing.create({
    data: {
      name: drawingName,
      elements: JSON.stringify(payload.elements),
      appState: JSON.stringify(payload.appState),
      userId: req.user.id,
      collectionId: targetCollectionId,
      preview: payload.preview ?? null,
      files: JSON.stringify(payload.files ?? {}),
    },
  });
  invalidateDrawingsCache();

  res.json({
    ...newDrawing,
    elements: JSON.parse(newDrawing.elements),
    appState: JSON.parse(newDrawing.appState),
    files: JSON.parse(newDrawing.files || "{}"),
  });
}));

app.put("/drawings/:id", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { id } = req.params;

  // Verify drawing belongs to user
  const existingDrawing = await prisma.drawing.findFirst({
    where: {
      id,
      userId: req.user.id,
    },
  });

  if (!existingDrawing) {
    return res.status(404).json({ error: "Drawing not found" });
  }

  const parsed = drawingUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    if (config.nodeEnv === "development") {
      console.error("[API] Validation failed", {
        id,
        errorCount: parsed.error.issues.length,
        errors: parsed.error.issues,
      });
    }
    return respondWithValidationErrors(res, parsed.error.issues);
  }

  const payload = parsed.data;

  const data: Prisma.DrawingUpdateInput = {
    version: { increment: 1 },
  };

  if (payload.name !== undefined) data.name = payload.name;
  if (payload.elements !== undefined)
    data.elements = JSON.stringify(payload.elements);
  if (payload.appState !== undefined)
    data.appState = JSON.stringify(payload.appState);
  if (payload.files !== undefined) data.files = JSON.stringify(payload.files);
    if (payload.collectionId !== undefined) {
      // Special handling for trash collection - ensure it exists first
      if (payload.collectionId === "trash") {
        await ensureTrashCollection(req.user.id);
        (data as Prisma.DrawingUncheckedUpdateInput).collectionId = "trash";
      } else if (payload.collectionId) {
        // Verify collection belongs to user if provided
        const collection = await prisma.collection.findFirst({
          where: {
            id: payload.collectionId,
            userId: req.user.id,
          },
        });
        if (!collection) {
          return res.status(404).json({ error: "Collection not found" });
        }
        (data as Prisma.DrawingUncheckedUpdateInput).collectionId = payload.collectionId;
      } else {
        // null collectionId (Unorganized)
        (data as Prisma.DrawingUncheckedUpdateInput).collectionId = null;
      }
    }
  if (payload.preview !== undefined) data.preview = payload.preview;

  const updatedDrawing = await prisma.drawing.update({
    where: { id },
    data,
  });
  invalidateDrawingsCache();

  res.json({
    ...updatedDrawing,
    elements: JSON.parse(updatedDrawing.elements),
    appState: JSON.parse(updatedDrawing.appState),
    files: JSON.parse(updatedDrawing.files || "{}"),
  });
}));

app.delete("/drawings/:id", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { id } = req.params;
  
  // Verify drawing belongs to user
  const drawing = await prisma.drawing.findFirst({
    where: {
      id,
      userId: req.user.id,
    },
  });

  if (!drawing) {
    return res.status(404).json({ error: "Drawing not found" });
  }

  await prisma.drawing.delete({ where: { id } });
  invalidateDrawingsCache();

  // Log deletion (if audit logging enabled)
  if (config.enableAuditLogging) {
    await logAuditEvent({
      userId: req.user.id,
      action: "drawing_deleted",
      resource: `drawing:${id}`,
      ipAddress: req.ip || req.connection.remoteAddress || undefined,
      userAgent: req.headers["user-agent"] || undefined,
      details: { drawingId: id, drawingName: drawing.name },
    });
  }

  res.json({ success: true });
}));

app.post("/drawings/:id/duplicate", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { id } = req.params;
  const original = await prisma.drawing.findFirst({
    where: {
      id,
      userId: req.user.id,
    },
  });

  if (!original) {
    return res.status(404).json({ error: "Original drawing not found" });
  }

  const newDrawing = await prisma.drawing.create({
    data: {
      name: `${original.name} (Copy)`,
      elements: original.elements,
      appState: original.appState,
      files: original.files,
      userId: req.user.id,
      collectionId: original.collectionId,
      version: 1,
    },
  });
  invalidateDrawingsCache();

  res.json({
    ...newDrawing,
    elements: JSON.parse(newDrawing.elements),
    appState: JSON.parse(newDrawing.appState),
    files: JSON.parse(newDrawing.files || "{}"),
  });
}));

app.get("/collections", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const collections = await prisma.collection.findMany({
    where: {
      userId: req.user.id,
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(collections);
}));

app.post("/collections", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const parsed = collectionNameSchema.safeParse(req.body.name);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation error",
      message: "Collection name must be between 1 and 100 characters",
    });
  }

  const sanitizedName = sanitizeText(parsed.data, 100);
  const newCollection = await prisma.collection.create({
    data: {
      name: sanitizedName,
      userId: req.user.id,
    },
  });
  res.json(newCollection);
}));

app.put("/collections/:id", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { id } = req.params;
  
  // Verify collection belongs to user
  const existingCollection = await prisma.collection.findFirst({
    where: {
      id,
      userId: req.user.id,
    },
  });

  if (!existingCollection) {
    return res.status(404).json({ error: "Collection not found" });
  }

  const parsed = collectionNameSchema.safeParse(req.body.name);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation error",
      message: "Collection name must be between 1 and 100 characters",
    });
  }

  const sanitizedName = sanitizeText(parsed.data, 100);
  const updatedCollection = await prisma.collection.update({
    where: { id },
    data: { name: sanitizedName },
  });
  res.json(updatedCollection);
}));

app.delete("/collections/:id", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { id } = req.params;
  
  // Verify collection belongs to user
  const collection = await prisma.collection.findFirst({
    where: {
      id,
      userId: req.user.id,
    },
  });

  if (!collection) {
    return res.status(404).json({ error: "Collection not found" });
  }

  await prisma.$transaction([
    prisma.drawing.updateMany({
      where: { collectionId: id, userId: req.user.id },
      data: { collectionId: null },
    }),
    prisma.collection.delete({
      where: { id },
    }),
  ]);
  invalidateDrawingsCache();

  // Log collection deletion (if audit logging enabled)
  if (config.enableAuditLogging) {
    await logAuditEvent({
      userId: req.user.id,
      action: "collection_deleted",
      resource: `collection:${id}`,
      ipAddress: req.ip || req.connection.remoteAddress || undefined,
      userAgent: req.headers["user-agent"] || undefined,
      details: { collectionId: id, collectionName: collection.name },
    });
  }

  res.json({ success: true });
}));

app.get("/library", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Library is user-specific, use userId as the key
  const libraryId = `user_${req.user.id}`;
  const library = await prisma.library.findUnique({
    where: { id: libraryId },
  });

  if (!library) {
    return res.json({ items: [] });
  }

  res.json({
    items: JSON.parse(library.items),
  });
}));

app.put("/library", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { items } = req.body;

  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "Items must be an array" });
  }

  // Library is user-specific, use userId as the key
  const libraryId = `user_${req.user.id}`;
  const library = await prisma.library.upsert({
    where: { id: libraryId },
    update: {
      items: JSON.stringify(items),
    },
    create: {
      id: libraryId,
      items: JSON.stringify(items),
    },
  });

  res.json({
    items: JSON.parse(library.items),
  });
}));

const excalidashManifestSchemaV1 = z.object({
  format: z.literal("excalidash"),
  formatVersion: z.literal(1),
  exportedAt: z.string().min(1),
  excalidashBackendVersion: z.string().optional(),
  userId: z.string().optional(),
  unorganizedFolder: z.string().min(1),
  collections: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      folder: z.string().min(1),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
    })
  ),
  drawings: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      filePath: z.string().min(1),
      collectionId: z.string().nullable(),
      version: z.number().int().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
    })
  ),
});

app.get("/export/excalidash", requireAuth, asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const extParam = typeof req.query.ext === "string" ? req.query.ext.toLowerCase() : "";
  const zipSuffix = extParam === "zip";
  const date = new Date().toISOString().split("T")[0];
  const filename = zipSuffix
    ? `excalidash-backup-${date}.excalidash.zip`
    : `excalidash-backup-${date}.excalidash`;

  const exportedAt = new Date().toISOString();

  const drawings = await prisma.drawing.findMany({
    where: { userId: req.user.id },
    include: { collection: true },
  });

  const userCollections = await prisma.collection.findMany({
    where: { userId: req.user.id },
  });

  const hasTrashDrawings = drawings.some((d) => d.collectionId === "trash");
  const collectionsToExport = [...userCollections];
  if (hasTrashDrawings && !collectionsToExport.some((c) => c.id === "trash")) {
    const trash = await prisma.collection.findUnique({ where: { id: "trash" } });
    if (trash) collectionsToExport.push(trash);
  }

  const exportSource = `${req.protocol}://${req.get("host")}`;

  const usedFolderNames = new Set<string>();
  const unorganizedFolder = makeUniqueName("Unorganized", usedFolderNames);

  const folderByCollectionId = new Map<string, string>();
  for (const collection of collectionsToExport) {
    const base = sanitizePathSegment(collection.name, "Collection");
    const folder = makeUniqueName(base, usedFolderNames);
    folderByCollectionId.set(collection.id, folder);
  }

  type DrawingWithCollection = Prisma.DrawingGetPayload<{
    include: { collection: true };
  }>;

  const drawingsManifest = drawings.map((drawing: DrawingWithCollection) => {
    const folder = drawing.collectionId
      ? folderByCollectionId.get(drawing.collectionId) || unorganizedFolder
      : unorganizedFolder;
    const fileNameBase = sanitizePathSegment(drawing.name, "Untitled");
    const fileName = `${fileNameBase}__${drawing.id.slice(0, 8)}.excalidraw`;
    const filePath = `${folder}/${fileName}`;
    return {
      id: drawing.id,
      name: drawing.name,
      filePath,
      collectionId: drawing.collectionId ?? null,
      version: drawing.version,
      createdAt: drawing.createdAt.toISOString(),
      updatedAt: drawing.updatedAt.toISOString(),
    };
  });

  const manifest = {
    format: "excalidash" as const,
    formatVersion: 1 as const,
    exportedAt,
    excalidashBackendVersion: getBackendVersion(),
    userId: req.user.id,
    unorganizedFolder,
    collections: collectionsToExport.map((c) => ({
      id: c.id,
      name: c.name,
      folder: folderByCollectionId.get(c.id) || sanitizePathSegment(c.name, "Collection"),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    drawings: drawingsManifest,
  };

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", (err) => {
    console.error("Archive error:", err);
    res.status(500).json({ error: "Failed to create archive" });
  });

  archive.pipe(res);

  // Root manifest
  archive.append(JSON.stringify(manifest, null, 2), { name: "excalidash.manifest.json" });

  // Drawings organized by collection folder
  const drawingsManifestById = new Map(drawingsManifest.map((d) => [d.id, d]));
  for (const drawing of drawings) {
    const meta = drawingsManifestById.get(drawing.id);
    if (!meta) continue;

    const drawingData = {
      type: "excalidraw" as const,
      version: 2 as const,
      source: exportSource,
      elements: JSON.parse(drawing.elements) as unknown[],
      appState: JSON.parse(drawing.appState) as Record<string, unknown>,
      files: JSON.parse(drawing.files || "{}") as Record<string, unknown>,
      excalidash: {
        drawingId: drawing.id,
        collectionId: drawing.collectionId ?? null,
        exportedAt,
      },
    };

    archive.append(JSON.stringify(drawingData, null, 2), { name: meta.filePath });
  }

  const readme = `ExcaliDash Backup (.excalidash)

This file is a zip archive containing a versioned ExcaliDash manifest and your drawings,
organized into folders by collection.

Files:
- excalidash.manifest.json (required)
- <Collection Folder>/*.excalidraw

ExportedAt: ${exportedAt}
FormatVersion: 1
BackendVersion: ${getBackendVersion()}
Collections: ${collectionsToExport.length}
Drawings: ${drawings.length}
`;

  archive.append(readme, { name: "README.txt" });

  await archive.finalize();
}));

app.post("/import/excalidash/verify", requireAuth, upload.single("archive"), asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const stagedPath = req.file.path;
  try {
    const buffer = await fsPromises.readFile(stagedPath);
    const zip = await JSZip.loadAsync(buffer);
    const manifestFile = zip.file("excalidash.manifest.json");
    if (!manifestFile) {
      return res.status(400).json({
        error: "Invalid backup",
        message: "Missing excalidash.manifest.json",
      });
    }
    const rawManifest = await manifestFile.async("string");
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(rawManifest);
    } catch {
      return res.status(400).json({
        error: "Invalid backup manifest",
        message: "excalidash.manifest.json is not valid JSON",
      });
    }
    const parsed = excalidashManifestSchemaV1.safeParse(manifestJson);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid backup manifest",
        message: "Malformed excalidash.manifest.json",
      });
    }

    const manifest = parsed.data;
    res.json({
      valid: true,
      formatVersion: manifest.formatVersion,
      exportedAt: manifest.exportedAt,
      excalidashBackendVersion: manifest.excalidashBackendVersion || null,
      collections: manifest.collections.length,
      drawings: manifest.drawings.length,
    });
  } finally {
    await removeFileIfExists(stagedPath);
  }
}));

app.post("/import/excalidash", requireAuth, upload.single("archive"), asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const stagedPath = req.file.path;
  try {
    const buffer = await fsPromises.readFile(stagedPath);
    const zip = await JSZip.loadAsync(buffer);
    const manifestFile = zip.file("excalidash.manifest.json");
    if (!manifestFile) {
      return res.status(400).json({
        error: "Invalid backup",
        message: "Missing excalidash.manifest.json",
      });
    }

    const rawManifest = await manifestFile.async("string");
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(rawManifest);
    } catch {
      return res.status(400).json({
        error: "Invalid backup manifest",
        message: "excalidash.manifest.json is not valid JSON",
      });
    }
    const parsed = excalidashManifestSchemaV1.safeParse(manifestJson);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid backup manifest",
        message: "Malformed excalidash.manifest.json",
      });
    }

    const manifest = parsed.data;

    const collectionIdMap = new Map<string, string>();
    let collectionsCreated = 0;
    let collectionsUpdated = 0;
    let collectionIdConflicts = 0;

    for (const c of manifest.collections) {
      if (c.id === "trash") {
        collectionIdMap.set("trash", "trash");
        continue;
      }

      const existing = await prisma.collection.findUnique({ where: { id: c.id } });
      if (!existing) {
        await prisma.collection.create({
          data: {
            id: c.id,
            name: c.name,
            userId: req.user.id,
          },
        });
        collectionIdMap.set(c.id, c.id);
        collectionsCreated += 1;
        continue;
      }

      if (existing.userId === req.user.id) {
        await prisma.collection.update({
          where: { id: c.id },
          data: { name: c.name },
        });
        collectionIdMap.set(c.id, c.id);
        collectionsUpdated += 1;
        continue;
      }

      const newId = uuidv4();
      await prisma.collection.create({
        data: {
          id: newId,
          name: c.name,
          userId: req.user.id,
        },
      });
      collectionIdMap.set(c.id, newId);
      collectionsCreated += 1;
      collectionIdConflicts += 1;
    }

    const resolveCollectionId = async (collectionId: string | null): Promise<string | null> => {
      if (!collectionId) return null;
      if (collectionId === "trash") {
        await ensureTrashCollection(req.user!.id);
        return "trash";
      }
      return collectionIdMap.get(collectionId) || null;
    };

    let drawingsCreated = 0;
    let drawingsUpdated = 0;
    let drawingIdConflicts = 0;

    for (const d of manifest.drawings) {
      const entry = zip.file(d.filePath);
      if (!entry) {
        return res.status(400).json({
          error: "Invalid backup",
          message: `Missing drawing file: ${d.filePath}`,
        });
      }

      const raw = await entry.async("string");
      const parsedJson = JSON.parse(raw) as any;

      const elements = Array.isArray(parsedJson?.elements) ? parsedJson.elements : [];
      const appState = typeof parsedJson?.appState === "object" && parsedJson.appState !== null ? parsedJson.appState : {};
      const files = typeof parsedJson?.files === "object" && parsedJson.files !== null ? parsedJson.files : {};

      const imported = {
        name: d.name,
        elements,
        appState,
        files,
        preview: null as string | null,
        collectionId: await resolveCollectionId(d.collectionId),
      };

      if (!validateImportedDrawing(imported)) {
        return res.status(400).json({
          error: "Invalid imported drawing",
          message: `Drawing failed validation: ${d.filePath}`,
        });
      }

      const sanitized = sanitizeDrawingData(imported);
      const targetCollectionId = imported.collectionId;

      const existing = await prisma.drawing.findUnique({ where: { id: d.id } });
      if (!existing) {
        await prisma.drawing.create({
          data: {
            id: d.id,
            name: sanitizeText(imported.name, 255) || "Untitled Drawing",
            elements: JSON.stringify(sanitized.elements),
            appState: JSON.stringify(sanitized.appState),
            files: JSON.stringify(sanitized.files || {}),
            preview: sanitized.preview ?? null,
            version: typeof d.version === "number" ? d.version : 1,
            userId: req.user.id,
            collectionId: targetCollectionId,
          },
        });
        drawingsCreated += 1;
        continue;
      }

      if (existing.userId === req.user.id) {
        await prisma.drawing.update({
          where: { id: d.id },
          data: {
            name: sanitizeText(imported.name, 255) || "Untitled Drawing",
            elements: JSON.stringify(sanitized.elements),
            appState: JSON.stringify(sanitized.appState),
            files: JSON.stringify(sanitized.files || {}),
            preview: sanitized.preview ?? null,
            version: typeof d.version === "number" ? d.version : existing.version,
            collectionId: targetCollectionId,
          },
        });
        drawingsUpdated += 1;
        continue;
      }

      const newId = uuidv4();
      await prisma.drawing.create({
        data: {
          id: newId,
          name: sanitizeText(imported.name, 255) || "Untitled Drawing",
          elements: JSON.stringify(sanitized.elements),
          appState: JSON.stringify(sanitized.appState),
          files: JSON.stringify(sanitized.files || {}),
          preview: sanitized.preview ?? null,
          version: typeof d.version === "number" ? d.version : 1,
          userId: req.user.id,
          collectionId: targetCollectionId,
        },
      });
      drawingsCreated += 1;
      drawingIdConflicts += 1;
    }

    invalidateDrawingsCache();

    res.json({
      success: true,
      message: "Backup imported successfully",
      collections: {
        created: collectionsCreated,
        updated: collectionsUpdated,
        idConflicts: collectionIdConflicts,
      },
      drawings: {
        created: drawingsCreated,
        updated: drawingsUpdated,
        idConflicts: drawingIdConflicts,
      },
    });
  } finally {
    await removeFileIfExists(stagedPath);
  }
}));

const findSqliteTable = (tables: string[], candidates: string[]): string | null => {
  const byLower = new Map(tables.map((t) => [t.toLowerCase(), t]));
  for (const candidate of candidates) {
    const found = byLower.get(candidate.toLowerCase());
    if (found) return found;
  }
  return null;
};

const parseOptionalJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  if (typeof raw === "object" && raw !== null) {
    return raw as T;
  }
  return fallback;
};

const getCurrentLatestPrismaMigrationName = async (): Promise<string | null> => {
  try {
    const migrationsDir = path.resolve(backendRoot, "prisma/migrations");
    const entries = await fsPromises.readdir(migrationsDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !name.startsWith("."));
    if (dirs.length === 0) return null;
    // Migration folders start with timestamps, so lexicographic max is newest.
    dirs.sort();
    return dirs[dirs.length - 1] || null;
  } catch {
    return null;
  }
};

/**
 * Legacy SQLite import (MERGE) - does not overwrite the current DB.
 * This is safer than /import/sqlite which replaces the entire database file.
 */
app.post("/import/sqlite/legacy/verify", requireAuth, upload.single("db"), asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const stagedPath = req.file.path;
  try {
    const isValid = await verifyDatabaseIntegrityAsync(stagedPath);
    if (!isValid) {
      return res.status(400).json({ error: "Invalid database format" });
    }

    // Use better-sqlite3 to inspect the legacy DB file
    let Database: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      Database = require("better-sqlite3") as any;
    } catch (error) {
      return res.status(500).json({
        error: "Legacy DB support unavailable",
        message:
          "Failed to load better-sqlite3. Run `cd backend && npm rebuild better-sqlite3` (or reinstall dependencies) and try again.",
      });
    }
    const db = new Database(stagedPath, { readonly: true, fileMustExist: true });
    try {
      const tables: string[] = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row: any) => String(row.name));

      const drawingTable = findSqliteTable(tables, ["Drawing", "drawings"]);
      const collectionTable = findSqliteTable(tables, ["Collection", "collections"]);
      if (!drawingTable) {
        return res.status(400).json({ error: "Invalid legacy DB", message: "Missing Drawing table" });
      }

      const drawingsCount = Number(
        db.prepare(`SELECT COUNT(1) as c FROM "${drawingTable}"`).get()?.c ?? 0
      );
      const collectionsCount = collectionTable
        ? Number(db.prepare(`SELECT COUNT(1) as c FROM "${collectionTable}"`).get()?.c ?? 0)
        : 0;

      let latestMigration: string | null = null;
      const migrationsTable = findSqliteTable(tables, ["_prisma_migrations"]);
      if (migrationsTable) {
        try {
          const row = db
            .prepare(
              `SELECT migration_name as name, finished_at as finishedAt FROM "${migrationsTable}" ORDER BY finished_at DESC LIMIT 1`
            )
            .get();
          if (row?.name) latestMigration = String(row.name);
        } catch {
          latestMigration = null;
        }
      }

      res.json({
        valid: true,
        drawings: drawingsCount,
        collections: collectionsCount,
        latestMigration,
        currentLatestMigration: await getCurrentLatestPrismaMigrationName(),
      });
    } finally {
      try {
        db.close();
      } catch { }
    }
  } finally {
    await removeFileIfExists(stagedPath);
  }
}));

app.post("/import/sqlite/legacy", requireAuth, upload.single("db"), asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const stagedPath = req.file.path;
  try {
    const isValid = await verifyDatabaseIntegrityAsync(stagedPath);
    if (!isValid) {
      return res.status(400).json({ error: "Invalid database format" });
    }

    let Database: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      Database = require("better-sqlite3") as any;
    } catch (error) {
      return res.status(500).json({
        error: "Legacy DB support unavailable",
        message:
          "Failed to load better-sqlite3. Run `cd backend && npm rebuild better-sqlite3` (or reinstall dependencies) and try again.",
      });
    }
    const legacyDb = new Database(stagedPath, { readonly: true, fileMustExist: true });
    try {
      const tables: string[] = legacyDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row: any) => String(row.name));

      const drawingTable = findSqliteTable(tables, ["Drawing", "drawings"]);
      const collectionTable = findSqliteTable(tables, ["Collection", "collections"]);

      if (!drawingTable) {
        return res.status(400).json({ error: "Invalid legacy DB", message: "Missing Drawing table" });
      }

      const importedCollections: any[] = collectionTable
        ? legacyDb.prepare(`SELECT * FROM "${collectionTable}"`).all()
        : [];
      const importedDrawings: any[] = legacyDb.prepare(`SELECT * FROM "${drawingTable}"`).all();

      const hasTrash = importedDrawings.some((d) => String(d.collectionId || "") === "trash");
      if (hasTrash) {
        await ensureTrashCollection(req.user.id);
      }

      const collectionIdMap = new Map<string, string>();
      let collectionsCreated = 0;
      let collectionsUpdated = 0;
      let collectionIdConflicts = 0;

      for (const c of importedCollections) {
        const importedId = typeof c.id === "string" ? c.id : null;
        const name = typeof c.name === "string" ? c.name : "Collection";

        if (importedId === "trash" || name === "Trash") {
          collectionIdMap.set(importedId || "trash", "trash");
          continue;
        }

        if (!importedId) {
          const newId = uuidv4();
          await prisma.collection.create({
            data: { id: newId, name: sanitizeText(name, 100) || "Collection", userId: req.user.id },
          });
          collectionIdMap.set(`__name:${name}`, newId);
          collectionsCreated += 1;
          continue;
        }

        const existing = await prisma.collection.findUnique({ where: { id: importedId } });
        if (!existing) {
          await prisma.collection.create({
            data: { id: importedId, name: sanitizeText(name, 100) || "Collection", userId: req.user.id },
          });
          collectionIdMap.set(importedId, importedId);
          collectionsCreated += 1;
          continue;
        }

        if (existing.userId === req.user.id) {
          await prisma.collection.update({
            where: { id: importedId },
            data: { name: sanitizeText(name, 100) || "Collection" },
          });
          collectionIdMap.set(importedId, importedId);
          collectionsUpdated += 1;
          continue;
        }

        const newId = uuidv4();
        await prisma.collection.create({
          data: { id: newId, name: sanitizeText(name, 100) || "Collection", userId: req.user.id },
        });
        collectionIdMap.set(importedId, newId);
        collectionsCreated += 1;
        collectionIdConflicts += 1;
      }

      const resolveImportedCollectionId = (rawCollectionId: unknown, rawCollectionName: unknown): string | null => {
        const id = typeof rawCollectionId === "string" ? rawCollectionId : null;
        const name = typeof rawCollectionName === "string" ? rawCollectionName : null;

        if (id === "trash" || name === "Trash") return "trash";
        if (id && collectionIdMap.has(id)) return collectionIdMap.get(id)!;
        if (name && collectionIdMap.has(`__name:${name}`)) return collectionIdMap.get(`__name:${name}`)!;
        return null;
      };

      let drawingsCreated = 0;
      let drawingsUpdated = 0;
      let drawingIdConflicts = 0;

      for (const d of importedDrawings) {
        const importedId = typeof d.id === "string" ? d.id : null;

        const elements = parseOptionalJson<unknown[]>(d.elements, []);
        const appState = parseOptionalJson<Record<string, unknown>>(d.appState, {});
        const files = parseOptionalJson<Record<string, unknown>>(d.files, {});
        const preview = typeof d.preview === "string" ? d.preview : null;

        const importPayload = {
          name: typeof d.name === "string" ? d.name : "Untitled Drawing",
          elements,
          appState,
          files,
          preview,
          collectionId: resolveImportedCollectionId(d.collectionId, d.collectionName),
        };

        if (!validateImportedDrawing(importPayload)) {
          return res.status(400).json({
            error: "Invalid imported drawing",
            message: "Legacy database contains invalid drawing data",
          });
        }

        const sanitized = sanitizeDrawingData(importPayload);
        const drawingName = sanitizeText(importPayload.name, 255) || "Untitled Drawing";

        const existing = importedId ? await prisma.drawing.findUnique({ where: { id: importedId } }) : null;

        if (!existing) {
          const idToUse = importedId || uuidv4();
          await prisma.drawing.create({
            data: {
              id: idToUse,
              name: drawingName,
              elements: JSON.stringify(sanitized.elements),
              appState: JSON.stringify(sanitized.appState),
              files: JSON.stringify(sanitized.files || {}),
              preview: sanitized.preview ?? null,
              version: Number.isFinite(Number(d.version)) ? Number(d.version) : 1,
              userId: req.user.id,
              collectionId: importPayload.collectionId ?? null,
            },
          });
          drawingsCreated += 1;
          continue;
        }

        if (existing.userId === req.user.id) {
          await prisma.drawing.update({
            where: { id: existing.id },
            data: {
              name: drawingName,
              elements: JSON.stringify(sanitized.elements),
              appState: JSON.stringify(sanitized.appState),
              files: JSON.stringify(sanitized.files || {}),
              preview: sanitized.preview ?? null,
              version: Number.isFinite(Number(d.version)) ? Number(d.version) : existing.version,
              collectionId: importPayload.collectionId ?? null,
            },
          });
          drawingsUpdated += 1;
          continue;
        }

        const newId = uuidv4();
        await prisma.drawing.create({
          data: {
            id: newId,
            name: drawingName,
            elements: JSON.stringify(sanitized.elements),
            appState: JSON.stringify(sanitized.appState),
            files: JSON.stringify(sanitized.files || {}),
            preview: sanitized.preview ?? null,
            version: Number.isFinite(Number(d.version)) ? Number(d.version) : 1,
            userId: req.user.id,
            collectionId: importPayload.collectionId ?? null,
          },
        });
        drawingsCreated += 1;
        drawingIdConflicts += 1;
      }

      invalidateDrawingsCache();

      res.json({
        success: true,
        collections: { created: collectionsCreated, updated: collectionsUpdated, idConflicts: collectionIdConflicts },
        drawings: { created: drawingsCreated, updated: drawingsUpdated, idConflicts: drawingIdConflicts },
      });
    } finally {
      try {
        legacyDb.close();
      } catch { }
    }
  } finally {
    await removeFileIfExists(stagedPath);
  }
}));

// Error handler middleware (must be last)
app.use(errorHandler);

httpServer.listen(PORT, async () => {
  await initializeUploadDir();
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Frontend URL: ${config.frontendUrl}`);
});
