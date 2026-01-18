import React from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { Login } from "../pages/Login";

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { state } = useAuth();

  if (state.loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F3F4F6] dark:bg-neutral-950 text-slate-700 dark:text-neutral-200 transition-colors duration-200">
        <Loader2 className="h-8 w-8 animate-spin mb-3" />
        <p className="text-sm font-semibold">Loading session...</p>
      </div>
    );
  }

  if (state.statusError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F3F4F6] dark:bg-neutral-950 text-slate-700 dark:text-neutral-200 transition-colors duration-200 px-4 text-center">
        <p className="text-sm font-semibold mb-2">{state.statusError}</p>
        <p className="text-xs text-slate-500 dark:text-neutral-400">Please refresh to try again.</p>
      </div>
    );
  }

  if (state.enabled && (!state.authenticated || state.user?.mustResetPassword)) {
    return <Login />;
  }

  return <>{children}</>;
};
