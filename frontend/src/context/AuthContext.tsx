import React, { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || "/api";

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

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const navigate = useNavigate();

  // Load user from localStorage on mount
  useEffect(() => {
    const loadUser = async () => {
      try {
        // Determine auth mode first (single-user mode vs multi-user auth).
        try {
          const statusResponse = await axios.get(`${API_URL}/auth/status`);
          const enabled =
            typeof statusResponse.data?.authEnabled === "boolean"
              ? statusResponse.data.authEnabled
              : typeof statusResponse.data?.enabled === "boolean"
                ? statusResponse.data.enabled
                : true;
          setAuthEnabled(enabled);
          setBootstrapRequired(Boolean(statusResponse.data?.bootstrapRequired));

          // In single-user mode, do not require login.
          if (!enabled) {
            setUser(null);
            return;
          }
        } catch {
          // If status fails (backend down / schema mismatch), avoid locking the UI
          // behind login. Backend still enforces auth when enabled.
          setAuthEnabled(false);
          setBootstrapRequired(false);
          setUser(null);
          return;
        }

        const storedUser = localStorage.getItem(USER_KEY);
        const storedToken = localStorage.getItem(TOKEN_KEY);

        if (storedUser && storedToken) {
          const userData = JSON.parse(storedUser);
          setUser(userData);
          
          // Verify token is still valid by fetching user info
          try {
            const response = await axios.get(`${API_URL}/auth/me`, {
              headers: {
                Authorization: `Bearer ${storedToken}`,
              },
            });
            setUser(response.data.user);
          } catch (error) {
            // Token invalid, try refresh
            const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
            if (refreshToken) {
              try {
                const refreshResponse = await axios.post(`${API_URL}/auth/refresh`, {
                  refreshToken,
                });
                localStorage.setItem(TOKEN_KEY, refreshResponse.data.accessToken);
                const userResponse = await axios.get(`${API_URL}/auth/me`, {
                  headers: {
                    Authorization: `Bearer ${refreshResponse.data.accessToken}`,
                  },
                });
                setUser(userResponse.data.user);
              } catch {
                // Refresh failed, clear auth but don't navigate during initial load
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(REFRESH_TOKEN_KEY);
                localStorage.removeItem(USER_KEY);
                setUser(null);
              }
            } else {
              // No refresh token, clear auth
              localStorage.removeItem(TOKEN_KEY);
              localStorage.removeItem(REFRESH_TOKEN_KEY);
              localStorage.removeItem(USER_KEY);
              setUser(null);
            }
          }
        }
      } catch (error) {
        console.error('Failed to load user:', error);
        // Clear auth on error
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
      const response = await axios.post(`${API_URL}/auth/login`, {
        email,
        password,
      });

      const { user: userData, accessToken, refreshToken } = response.data;

      localStorage.setItem(TOKEN_KEY, accessToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
      localStorage.setItem(USER_KEY, JSON.stringify(userData));

      setUser(userData);
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
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
      const response = await axios.post(`${API_URL}/auth/register`, {
        email,
        password,
        name,
      });

      const { user: userData, accessToken, refreshToken } = response.data;

      localStorage.setItem(TOKEN_KEY, accessToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
      localStorage.setItem(USER_KEY, JSON.stringify(userData));

      setUser(userData);
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
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
    // Navigate to login - use setTimeout to ensure Router is ready
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
