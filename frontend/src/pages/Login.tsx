import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { Logo } from "../components/Logo";
import { useAuth } from "../context/AuthContext";

export const Login: React.FC = () => {
  const { state, login, register, bootstrapAdmin } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showRegister, setShowRegister] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBootstrap = state.bootstrapRequired;
  const canRegister = state.registrationEnabled;

  const parseIdentifier = () => {
    const trimmed = identifier.trim();
    if (!trimmed) return { username: "", email: "" };
    if (trimmed.includes("@")) {
      return { email: trimmed, username: "" };
    }
    return { username: trimmed, email: "" };
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      if (showRegister || isBootstrap) {
        if (password !== confirmPassword) {
          setError("Passwords do not match.");
          return;
        }
        const { username, email } = parseIdentifier();
        if (!username && !email) {
          setError("Enter a username or email address.");
          return;
        }
        if (isBootstrap) {
          await bootstrapAdmin({ username: username || undefined, email: email || undefined, password });
        } else {
          await register({ username: username || undefined, email: email || undefined, password });
          await login(identifier.trim(), password);
        }
      } else {
        await login(identifier.trim(), password);
      }
    } catch (err) {
      console.error("Auth failed:", err);
      setError("Unable to complete authentication.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F3F4F6] dark:bg-neutral-950 px-4 py-12 transition-colors duration-200">
      <div className="w-full max-w-md bg-white dark:bg-neutral-900 rounded-3xl border-2 border-black dark:border-neutral-700 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] dark:shadow-[6px_6px_0px_0px_rgba(255,255,255,0.2)] p-8">
        <div className="flex flex-col items-center text-center">
          <Logo className="h-16 w-16 mb-4" />
          <h1 className="text-4xl text-slate-900 dark:text-white" style={{ fontFamily: "Excalifont" }}>
            ExcaliDash
          </h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-neutral-400 font-medium">
            {isBootstrap
              ? "Create the initial admin account"
              : showRegister
                ? "Create a new account"
                : "Sign in to access your drawings"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-8 space-y-5">
          <label className="block text-sm font-semibold text-slate-700 dark:text-neutral-200">
            Username or Email
            <input
              type="text"
              name="identifier"
              autoComplete="username"
              required
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              className="mt-2 w-full rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3 text-base text-slate-900 dark:text-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,0.2)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </label>

          <label className="block text-sm font-semibold text-slate-700 dark:text-neutral-200">
            Password
            <input
              type="password"
              name="password"
              autoComplete={showRegister || isBootstrap ? "new-password" : "current-password"}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2 w-full rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3 text-base text-slate-900 dark:text-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,0.2)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </label>

          {(showRegister || isBootstrap) && (
            <label className="block text-sm font-semibold text-slate-700 dark:text-neutral-200">
              Confirm Password
              <input
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="mt-2 w-full rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3 text-base text-slate-900 dark:text-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,0.2)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </label>
          )}

          {error && (
            <p className="text-sm text-rose-600 dark:text-rose-400 font-semibold">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-black dark:border-neutral-700 bg-indigo-600 text-white px-4 py-3 text-base font-bold shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,0.2)] transition-all duration-200 hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSubmitting ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : isBootstrap ? (
              "Create Admin"
            ) : showRegister ? (
              "Create account"
            ) : (
              "Sign in"
            )}
          </button>

          {!isBootstrap && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setShowRegister((prev) => !prev);
              }}
              disabled={!canRegister && !showRegister}
              className="w-full text-sm font-semibold text-slate-600 dark:text-neutral-300 disabled:opacity-50"
            >
              {showRegister
                ? "Back to sign in"
                : canRegister
                  ? "Need an account? Register"
                  : "Registration is disabled"}
            </button>
          )}
        </form>
      </div>
    </div>
  );
};
