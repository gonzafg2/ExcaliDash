import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as api from "../api";

type AuthState = {
  enabled: boolean;
  authenticated: boolean;
  registrationEnabled: boolean;
  bootstrapRequired: boolean;
  user: { id: string; username: string | null; email: string | null; role: "ADMIN" | "USER" } | null;
  loading: boolean;
  statusError: string | null;
};

type AuthContextValue = {
  state: AuthState;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (payload: { username?: string; email?: string; password: string }) => Promise<void>;
  bootstrapAdmin: (payload: { username?: string; email?: string; password: string }) => Promise<void>;
  setRegistrationEnabled: (enabled: boolean) => Promise<void>;
  updateUserRole: (identifier: string, role: "ADMIN" | "USER") => Promise<void>;
  refreshStatus: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, setState] = useState<AuthState>({
    enabled: false,
    authenticated: false,
    registrationEnabled: false,
    bootstrapRequired: false,
    user: null,
    loading: true,
    statusError: null,
  });

  const refreshStatus = useCallback(async () => {
    setState((prev) => ({
      ...prev,
      loading: true,
    }));
    try {
      const status = await api.getAuthStatus();
      setState({
        enabled: status.enabled,
        authenticated: status.authenticated,
        registrationEnabled: status.registrationEnabled,
        bootstrapRequired: status.bootstrapRequired,
        user: status.user,
        loading: false,
        statusError: null,
      });
    } catch (error) {
      console.error("Failed to fetch auth status:", error);
      setState((prev) => ({
        ...prev,
        authenticated: false,
        user: null,
        loading: false,
        statusError: prev.statusError || "Unable to reach authentication service.",
      }));
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    api.setUnauthorizedHandler(() => {
      setState((prev) => ({
        ...prev,
        authenticated: false,
        user: null,
      }));
    });
    return () => api.setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      await api.login(username, password);
      await refreshStatus();
    },
    [refreshStatus]
  );

  const logout = useCallback(async () => {
    await api.logout();
    await refreshStatus();
  }, [refreshStatus]);

  const register = useCallback(
    async (payload: { username?: string; email?: string; password: string }) => {
      await api.register(payload);
      await refreshStatus();
    },
    [refreshStatus]
  );

  const bootstrapAdmin = useCallback(
    async (payload: { username?: string; email?: string; password: string }) => {
      await api.bootstrapAdmin(payload);
      await refreshStatus();
    },
    [refreshStatus]
  );

  const setRegistrationEnabled = useCallback(
    async (enabled: boolean) => {
      await api.setRegistrationEnabled(enabled);
      await refreshStatus();
    },
    [refreshStatus]
  );

  const updateUserRole = useCallback(
    async (identifier: string, role: "ADMIN" | "USER") => {
      await api.updateUserRole(identifier, role);
      await refreshStatus();
    },
    [refreshStatus]
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      login,
      logout,
      register,
      bootstrapAdmin,
      setRegistrationEnabled,
      updateUserRole,
      refreshStatus,
    }),
    [
      state,
      login,
      logout,
      register,
      bootstrapAdmin,
      setRegistrationEnabled,
      updateUserRole,
      refreshStatus,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
