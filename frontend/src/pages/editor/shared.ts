export interface ElementVersionInfo {
  version: number;
  versionNonce: number;
}

export const haveSameElements = (a: readonly any[] = [], b: readonly any[] = []) => {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.id !== right.id) return false;
    if ((left.version ?? 0) !== (right.version ?? 0)) return false;
    if ((left.versionNonce ?? 0) !== (right.versionNonce ?? 0)) return false;
  }
  return true;
};

const buildFileSignature = (file: any): string => {
  const mimeType = typeof file?.mimeType === "string" ? file.mimeType : "";
  const id = typeof file?.id === "string" ? file.id : "";
  const dataURL = typeof file?.dataURL === "string" ? file.dataURL : "";
  const prefix = dataURL.slice(0, 32);
  const suffix = dataURL.slice(-32);
  return `${id}|${mimeType}|${dataURL.length}|${prefix}|${suffix}`;
};

export const getFilesDelta = (
  previous: Record<string, any>,
  next: Record<string, any>
): Record<string, any> => {
  const delta: Record<string, any> = {};
  const prev = previous || {};
  const nxt = next || {};

  for (const fileId of Object.keys(nxt)) {
    const nextFile = nxt[fileId];
    const nextHasDataUrl = typeof nextFile?.dataURL === "string" && nextFile.dataURL.length > 0;
    if (!nextHasDataUrl) continue;

    const prevFile = prev[fileId];
    if (!prevFile) {
      delta[fileId] = nextFile;
      continue;
    }

    if (buildFileSignature(prevFile) !== buildFileSignature(nextFile)) {
      delta[fileId] = nextFile;
    }
  }

  return delta;
};

export const UIOptions = {
  canvasActions: {
    saveToActiveFile: false,
    loadScene: false,
    export: { saveFileToDisk: false },
    toggleTheme: true,
  },
};

export { getInitialsFromName } from "../../utils/user";

export const getColorFromString = (str: string): string => {
  const COLORS = [
    "#ef4444", "#f97316", "#f59e0b", "#84cc16", "#22c55e", "#10b981",
    "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1", "#8b5cf6",
    "#a855f7", "#d946ef", "#ec4899", "#f43f5e",
  ];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
};
