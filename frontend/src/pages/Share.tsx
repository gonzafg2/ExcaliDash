import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2, AlertTriangle, ArrowRight } from "lucide-react";
import clsx from "clsx";
import * as api from "../api";

const parseTokenFromHash = (hash: string): string | null => {
  const raw = (hash || "").startsWith("#") ? (hash || "").slice(1) : (hash || "");
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const t = params.get("t");
  return t && t.trim().length > 0 ? t.trim() : null;
};

export const Share: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const token = useMemo(() => parseTokenFromHash(window.location.hash), []);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsToken = !token || !id;

  const handleExchange = useCallback(async () => {
    if (!id || !token) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await api.exchangeShareLink({
        drawingId: id,
        token,
      });
      // Remove token from URL after exchange.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      navigate(`/shared/${id}`);
    } catch (err: unknown) {
      let message = "Failed to open share link";
      if (api.isAxiosError(err)) {
        const serverMessage =
          typeof err.response?.data?.message === "string" ? err.response.data.message : null;
        if (serverMessage) message = serverMessage;
      }
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [id, token, navigate]);

  useEffect(() => {
    if (id && token) {
      void handleExchange();
    }
  }, [id, token, handleExchange]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-neutral-950 flex items-center justify-center px-4 relative overflow-hidden">
      {/* Background Dots */}
      <div className="absolute inset-0 opacity-[0.3] bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] [background-size:24px_24px]"></div>

      <div className="w-full max-w-md bg-white dark:bg-neutral-900 border-2 border-black dark:border-neutral-700 rounded-2xl shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,0.1)] p-8 relative z-10 animate-in fade-in zoom-in-95 duration-300">
        <h1 className="text-2xl font-black text-slate-900 dark:text-neutral-100 uppercase tracking-tight">Open Shared Drawing</h1>
        <p className="mt-3 text-sm font-bold text-slate-500 dark:text-neutral-400">
          Opening the share link will grant access in this browser session.
        </p>

        {needsToken ? (
          <div className="mt-6 p-4 rounded-xl bg-rose-50 dark:bg-rose-900/20 border-2 border-rose-600 dark:border-rose-500 text-sm font-bold text-rose-600 dark:text-rose-400 flex items-center gap-3">
            <AlertTriangle size={18} strokeWidth={3} />
            Missing share token. Please open the full share link.
          </div>
        ) : (
          <div className="mt-8 space-y-6">
            {error ? (
              <div className="text-sm font-bold text-rose-600 dark:text-rose-400 flex items-center gap-2">
                <AlertTriangle size={16} strokeWidth={3} />
                {error}
              </div>
            ) : null}

            <button
              onClick={() => void handleExchange()}
              disabled={isSubmitting}
              className={clsx(
                "w-full rounded-xl px-6 py-4 font-black text-base uppercase tracking-widest transition-all flex items-center justify-center gap-3 border-2 border-black",
                "bg-indigo-600 text-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] active:translate-y-0 active:shadow-none",
                "disabled:opacity-60 disabled:cursor-not-allowed disabled:shadow-none disabled:translate-y-0"
              )}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="animate-spin" size={20} strokeWidth={3} />
                  Opening...
                </>
              ) : (
                <>
                  Open Drawing
                  <ArrowRight size={20} strokeWidth={3} />
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
