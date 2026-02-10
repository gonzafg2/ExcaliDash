import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const location = useLocation();
  const {
    isAuthenticated,
    loading,
    authEnabled,
    bootstrapRequired,
    authOnboardingRequired,
    user,
  } = useAuth();

  if (loading || authEnabled === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-600 dark:text-gray-400">Loading...</div>
      </div>
    );
  }

  if (authOnboardingRequired && location.pathname !== '/auth-setup') {
    return <Navigate to="/auth-setup" replace />;
  }

  // Single-user mode: auth disabled -> allow access.
  if (!authEnabled) {
    return <>{children}</>;
  }

  if (!isAuthenticated) {
    // If auth is enabled but no admin exists yet, force bootstrap registration.
    if (bootstrapRequired) {
      return <Navigate to="/register" replace />;
    }
    return <Navigate to="/login" replace />;
  }

  // Force password reset before allowing app access.
  if (user?.mustResetPassword && location.pathname !== '/login') {
    return <Navigate to="/login?mustReset=1" replace />;
  }

  return <>{children}</>;
};
