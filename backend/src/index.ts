import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { promises as fsPromises } from "fs";
import { createServer } from "http";
import { Server } from "socket.io";
import { Worker } from "worker_threads";
import multer from "multer";
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
import jwt from "jsonwebtoken";
import { config } from "./config";
import { requireAuth } from "./middleware/auth";
import { errorHandler, asyncHandler } from "./middleware/errorHandler";
import authRouter from "./auth";
import { logAuditEvent } from "./utils/audit";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerImportExportRoutes } from "./routes/importExport";

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
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_PAGE_SIZE = 200;
const MAX_IMPORT_ARCHIVE_ENTRIES = 6000;
const MAX_IMPORT_COLLECTIONS = 1000;
const MAX_IMPORT_DRAWINGS = 5000;
const MAX_IMPORT_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_DRAWING_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_TOTAL_EXTRACTED_BYTES = 120 * 1024 * 1024;

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

const initializeUploadDir = async () => {
  try {
    await fsPromises.mkdir(uploadDir, { recursive: true });
  } catch (error) {
    console.error("Failed to create upload directory:", error);
  }
};

const app = express();

// Trust proxy headers (X-Forwarded-For, X-Real-IP) from nginx.
// Default to a single trusted proxy hop unless TRUST_PROXY is explicitly configured.
// Set TRUST_PROXY=true only when you fully trust all upstream proxy hops.
const trustProxyConfig = (process.env.TRUST_PROXY ?? "1").trim();
const trustProxyValue = trustProxyConfig === "true"
  ? true
  : trustProxyConfig === "false"
  ? false
  : Number.parseInt(trustProxyConfig, 10) || 1;
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
  userId: string;
  searchTerm: string;
  collectionFilter: string;
  includeData: boolean;
  sortField: "name" | "createdAt" | "updatedAt";
  sortDirection: "asc" | "desc";
}) =>
  JSON.stringify([
    keyParts.userId,
    keyParts.searchTerm,
    keyParts.collectionFilter,
    keyParts.includeData ? "full" : "summary",
    keyParts.sortField,
    keyParts.sortDirection,
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

const getUserTrashCollectionId = (userId: string): string => `trash:${userId}`;

const ensureTrashCollection = async (
  db: Prisma.TransactionClient | PrismaClient,
  userId: string
): Promise<void> => {
  const trashCollectionId = getUserTrashCollectionId(userId);
  const trashCollection = await db.collection.findFirst({
    where: { id: trashCollectionId, userId },
  });

  if (!trashCollection) {
    await db.collection.create({
      data: {
        id: trashCollectionId,
        name: "Trash",
        userId,
      },
    });
  }

  // Legacy migration: move this user's drawings off global "trash".
  await db.drawing.updateMany({
    where: { userId, collectionId: "trash" },
    data: { collectionId: trashCollectionId },
  });
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
    fileSize: MAX_UPLOAD_SIZE_BYTES,
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

// HTTPS enforcement in production only when configured frontend origins use HTTPS.
const shouldEnforceHttps =
  config.nodeEnv === "production" &&
  allowedOrigins.some((origin) => origin.toLowerCase().startsWith("https://"));

if (shouldEnforceHttps) {
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
    allowedHeaders: ["Content-Type", "Authorization", "x-csrf-token", "x-imported-file"],
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
  // We intentionally allow `app.set("trust proxy", true)` for deployments with multiple proxy layers.
  // express-rate-limit warns (and can throw) in that configuration; we accept the risk in favor of
  // correct client IP handling and rely on deployment-level network controls.
  validate: {
    trustProxy: false,
  },
});

app.use(generalRateLimiter);

// CSRF Protection Middleware
// Generates a unique client ID based on IP and User-Agent for token association
const CSRF_CLIENT_COOKIE_NAME = "excalidash-csrf-client";
const CSRF_CLIENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

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

const getCsrfClientCookieValue = (req: express.Request): string | null => {
  const cookies = parseCookies(req.headers.cookie);
  const value = cookies[CSRF_CLIENT_COOKIE_NAME];
  if (!value) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) return null;
  return value;
};

const requestUsesHttps = (req: express.Request): boolean => {
  if (req.secure) return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const raw = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const firstHop = String(raw || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return firstHop === "https";
};

const setCsrfClientCookie = (req: express.Request, res: express.Response, value: string): void => {
  const secure = requestUsesHttps(req) ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `${CSRF_CLIENT_COOKIE_NAME}=${encodeURIComponent(
      value
    )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CSRF_CLIENT_COOKIE_MAX_AGE_SECONDS}${secure}`
  );
};

const getLegacyClientId = (req: express.Request): string => {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";
  return `${ip}:${userAgent}`.slice(0, 256);
};

const getClientIdForTokenIssue = (
  req: express.Request,
  res: express.Response
): { clientId: string; strategy: "cookie" | "legacy-bootstrap" } => {
  const existingCookieValue = getCsrfClientCookieValue(req);
  if (existingCookieValue) {
    return {
      clientId: `cookie:${existingCookieValue}`,
      strategy: "cookie",
    };
  }

  // No cookie presented by client yet:
  // - issue a token bound to legacy identity for compatibility with non-cookie clients
  // - still set a cookie so subsequent browser requests can transition to cookie-bound tokens
  const generatedCookieValue = uuidv4().replace(/-/g, "");
  setCsrfClientCookie(req, res, generatedCookieValue);
  return {
    clientId: getLegacyClientId(req),
    strategy: "legacy-bootstrap",
  };
};

const getClientIdCandidatesForValidation = (req: express.Request): string[] => {
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

const getClientIdForTokenIssueDebug = (
  req: express.Request,
  res: express.Response
): string => {
  const { clientId, strategy } = getClientIdForTokenIssue(req, res);

  // Debug logging for CSRF troubleshooting (issue #38)
  if (process.env.DEBUG_CSRF === "true") {
    const validationCandidates = getClientIdCandidatesForValidation(req);
    const ip = req.ip || req.connection.remoteAddress || "unknown";
    console.log("[CSRF DEBUG] getClientId", {
      method: req.method,
      path: req.path,
      ip,
      remoteAddress: req.connection.remoteAddress,
      "x-forwarded-for": req.headers["x-forwarded-for"],
      "x-real-ip": req.headers["x-real-ip"],
      hasCsrfCookie: Boolean(getCsrfClientCookieValue(req)),
      clientIdPreview: clientId.slice(0, 60) + "...",
      trustProxySetting: req.app.get("trust proxy"),
      strategy,
      validationCandidatesPreview: validationCandidates.map((candidate) =>
        `${candidate.slice(0, 60)}...`
      ),
    });
  }

  return clientId;
};

// Rate limiter specifically for CSRF token generation to prevent store exhaustion
const csrfRateLimit = new Map<string, { count: number; resetTime: number }>();
const CSRF_RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
let csrfCleanupCounter = 0;
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

  // Cleanup every 100 requests.
  csrfCleanupCounter += 1;
  if (csrfCleanupCounter % 100 === 0) {
    for (const [key, data] of csrfRateLimit.entries()) {
      if (now > data.resetTime) csrfRateLimit.delete(key);
    }
  }

  const clientId = getClientIdForTokenIssueDebug(req, res);
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

  const clientIdCandidates = getClientIdCandidatesForValidation(req);
  const headerName = getCsrfTokenHeader();
  const tokenHeader = req.headers[headerName];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;

  if (!token) {
    return res.status(403).json({
      error: "CSRF token missing",
      message: `Missing ${headerName} header`,
    });
  }

  const isValidToken = clientIdCandidates.some((clientId) =>
    validateCsrfToken(clientId, token)
  );
  if (!isValidToken) {
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

const drawingUpdateSchemaBase = drawingBaseSchema
  .extend({
    elements: elementSchema.array().optional(),
    appState: appStateSchema.optional(),
    files: filesFieldSchema,
    version: z.number().int().positive().optional(),
  });

export const sanitizeDrawingUpdateData = (
  data: {
    elements?: unknown[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
    preview?: string | null;
    name?: string;
    collectionId?: string | null;
  }
): boolean => {
  const hasSceneFields =
    data.elements !== undefined ||
    data.appState !== undefined ||
    data.files !== undefined;
  const hasPreviewField = data.preview !== undefined;
  const needsSanitization = hasSceneFields || hasPreviewField;

  try {
    const sanitizedData = { ...data };
    if (hasSceneFields) {
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
      if (data.preview !== undefined) sanitizedData.preview = sanitized.preview;
      Object.assign(data, sanitizedData);
    } else if (hasPreviewField && typeof data.preview === "string") {
      // Preview-only updates must not inject default scene fields.
      data.preview = sanitizeSvg(data.preview);
      Object.assign(data, { ...data, preview: data.preview });
    } else if (hasPreviewField && data.preview === null) {
      // Explicitly allow clearing preview without touching scene data.
      Object.assign(data, sanitizedData);
    }
    return true;
  } catch (error) {
    console.error("Sanitization failed:", error);
    if (!needsSanitization) {
      return true;
    }
    return false;
  }
};

const drawingUpdateSchema = drawingUpdateSchemaBase.refine(
    (data) => sanitizeDrawingUpdateData(data as any),
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

// Track which authenticated user owns each socket for authorization checks
const socketUserMap = new Map<string, string>();

const toPresenceName = (value: unknown): string => {
  if (typeof value !== "string") return "User";
  const trimmed = value.trim().slice(0, 120);
  return trimmed.length > 0 ? trimmed : "User";
};

const toPresenceInitials = (name: string): string => {
  const words = name
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (words.length === 0) return "U";
  const first = words[0]?.[0] ?? "";
  const second = words.length > 1 ? words[1]?.[0] ?? "" : "";
  const initials = `${first}${second}`.toUpperCase().slice(0, 2);
  return initials.length > 0 ? initials : "U";
};

const toPresenceColor = (value: unknown): string => {
  if (typeof value !== "string") return "#4f46e5";
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
    return trimmed;
  }
  return "#4f46e5";
};

/**
 * Verify JWT from Socket.io auth and check if auth is required.
 * When auth is disabled (single-user mode), all connections are allowed.
 */
const getSocketAuthUserId = async (token?: string): Promise<string | null> => {
  // Check if auth is enabled
  const systemConfig = await prisma.systemConfig.findUnique({
    where: { id: "default" },
    select: { authEnabled: true },
  });

  if (!systemConfig || !systemConfig.authEnabled) {
    // Auth disabled: allow all connections (single-user / bootstrap mode)
    return "bootstrap-admin";
  }

  // Auth enabled: require valid JWT
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as Record<string, unknown>;
    if (
      typeof decoded.userId !== "string" ||
      typeof decoded.email !== "string" ||
      decoded.type !== "access"
    ) {
      return null;
    }

    // Verify user is still active
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

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token as string | undefined;
    const userId = await getSocketAuthUserId(token);

    if (!userId) {
      return next(new Error("Authentication required"));
    }

    socketUserMap.set(socket.id, userId);
    next();
  } catch {
    next(new Error("Authentication failed"));
  }
});

io.on("connection", (socket) => {
  const authenticatedUserId = socketUserMap.get(socket.id);
  const authorizedDrawingIds = new Set<string>();

  socket.on(
    "join-room",
    async ({
      drawingId,
      user,
    }: {
      drawingId: string;
      user: Omit<User, "socketId" | "isActive">;
    }) => {
      try {
        // Verify the authenticated user owns this drawing
        if (authenticatedUserId) {
          const drawing = await prisma.drawing.findFirst({
            where: { id: drawingId, userId: authenticatedUserId },
            select: { id: true },
          });

          if (!drawing) {
            socket.emit("error", { message: "You do not have access to this drawing" });
            return;
          }
        }

        const roomId = `drawing_${drawingId}`;
        socket.join(roomId);
        authorizedDrawingIds.add(drawingId);

        let trustedUserId =
          typeof user?.id === "string" && user.id.trim().length > 0
            ? user.id.trim().slice(0, 200)
            : socket.id;
        let trustedName = toPresenceName(user?.name);

        // In auth-enabled mode, identity should come from the authenticated account.
        if (authenticatedUserId && authenticatedUserId !== "bootstrap-admin") {
          const account = await prisma.user.findUnique({
            where: { id: authenticatedUserId },
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
      } catch (err) {
        console.error("Error in join-room handler:", err);
        socket.emit("error", { message: "Failed to join room" });
      }
    }
  );

  socket.on("cursor-move", (data) => {
    const drawingId = typeof data?.drawingId === "string" ? data.drawingId : null;
    if (!drawingId || !authorizedDrawingIds.has(drawingId)) {
      return;
    }
    const roomId = `drawing_${drawingId}`;
    socket.volatile.to(roomId).emit("cursor-move", data);
  });

  socket.on("element-update", (data) => {
    const drawingId = typeof data?.drawingId === "string" ? data.drawingId : null;
    if (!drawingId || !authorizedDrawingIds.has(drawingId)) {
      return;
    }
    const roomId = `drawing_${drawingId}`;
    socket.to(roomId).emit("element-update", data);
  });

  socket.on(
    "user-activity",
    ({ drawingId, isActive }: { drawingId: string; isActive: boolean }) => {
      if (!authorizedDrawingIds.has(drawingId)) {
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
    socketUserMap.delete(socket.id);
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

registerDashboardRoutes(app, {
  prisma,
  requireAuth,
  asyncHandler,
  parseJsonField,
  sanitizeText,
  validateImportedDrawing,
  drawingCreateSchema,
  drawingUpdateSchema,
  respondWithValidationErrors,
  collectionNameSchema,
  ensureTrashCollection,
  invalidateDrawingsCache,
  buildDrawingsCacheKey,
  getCachedDrawingsBody,
  cacheDrawingsResponse,
  MAX_PAGE_SIZE,
  config,
  logAuditEvent,
});

registerImportExportRoutes({
  app,
  prisma,
  requireAuth,
  asyncHandler,
  upload,
  uploadDir,
  backendRoot,
  getBackendVersion,
  parseJsonField,
  sanitizeText,
  validateImportedDrawing,
  ensureTrashCollection,
  invalidateDrawingsCache,
  removeFileIfExists,
  verifyDatabaseIntegrityAsync,
  MAX_IMPORT_ARCHIVE_ENTRIES,
  MAX_IMPORT_COLLECTIONS,
  MAX_IMPORT_DRAWINGS,
  MAX_IMPORT_MANIFEST_BYTES,
  MAX_IMPORT_DRAWING_BYTES,
  MAX_IMPORT_TOTAL_EXTRACTED_BYTES,
});

// Error handler middleware (must be last)
app.use(errorHandler);

export { app, httpServer };

const isMain =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  typeof require !== "undefined" && require.main === module;

if (isMain) {
  httpServer.listen(PORT, async () => {
    await initializeUploadDir();
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${config.nodeEnv}`);
    console.log(`Frontend URL: ${config.frontendUrl}`);
  });
}
