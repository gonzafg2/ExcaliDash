import { exportToSvg } from "@excalidraw/excalidraw";
import { api } from "../api";
import { type UploadStatus } from "../context/UploadContext";

type LegacyExportDrawing = {
  id?: string;
  name?: string;
  elements: unknown[];
  appState: Record<string, unknown>;
  files?: Record<string, unknown>;
  collectionId?: string | null;
  collectionName?: string | null;
  createdAt?: string | number;
  updatedAt?: string | number;
  preview?: string | null;
  version?: number;
};

type LegacyExportJson = {
  version?: string;
  exportedAt?: string;
  userId?: string;
  drawings: LegacyExportDrawing[];
};

const isLegacyExportJson = (data: unknown): data is LegacyExportJson => {
  if (typeof data !== "object" || data === null) return false;
  const maybe = data as Record<string, unknown>;
  if (!Array.isArray(maybe.drawings)) return false;
  return true;
};

const coerceTimestamp = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
};

export const importDrawings = async (
  files: File[],
  targetCollectionId: string | null,
  onSuccess?: () => void | Promise<void>,
  onProgress?: (
    fileIndex: number,
    status: UploadStatus,
    progress: number,
    error?: string
  ) => void
) => {
  const drawingFiles = files.filter(
    (f) => f.name.endsWith(".json") || f.name.endsWith(".excalidraw")
  );

  if (drawingFiles.length === 0) {
    return { success: 0, failed: 0, errors: ["No supported files found."] };
  }

  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  // Build a map from drawingFile index to original file index for progress reporting
  const originalIndexMap = new Map<number, number>();
  drawingFiles.forEach((df, i) => {
    const originalIndex = files.indexOf(df);
    originalIndexMap.set(i, originalIndex);
  });

  // We process files in parallel (Promise.all) but we could limit concurrency if needed.
  // For now, full parallel is fine as browser limits connection count anyway.
  await Promise.all(
    drawingFiles.map(async (file, drawingIndex) => {
      const fileIndex = originalIndexMap.get(drawingIndex) ?? drawingIndex;
      try {
        if (onProgress) onProgress(fileIndex, 'processing', 0); // Parsing phase

        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.elements || !data.appState) {
          throw new Error(`Invalid file structure: ${file.name}`);
        }

        const svg = await exportToSvg({
          elements: data.elements,
          appState: {
            ...data.appState,
            exportBackground: true,
            viewBackgroundColor: data.appState.viewBackgroundColor || "#ffffff",
          },
          files: data.files || {},
          exportPadding: 10,
        });

        const payload = {
          name: file.name.replace(/\.(json|excalidraw)$/, ""),
          elements: data.elements,
          appState: data.appState,
          files: data.files || null,
          collectionId: targetCollectionId,
          createdAt: data.createdAt || Date.now(),
          updatedAt: data.updatedAt || Date.now(),
          preview: svg.outerHTML,
        };

        if (onProgress) onProgress(fileIndex, 'uploading', 0);

        await api.post("/drawings", payload, {
          headers: {
            // Backend uses this header to apply stricter validation for imported files.
            "X-Imported-File": "true",
          },
          onUploadProgress: (progressEvent) => {
            if (onProgress && progressEvent.total) {
              const percentCompleted = Math.round(
                (progressEvent.loaded * 100) / progressEvent.total
              );
              onProgress(fileIndex, 'uploading', percentCompleted);
            }
          },
        });

        if (onProgress) onProgress(fileIndex, 'success', 100);
        successCount++;

      } catch (err: any) {
        console.error(`Failed to import ${file.name}:`, err);
        failCount++;
        const errorMessage =
          err?.response?.data?.message ||
          err?.response?.data?.error ||
          err?.message ||
          "Upload failed";
        errors.push(`${file.name}: ${errorMessage}`);
        if (onProgress) onProgress(fileIndex, 'error', 0, errorMessage);
      }
    })
  );

  if (successCount > 0 && onSuccess) {
    await onSuccess();
  }

  return { success: successCount, failed: failCount, errors };
};

/**
 * Legacy import helper.
 * - Supports individual `.excalidraw` / Excalidraw `.json` drawings (same as importDrawings)
 * - Supports legacy ExcaliDash export `.json` with `{ drawings: [...] }`
 */
export const importLegacyFiles = async (
  files: File[],
  targetCollectionId: string | null,
  onSuccess?: () => void | Promise<void>,
  onProgress?: (
    fileIndex: number,
    status: UploadStatus,
    progress: number,
    error?: string
  ) => void
) => {
  const drawingFiles = files.filter(
    (f) => f.name.endsWith(".json") || f.name.endsWith(".excalidraw")
  );

  if (drawingFiles.length === 0) {
    return { success: 0, failed: 0, errors: ["No supported files found."] };
  }

  // If there's a legacy export JSON among the selected files, import it separately.
  // (We still allow mixing with individual .excalidraw files.)
  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  const originalIndexMap = new Map<number, number>();
  drawingFiles.forEach((df, i) => {
    const originalIndex = files.indexOf(df);
    originalIndexMap.set(i, originalIndex);
  });

  // Pre-load existing collections once (for legacy export import mapping by name)
  let existingCollectionsByLowerName: Map<string, string> | null = null;
  const ensureCollectionsIndex = async () => {
    if (existingCollectionsByLowerName) return;
    const response = await api.get<{ id: string; name: string }[]>(
      "/collections"
    );
    existingCollectionsByLowerName = new Map(
      (response.data || [])
        .filter((c) => c && typeof c.name === "string" && typeof c.id === "string")
        .map((c) => [c.name.trim().toLowerCase(), c.id])
    );
  };

  const getOrCreateCollectionIdByName = async (name: string) => {
    await ensureCollectionsIndex();
    const key = name.trim().toLowerCase();
    const existing = existingCollectionsByLowerName!.get(key);
    if (existing) return existing;
    const created = await api.post<{ id: string; name: string }>("/collections", {
      name,
    });
    existingCollectionsByLowerName!.set(key, created.data.id);
    return created.data.id;
  };

  await Promise.all(
    drawingFiles.map(async (file, drawingIndex) => {
      const fileIndex = originalIndexMap.get(drawingIndex) ?? drawingIndex;
      try {
        if (onProgress) onProgress(fileIndex, "processing", 0);

        const text = await file.text();
        const parsed = JSON.parse(text) as unknown;

        if (isLegacyExportJson(parsed)) {
          const exportJson = parsed;
          const drawings = Array.isArray(exportJson.drawings)
            ? exportJson.drawings
            : [];

          if (drawings.length === 0) {
            throw new Error("Legacy export JSON contains no drawings.");
          }

          // Import each drawing entry
          for (let i = 0; i < drawings.length; i += 1) {
            const d = drawings[i] as LegacyExportDrawing;
            const elements = Array.isArray(d.elements) ? (d.elements as any[]) : null;
            const appState =
              typeof d.appState === "object" && d.appState !== null
                ? (d.appState as Record<string, unknown>)
                : null;
            if (!elements || !appState) {
              failCount += 1;
              errors.push(
                `${file.name}: drawing ${i + 1}: Invalid structure (missing elements/appState)`
              );
              continue;
            }

            let collectionId: string | null = null;
            if (targetCollectionId !== null) {
              collectionId = targetCollectionId;
            } else if (d.collectionId === "trash" || d.collectionName === "Trash") {
              collectionId = "trash";
            } else if (typeof d.collectionName === "string" && d.collectionName.trim()) {
              collectionId = await getOrCreateCollectionIdByName(d.collectionName.trim());
            } else {
              collectionId = null;
            }

            const svg = await exportToSvg({
              elements,
              appState: {
                ...appState,
                exportBackground: true,
                viewBackgroundColor:
                  (appState as any).viewBackgroundColor || "#ffffff",
              },
              files: (d.files && typeof d.files === "object" ? d.files : {}) as any,
              exportPadding: 10,
            });

            const payload = {
              name:
                typeof d.name === "string" && d.name.trim().length > 0
                  ? d.name
                  : `Imported Drawing ${i + 1}`,
              elements,
              appState,
              files: d.files || null,
              collectionId,
              createdAt: coerceTimestamp(d.createdAt),
              updatedAt: coerceTimestamp(d.updatedAt),
              preview: svg.outerHTML,
            };

            await api.post("/drawings", payload, {
              headers: {
                "X-Imported-File": "true",
              },
            });

            successCount += 1;
          }

          if (onProgress) onProgress(fileIndex, "success", 100);
          return;
        }

        // Single Excalidraw drawing json
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as any).elements &&
          (parsed as any).appState
        ) {
          const mappedOnProgress = onProgress
            ? (_idx: number, status: UploadStatus, progress: number, error?: string) =>
                onProgress(fileIndex, status, progress, error)
            : undefined;
          const result = await importDrawings(
            [file],
            targetCollectionId,
            undefined,
            mappedOnProgress
          );
          successCount += result.success;
          failCount += result.failed;
          errors.push(...result.errors);
          return;
        }

        throw new Error(`Invalid file structure: ${file.name}`);
      } catch (err: any) {
        console.error(`Failed to import ${file.name}:`, err);
        failCount += 1;
        const errorMessage =
          err?.response?.data?.message ||
          err?.response?.data?.error ||
          err?.message ||
          "Upload failed";
        errors.push(`${file.name}: ${errorMessage}`);
        if (onProgress) onProgress(fileIndex, "error", 0, errorMessage);
      }
    })
  );

  if (successCount > 0 && onSuccess) {
    await onSuccess();
  }

  return { success: successCount, failed: failCount, errors };
};
