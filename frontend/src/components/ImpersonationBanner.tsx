import React, { useEffect, useMemo, useState } from 'react';
import { LogIn, RefreshCw, XCircle } from 'lucide-react';
import { api, isAxiosError } from '../api';
import { useAuth } from '../context/AuthContext';
import {
  IMPERSONATION_KEY,
  USER_KEY,
  readImpersonationState,
  stopImpersonation as restoreImpersonation,
  type ImpersonationState,
} from '../utils/impersonation';

type ImpersonationTarget = {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
};

type ImpersonationTargetsResponse = {
  users: ImpersonationTarget[];
};

type ImpersonateResponse = {
  user: {
    id: string;
    email: string;
    name: string;
  };
};

const normalizeTarget = (target: ImpersonationState['target']): ImpersonationTarget => ({
  id: target.id,
  email: target.email,
  name: target.name,
  role: 'USER',
  isActive: true,
});

export const ImpersonationBanner: React.FC = () => {
  const { authEnabled } = useAuth();
  const [impersonation, setImpersonation] = useState<ImpersonationState | null>(null);
  const [targets, setTargets] = useState<ImpersonationTarget[]>([]);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authEnabled) {
      setImpersonation(null);
      return;
    }

    const sync = () => setImpersonation(readImpersonationState());
    sync();
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [authEnabled]);

  const loadTargets = async () => {
    if (!authEnabled || !impersonation) return;

    setLoadingTargets(true);
    setError('');

    try {
      const response = await api.get<ImpersonationTargetsResponse>('/auth/impersonation-targets');
      setTargets(response.data.users || []);
    } catch (err: unknown) {
      let message = 'Failed to load impersonation targets';
      if (isAxiosError(err)) {
        message = err.response?.data?.message || err.response?.data?.error || message;
      }
      setError(message);
      setTargets([]);
    } finally {
      setLoadingTargets(false);
    }
  };

  useEffect(() => {
    void loadTargets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authEnabled, impersonation?.target.id, impersonation?.impersonator.id]);

  const options = useMemo(() => {
    if (!impersonation) return [];
    const currentTarget = normalizeTarget(impersonation.target);
    const targetMap = new Map<string, ImpersonationTarget>();
    targetMap.set(currentTarget.id, currentTarget);
    for (const user of targets) {
      if (!user?.id) continue;
      targetMap.set(user.id, user);
    }
    return Array.from(targetMap.values()).sort((a, b) => {
      const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      if (byName !== 0) return byName;
      return a.email.localeCompare(b.email, undefined, { sensitivity: 'base' });
    });
  }, [impersonation, targets]);

  const stop = async () => {
    if (!impersonation || busy) return;
    setBusy(true);
    setError('');

    try {
      const response = await api.post<{ user?: { id: string; email: string; name: string } }>('/auth/stop-impersonation');
      restoreImpersonation();
      if (response.data?.user) {
        localStorage.setItem(USER_KEY, JSON.stringify(response.data.user));
      }
      window.location.reload();
    } catch (err: unknown) {
      let message = 'Failed to stop impersonation';
      if (isAxiosError(err)) {
        message = err.response?.data?.message || err.response?.data?.error || message;
      }
      setError(message);
      setBusy(false);
    }
  };

  const switchTarget = async (userId: string) => {
    if (!impersonation || busy || userId === impersonation.target.id) return;

    setBusy(true);
    setError('');

    try {
      const response = await api.post<ImpersonateResponse>('/auth/impersonate', { userId });
      const latest = readImpersonationState() || impersonation;
      const nextState: ImpersonationState = {
        ...latest,
        target: {
          id: response.data.user.id,
          email: response.data.user.email,
          name: response.data.user.name,
        },
        startedAt: new Date().toISOString(),
      };

      localStorage.setItem(IMPERSONATION_KEY, JSON.stringify(nextState));
      localStorage.setItem(USER_KEY, JSON.stringify(response.data.user));
      window.location.reload();
    } catch (err: unknown) {
      let message = 'Failed to switch impersonation user';
      if (isAxiosError(err)) {
        message = err.response?.data?.message || err.response?.data?.error || message;
      }
      setError(message);
      setBusy(false);
    }
  };

  if (!authEnabled || !impersonation) {
    return null;
  }

  return (
    <div className="mb-4 rounded-2xl border-2 border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 sm:p-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.18)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.12)]">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
            <LogIn size={16} />
            <span className="text-sm font-bold uppercase tracking-wide">Impersonating:</span>
          </div>
          <div className="mt-1 text-sm font-semibold text-amber-900 dark:text-amber-200 truncate">
            {impersonation.target.name} ({impersonation.target.email})
          </div>
          <div className="text-xs text-amber-800/90 dark:text-amber-200/80 truncate">
            Acting as this account. Stop to return to {impersonation.impersonator.email}.
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 lg:flex-shrink-0 lg:justify-end">
          <label className="text-xs font-bold uppercase tracking-wide text-amber-900 dark:text-amber-200">
            Switch user:
          </label>
          <select
            value={impersonation.target.id}
            onChange={(e) => {
              void switchTarget(e.target.value);
            }}
            disabled={busy || loadingTargets || options.length === 0}
            className="min-w-[220px] max-w-[320px] px-3 py-2 rounded-xl border-2 border-amber-300 dark:border-amber-700 bg-white dark:bg-neutral-900 text-sm font-semibold text-slate-900 dark:text-neutral-100 outline-none disabled:opacity-70"
          >
            {options.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name} ({target.email})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={stop}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl border-2 border-amber-300 dark:border-amber-700 bg-white dark:bg-neutral-900 text-sm font-bold text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-all disabled:opacity-70"
          >
            <XCircle size={15} />
            Stop
          </button>
        </div>
      </div>

      {(loadingTargets || error) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-medium text-amber-900 dark:text-amber-200">
          {loadingTargets ? (
            <span className="inline-flex items-center gap-1">
              <RefreshCw size={12} className="animate-spin" />
              Loading users...
            </span>
          ) : null}
          {error ? <span>{error}</span> : null}
          {error ? (
            <button
              type="button"
              onClick={() => void loadTargets()}
              className="inline-flex items-center gap-1 rounded-lg border border-amber-300 dark:border-amber-700 px-2 py-1"
            >
              Retry
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
};
