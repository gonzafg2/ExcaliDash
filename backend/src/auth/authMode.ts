import { PrismaClient } from "../generated/client";

export const BOOTSTRAP_USER_ID = "bootstrap-admin";
export const DEFAULT_SYSTEM_CONFIG_ID = "default";

type AuthEnabledCache = {
  value: boolean;
  fetchedAt: number;
};

export type AuthModeService = ReturnType<typeof createAuthModeService>;

export const createAuthModeService = (
  prisma: PrismaClient,
  options?: { authEnabledTtlMs?: number }
) => {
  const authEnabledTtlMs = options?.authEnabledTtlMs ?? 5000;
  let authEnabledCache: AuthEnabledCache | null = null;

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

  const getAuthEnabled = async (): Promise<boolean> => {
    const now = Date.now();
    if (authEnabledCache && now - authEnabledCache.fetchedAt < authEnabledTtlMs) {
      return authEnabledCache.value;
    }

    const systemConfig = await ensureSystemConfig();
    authEnabledCache = { value: systemConfig.authEnabled, fetchedAt: now };
    return systemConfig.authEnabled;
  };

  const clearAuthEnabledCache = () => {
    authEnabledCache = null;
  };

  const getBootstrapActingUser = async () => {
    return prisma.user.upsert({
      where: { id: BOOTSTRAP_USER_ID },
      update: {},
      create: {
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

  return {
    ensureSystemConfig,
    getAuthEnabled,
    clearAuthEnabledCache,
    getBootstrapActingUser,
  };
};
