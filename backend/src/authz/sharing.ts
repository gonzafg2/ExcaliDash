import crypto from "crypto";
import jwt from "jsonwebtoken";
import type { PrismaClient } from "../generated/client";
import { hashTokenForStorage } from "../auth/tokenSecurity";
import { readCookie } from "../auth/cookies";

export type DrawingPermission = "view" | "edit";
export type DrawingAccess = "none" | DrawingPermission | "owner";

export type DrawingPrincipal =
  | { kind: "user"; userId: string }
  | { kind: "share"; shareId: string; drawingId: string; permission: DrawingPermission };

export const SHARE_SESSION_COOKIE_NAME = "excalidash-share-session";
const SHARE_SESSION_TOKEN_TYPE = "drawing_share_session";

type ShareSessionJwtPayload = {
  type: string;
  shareId: string;
  drawingId: string;
  permission: DrawingPermission;
};

export const normalizeDrawingPermission = (input: unknown): DrawingPermission | null => {
  if (input === "view" || input === "edit") return input;
  return null;
};

export const buildShareLinkToken = (): string => crypto.randomBytes(24).toString("base64url");

export const hashShareLinkToken = (token: string): string => hashTokenForStorage(token);

const normalizePassphraseForHash = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const SCRYPT_PREFIX = "scrypt";
const DEFAULT_SCRYPT_N = 16384;
const DEFAULT_SCRYPT_R = 8;
const DEFAULT_SCRYPT_P = 1;
const DEFAULT_SCRYPT_KEYLEN = 32;
const DEFAULT_SCRYPT_SALT_BYTES = 16;
const DEFAULT_SCRYPT_MAXMEM = 64 * 1024 * 1024;

export const hashPassphrase = (value: string, pepper: string): string => {
  const normalized = normalizePassphraseForHash(value);
  const salt = crypto.randomBytes(DEFAULT_SCRYPT_SALT_BYTES);
  const key = crypto.scryptSync(
    `${pepper}|${normalized}`,
    salt,
    DEFAULT_SCRYPT_KEYLEN,
    {
      cost: DEFAULT_SCRYPT_N,
      blockSize: DEFAULT_SCRYPT_R,
      parallelization: DEFAULT_SCRYPT_P,
      maxmem: DEFAULT_SCRYPT_MAXMEM,
    }
  );
  return [
    SCRYPT_PREFIX,
    String(DEFAULT_SCRYPT_N),
    String(DEFAULT_SCRYPT_R),
    String(DEFAULT_SCRYPT_P),
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
};

export const verifyPassphraseHash = (
  provided: string,
  expected: string,
  pepper: string
): boolean => {
  const normalized = normalizePassphraseForHash(provided);
  const expectedText = (expected || "").trim();

  // New format: scrypt$N$r$p$salt$hash
  if (expectedText.startsWith(`${SCRYPT_PREFIX}$`)) {
    const parts = expectedText.split("$");
    if (parts.length !== 6) return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const saltB64 = parts[4] || "";
    const hashB64 = parts[5] || "";
    if (!Number.isFinite(n) || n <= 0) return false;
    if (!Number.isFinite(r) || r <= 0) return false;
    if (!Number.isFinite(p) || p <= 0) return false;
    if (!saltB64 || !hashB64) return false;

    let salt: Buffer;
    let expectedKey: Buffer;
    try {
      salt = Buffer.from(saltB64, "base64url");
      expectedKey = Buffer.from(hashB64, "base64url");
    } catch {
      return false;
    }
    if (salt.length < 8) return false;
    if (expectedKey.length < 16) return false;

    const actualKey = crypto.scryptSync(
      `${pepper}|${normalized}`,
      salt,
      expectedKey.length,
      {
        cost: n,
        blockSize: r,
        parallelization: p,
        maxmem: DEFAULT_SCRYPT_MAXMEM,
      }
    );
    if (actualKey.length !== expectedKey.length) return false;
    return crypto.timingSafeEqual(actualKey, expectedKey);
  }

  // Legacy format: sha256 hex of `${pepper}|${normalized}` (no salt).
  if (/^[0-9a-f]{64}$/i.test(expectedText)) {
    const legacyHash = crypto.createHash("sha256").update(`${pepper}|${normalized}`, "utf8").digest("hex");
    const expectedBuf = Buffer.from(expectedText, "hex");
    const actualBuf = Buffer.from(legacyHash, "hex");
    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  }

  return false;
};

export const issueShareSessionToken = (params: {
  jwtSecret: string;
  shareId: string;
  drawingId: string;
  permission: DrawingPermission;
  expiresAt: Date;
}): string => {
  const payload: ShareSessionJwtPayload = {
    type: SHARE_SESSION_TOKEN_TYPE,
    shareId: params.shareId,
    drawingId: params.drawingId,
    permission: params.permission,
  };

  const ttlSeconds = Math.max(60, Math.floor((params.expiresAt.getTime() - Date.now()) / 1000));
  return jwt.sign(payload, params.jwtSecret, { expiresIn: ttlSeconds });
};

export const parseShareSessionToken = (
  token: string,
  jwtSecret: string
): { shareId: string; drawingId: string; permission: DrawingPermission } | null => {
  try {
    const decoded = jwt.verify(token, jwtSecret) as unknown;
    if (typeof decoded !== "object" || decoded === null) return null;
    const payload = decoded as Partial<ShareSessionJwtPayload>;
    if (payload.type !== SHARE_SESSION_TOKEN_TYPE) return null;
    if (typeof payload.shareId !== "string" || payload.shareId.trim().length === 0) return null;
    if (typeof payload.drawingId !== "string" || payload.drawingId.trim().length === 0) return null;
    const permission = normalizeDrawingPermission(payload.permission);
    if (!permission) return null;
    return { shareId: payload.shareId, drawingId: payload.drawingId, permission };
  } catch {
    return null;
  }
};

export const getSharePrincipalFromRequest = async (params: {
  prisma: PrismaClient;
  req: { headers: { cookie?: string | undefined } };
  jwtSecret: string;
}): Promise<DrawingPrincipal | null> => {
  const token = readCookie(params.req as never, SHARE_SESSION_COOKIE_NAME);
  if (!token) return null;

  const parsed = parseShareSessionToken(token, params.jwtSecret);
  if (!parsed) return null;

  const share = await params.prisma.drawingLinkShare.findUnique({
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

export const getDrawingAccess = async (params: {
  prisma: PrismaClient;
  principal: DrawingPrincipal | null;
  drawingId: string;
  now?: Date;
}): Promise<DrawingAccess> => {
  const nowMs = (params.now ?? new Date()).getTime();

  let baseAccess: DrawingAccess = "none";

  // Share-session access (legacy token exchange flow).
  if (params.principal?.kind === "share") {
    if (params.principal.drawingId === params.drawingId) {
      const share = await params.prisma.drawingLinkShare.findUnique({
        where: { id: params.principal.shareId },
        select: { permission: true, revokedAt: true, expiresAt: true },
      });
      if (share && !share.revokedAt && (!share.expiresAt || share.expiresAt.getTime() > nowMs)) {
        baseAccess = normalizeDrawingPermission(share.permission) ?? "none";
      }
    }
  }

  // User-based access (owner or explicit ACL).
  if (params.principal?.kind === "user") {
    const drawing = await params.prisma.drawing.findUnique({
      where: { id: params.drawingId },
      select: { userId: true },
    });
    if (!drawing) return "none";
    if (drawing.userId === params.principal.userId) return "owner";

    const perm = await params.prisma.drawingPermission.findUnique({
      where: {
        drawingId_granteeUserId: {
          drawingId: params.drawingId,
          granteeUserId: params.principal.userId,
        },
      },
      select: { permission: true },
    });
    baseAccess = normalizeDrawingPermission(perm?.permission) ?? baseAccess;
  }

  // Google Docs-style link policy: applies regardless of whether the visitor is signed in.
  // If a drawing has an active link-share policy, possession of the drawing id URL grants the policy access.
  const linkPolicy = await getActiveLinkShareAccess({
    prisma: params.prisma,
    drawingId: params.drawingId,
    nowMs,
  });
  const linkAccess: DrawingAccess = linkPolicy ?? "none";

  return maxAccess(baseAccess, linkAccess);
};

export const canViewDrawing = (
  access: DrawingAccess
): access is Exclude<DrawingAccess, "none"> => access !== "none";

export const canEditDrawing = (
  access: DrawingAccess
): access is Extract<DrawingAccess, "edit" | "owner"> =>
  access === "edit" || access === "owner";

export const isOwnerAccess = (access: DrawingAccess): boolean => access === "owner";

const getActiveLinkShareAccess = async (params: {
  prisma: PrismaClient;
  drawingId: string;
  nowMs: number;
}): Promise<DrawingPermission | null> => {
  const linkShare = await params.prisma.drawingLinkShare.findFirst({
    where: {
      drawingId: params.drawingId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(params.nowMs) } }],
    },
    orderBy: { createdAt: "desc" },
    select: { permission: true },
  });
  return normalizeDrawingPermission(linkShare?.permission);
};

const accessRank = (access: DrawingAccess): number => {
  switch (access) {
    case "owner":
      return 3;
    case "edit":
      return 2;
    case "view":
      return 1;
    default:
      return 0;
  }
};

const maxAccess = (a: DrawingAccess, b: DrawingAccess): DrawingAccess =>
  accessRank(a) >= accessRank(b) ? a : b;
