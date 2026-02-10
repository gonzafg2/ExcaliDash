import React, { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  authStatus,
  authMe,
  authRefresh,
  authLogout,
  authLogin,
  authRegister,
  isAxiosError,
} from '../api';

interface User {
  id: string;
  username?: string | null;
  email: string;
  name: string;
  role?: "ADMIN" | "USER" | string;
  mustResetPassword?: boolean;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  authEnabled: boolean | null;
  bootstrapRequired: boolean;
  authOnboardingRequired: boolean;
  authOnboardingMode: 'migration' | 'fresh' | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const USER_KEY = 'excalidash-user';
const AUTH_ENABLED_CACHE_KEY = "excalidash-auth-enabled";

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [authOnboardingRequired, setAuthOnboardingRequired] = useState(false);
  const [authOnboardingMode, setAuthOnboardingMode] = useState<'migration' | 'fresh' | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const loadUser = async () => {
      try {
        try {
          const statusResponse = await authStatus();
          const enabled =
            typeof statusResponse?.authEnabled === "boolean"
              ? statusResponse.authEnabled
              : typeof statusResponse?.enabled === "boolean"
                ? statusResponse.enabled
                : true;
          setAuthEnabled(enabled);
          localStorage.setItem(AUTH_ENABLED_CACHE_KEY, String(enabled));
          setBootstrapRequired(Boolean(statusResponse?.bootstrapRequired));
          setAuthOnboardingRequired(Boolean(statusResponse?.authOnboardingRequired));
          setAuthOnboardingMode(
            statusResponse?.authOnboardingMode === 'migration' || statusResponse?.authOnboardingMode === 'fresh'
              ? statusResponse.authOnboardingMode
              : null
          );

          if (!enabled) {
            localStorage.removeItem(USER_KEY);
            setUser(null);
            return;
          }
        } catch {
          const cachedAuthEnabled = localStorage.getItem(AUTH_ENABLED_CACHE_KEY);
          if (cachedAuthEnabled === "false") {
            setAuthEnabled(false);
            setBootstrapRequired(false);
            setAuthOnboardingRequired(false);
            setAuthOnboardingMode(null);
            localStorage.removeItem(USER_KEY);
            setUser(null);
            return;
          }
          setAuthEnabled(true);
          setBootstrapRequired(false);
          setAuthOnboardingRequired(false);
          setAuthOnboardingMode(null);
        }

        const storedUser = localStorage.getItem(USER_KEY);
        if (storedUser) {
          const userData = JSON.parse(storedUser);
          setUser(userData);
        }

        try {
          const response = await authMe();
          setUser(response.user);
          localStorage.setItem(USER_KEY, JSON.stringify(response.user));
        } catch {
          try {
            await authRefresh();
            const userResponse = await authMe();
            setUser(userResponse.user);
            localStorage.setItem(USER_KEY, JSON.stringify(userResponse.user));
          } catch {
            localStorage.removeItem(USER_KEY);
            setUser(null);
          }
        }
      } catch (error) {
        console.error('Failed to load user:', error);
        localStorage.removeItem(USER_KEY);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    loadUser();
  }, []);

  const login = async (email: string, password: string) => {
    try {
      if (authEnabled === false) {
        throw new Error("Authentication is disabled");
      }
      const response = await authLogin(email, password);

      const { user: userData } = response;

      localStorage.setItem(USER_KEY, JSON.stringify(userData));

      setUser(userData);
    } catch (error: unknown) {
      if (isAxiosError(error)) {
        const message =
          typeof error.response?.data === 'object' &&
          error.response.data !== null &&
          'message' in error.response.data &&
          typeof error.response.data.message === 'string'
            ? error.response.data.message
            : 'Login failed';
        throw new Error(message);
      }
      throw error instanceof Error ? error : new Error('Login failed');
    }
  };

  const register = async (email: string, password: string, name: string) => {
    try {
      if (authEnabled === false) {
        throw new Error("Authentication is disabled");
      }
      const response = await authRegister(email, password, name);

      const { user: userData } = response;

      localStorage.setItem(USER_KEY, JSON.stringify(userData));

      setUser(userData);
    } catch (error: unknown) {
      if (isAxiosError(error)) {
        const message =
          typeof error.response?.data === 'object' &&
          error.response.data !== null &&
          'message' in error.response.data &&
          typeof error.response.data.message === 'string'
            ? error.response.data.message
            : 'Registration failed';
        throw new Error(message);
      }
      throw error instanceof Error ? error : new Error('Registration failed');
    }
  };

  const logout = () => {
    void authLogout().catch(() => undefined);
    localStorage.removeItem(USER_KEY);
    setUser(null);
    setTimeout(() => {
      navigate('/login');
    }, 0);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        authEnabled,
        bootstrapRequired,
        authOnboardingRequired,
        authOnboardingMode,
        login,
        register,
        logout,
        isAuthenticated: !!user,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
