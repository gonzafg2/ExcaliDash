export const ACCESS_TOKEN_KEY = 'excalidash-access-token';
export const REFRESH_TOKEN_KEY = 'excalidash-refresh-token';
export const USER_KEY = 'excalidash-user';
export const IMPERSONATION_KEY = 'excalidash-impersonation';

export type ImpersonationState = {
  original: {
    accessToken: string;
    refreshToken: string;
    user: unknown;
  };
  impersonator: {
    id: string;
    email: string;
    name: string;
  };
  target: {
    id: string;
    email: string;
    name: string;
  };
  startedAt: string;
};

export const readImpersonationState = (): ImpersonationState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(IMPERSONATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImpersonationState;
    if (!parsed?.original?.accessToken || !parsed?.original?.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const stopImpersonation = (): boolean => {
  const state = readImpersonationState();
  if (!state) return false;
  localStorage.setItem(ACCESS_TOKEN_KEY, state.original.accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, state.original.refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(state.original.user));
  localStorage.removeItem(IMPERSONATION_KEY);
  return true;
};

