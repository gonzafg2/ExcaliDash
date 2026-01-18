import crypto from "crypto";

export type AuthSameSite = "lax" | "strict" | "none";

export type AuthConfig = {
  enabled: boolean;
  sessionTtlMs: number;
  cookieName: string;
  cookieSameSite: AuthSameSite;
  secret: Buffer;
  minPasswordLength: number;
};

export type AuthSession = {
  userId: string;
  iat: number;
  exp: number;
};

const DEFAULT_SESSION_TTL_HOURS = 24 * 7;
const DEFAULT_COOKIE_NAME = "excalidash_auth";
const DEFAULT_COOKIE_SAMESITE: AuthSameSite = "lax";

const base64UrlEncode = (input: Buffer | string): string => {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const base64UrlDecode = (input: string): Buffer => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
};

const parseSessionTtlHours = (rawValue?: string): number => {
  if (!rawValue) return DEFAULT_SESSION_TTL_HOURS;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_TTL_HOURS;
  }
  return parsed;
};

const parseMinPasswordLength = (rawValue?: string): number => {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 7;
  }
  return Math.floor(parsed);
};

const parseSameSite = (rawValue?: string): AuthSameSite => {
  if (!rawValue) return DEFAULT_COOKIE_SAMESITE;
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "none" || normalized === "strict" || normalized === "lax") {
    return normalized;
  }
  return DEFAULT_COOKIE_SAMESITE;
};

const resolveAuthSecret = (enabled: boolean, env: NodeJS.ProcessEnv): Buffer => {
  if (!enabled) return Buffer.alloc(0);

  const secretFromEnv = env.AUTH_SESSION_SECRET;
  if (secretFromEnv && secretFromEnv.trim().length > 0) {
    return Buffer.from(secretFromEnv, "utf8");
  }

  const generated = crypto.randomBytes(32);
  const envLabel = env.NODE_ENV ? ` (${env.NODE_ENV})` : "";
  console.warn(
    `[security] AUTH_SESSION_SECRET is not set${envLabel}. ` +
      "Using an ephemeral per-process secret. Sessions will be invalidated on restart."
  );
  return generated;
};

export const buildAuthConfig = (env: NodeJS.ProcessEnv = process.env): AuthConfig => {
  const sessionTtlHours = parseSessionTtlHours(env.AUTH_SESSION_TTL_HOURS);
  const cookieName = (env.AUTH_COOKIE_NAME || DEFAULT_COOKIE_NAME).trim();
  const cookieSameSite = parseSameSite(env.AUTH_COOKIE_SAMESITE);
  const minPasswordLength = parseMinPasswordLength(env.AUTH_MIN_PASSWORD_LENGTH);

  return {
    enabled: true,
    sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,
    cookieName: cookieName.length > 0 ? cookieName : DEFAULT_COOKIE_NAME,
    cookieSameSite,
    secret: resolveAuthSecret(true, env),
    minPasswordLength,
  };
};

const signToken = (secret: Buffer, payloadB64: string): Buffer =>
  crypto.createHmac("sha256", secret).update(payloadB64, "utf8").digest();

const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 64;
const PASSWORD_SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

export const hashPassword = (password: string): string => {
  const salt = crypto.randomBytes(PASSWORD_SALT_BYTES);
  const derived = crypto.scryptSync(password, salt, PASSWORD_HASH_BYTES, PASSWORD_SCRYPT_OPTIONS);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
};

export const verifyPassword = (password: string, storedHash: string): boolean => {
  const [saltHex, derivedHex] = storedHash.split(":");
  if (!saltHex || !derivedHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const derived = crypto.scryptSync(password, salt, PASSWORD_HASH_BYTES, PASSWORD_SCRYPT_OPTIONS);
  const expected = Buffer.from(derivedHex, "hex");
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
};

export const isPasswordValid = (config: AuthConfig, password: string): boolean => {
  if (typeof password !== "string") return false;
  return password.trim().length >= config.minPasswordLength;
};

export const isEmailValid = (value: string | null | undefined): boolean => {
  if (!value) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
};

export const isUsernameValid = (value: string | null | undefined): boolean => {
  if (!value) return false;
  return /^[a-zA-Z0-9._-]+$/.test(value.trim());
};

export const generateRandomPassword = (length: number = 32): string => {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}|;:,.<>?";
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
};

export const createAuthSessionToken = (config: AuthConfig, userId: string): string => {
  if (!config.enabled) {
    throw new Error("Authentication is not enabled.");
  }

  const issuedAt = Date.now();
  const payload: AuthSession = {
    userId,
    iat: issuedAt,
    exp: issuedAt + config.sessionTtlMs,
  };

  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(payloadJson);
  const sigB64 = base64UrlEncode(signToken(config.secret, payloadB64));

  return `${payloadB64}.${sigB64}`;
};

export const validateAuthSessionToken = (
  config: AuthConfig,
  token: string | undefined | null
): AuthSession | null => {
  if (!config.enabled || !token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [payloadB64, sigB64] = parts;
  try {
    const expectedSig = signToken(config.secret, payloadB64);
    const providedSig = base64UrlDecode(sigB64);
    if (providedSig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;

    const payloadJson = base64UrlDecode(payloadB64).toString("utf8");
    const payload = JSON.parse(payloadJson) as Partial<AuthSession>;
    if (
      typeof payload.userId !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (Date.now() > payload.exp) {
      return null;
    }

    return payload as AuthSession;
  } catch {
    return null;
  }
};

export const parseCookieHeader = (
  cookieHeader: string | undefined
): Record<string, string> => {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce<Record<string, string>>((acc, part) => {
    const [rawKey, ...rest] = part.trim().split("=");
    if (!rawKey) return acc;
    const value = rest.join("=");
    acc[decodeURIComponent(rawKey)] = decodeURIComponent(value || "");
    return acc;
  }, {});
};

export const getAuthSessionFromCookie = (
  cookieHeader: string | undefined,
  config: AuthConfig
): AuthSession | null => {
  if (!config.enabled) return null;
  const cookies = parseCookieHeader(cookieHeader);
  const token = cookies[config.cookieName];
  return validateAuthSessionToken(config, token);
};

export const buildAuthIdentifier = (user: { username?: string | null; email?: string | null }) =>
  user.username || user.email || "";

export const buildAuthCookieOptions = (
  secure: boolean,
  sameSite: AuthSameSite,
  maxAgeMs?: number
) => {
  const normalizedSameSite = sameSite === "none" ? "none" : sameSite;
  const options: {
    httpOnly: boolean;
    sameSite: AuthSameSite;
    secure: boolean;
    path: string;
    maxAge?: number;
  } = {
    httpOnly: true,
    sameSite: normalizedSameSite,
    secure: normalizedSameSite === "none" ? true : secure,
    path: "/",
  };
  if (typeof maxAgeMs === "number" && Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
    options.maxAge = maxAgeMs;
  }
  return options;
};
