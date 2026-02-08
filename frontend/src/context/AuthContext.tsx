import React, { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  authStatus,
  authMe,
  authRefresh,
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
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_KEY = 'excalidash-access-token';
const REFRESH_TOKEN_KEY = 'excalidash-refresh-token';
const USER_KEY = 'excalidash-user';
const AUTH_ENABLED_CACHE_KEY = "excalidash-auth-enabled";

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
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

          if (!enabled) {
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(REFRESH_TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
            setUser(null);
            return;
          }
        } catch {
          const cachedAuthEnabled = localStorage.getItem(AUTH_ENABLED_CACHE_KEY);
          if (cachedAuthEnabled === "false") {
            setAuthEnabled(false);
            setBootstrapRequired(false);
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(REFRESH_TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
            setUser(null);
            return;
          }
          setAuthEnabled(true);
          setBootstrapRequired(false);
        }

        const storedUser = localStorage.getItem(USER_KEY);
        const storedToken = localStorage.getItem(TOKEN_KEY);

        if (storedUser && storedToken) {
          const userData = JSON.parse(storedUser);
          setUser(userData);

          try {
            const response = await authMe(storedToken);
            setUser(response.user);
          } catch {
            const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
            if (refreshToken) {
              try {
                const refreshResponse = await authRefresh(refreshToken);
                localStorage.setItem(TOKEN_KEY, refreshResponse.accessToken);
                if (refreshResponse.refreshToken) {
                  localStorage.setItem(REFRESH_TOKEN_KEY, refreshResponse.refreshToken);
                }
                const userResponse = await authMe(refreshResponse.accessToken);
                setUser(userResponse.user);
              } catch {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(REFRESH_TOKEN_KEY);
                localStorage.removeItem(USER_KEY);
                setUser(null);
              }
            } else {
              localStorage.removeItem(TOKEN_KEY);
              localStorage.removeItem(REFRESH_TOKEN_KEY);
              localStorage.removeItem(USER_KEY);
              setUser(null);
            }
          }
        }
      } catch (error) {
        console.error('Failed to load user:', error);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(REFRESH_TOKEN_KEY);
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

      const { user: userData, accessToken, refreshToken } = response;

      localStorage.setItem(TOKEN_KEY, accessToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
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

      const { user: userData, accessToken, refreshToken } = response;

      localStorage.setItem(TOKEN_KEY, accessToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
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
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
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
