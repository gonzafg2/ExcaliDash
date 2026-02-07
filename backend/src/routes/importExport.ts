import express from "express";
import path from "path";
import { promises as fsPromises } from "fs";
import archiver from "archiver";
import JSZip from "jszip";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { Prisma, PrismaClient } from "../generated/client";
import { sanitizeDrawingData } from "../security";

class ImportValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ImportValidationError";
    this.status = status;
  }
}

const excalidashManifestSchemaV1 = z.object({
  format: z.literal("excalidash"),
  formatVersion: z.literal(1),
  exportedAt: z.string().min(1),
  excalidashBackendVersion: z.string().optional(),
  userId: z.string().optional(),
  unorganizedFolder: z.string().min(1),
  collections: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      folder: z.string().min(1),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
    })
  ),
  drawings: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      filePath: z.string().min(1),
      collectionId: z.string().nullable(),
      version: z.number().int().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
    })
  ),
});

type RegisterImportExportDeps = {
  app: express.Express;
  prisma: PrismaClient;
  requireAuth: express.RequestHandler;
  asyncHandler: <T = void>(
    fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<T>
  ) => express.RequestHandler;
  upload: any;
  uploadDir: string;
  backendRoot: string;
  getBackendVersion: () => string;
  parseJsonField: <T>(rawValue: string | null | undefined, fallback: T) => T;
  sanitizeText: (input: unknown, maxLength?: number) => string;
  validateImportedDrawing: (data: unknown) => boolean;
  ensureTrashCollection: (
    db: Prisma.TransactionClient | PrismaClient,
    userId: string
  ) => Promise<void>;
  invalidateDrawingsCache: () => void;
  removeFileIfExists: (filePath?: string) => Promise<void>;
  verifyDatabaseIntegrityAsync: (filePath: string) => Promise<boolean>;
  MAX_IMPORT_ARCHIVE_ENTRIES: number;
  MAX_IMPORT_COLLECTIONS: number;
  MAX_IMPORT_DRAWINGS: number;
  MAX_IMPORT_MANIFEST_BYTES: number;
  MAX_IMPORT_DRAWING_BYTES: number;
  MAX_IMPORT_TOTAL_EXTRACTED_BYTES: number;
};

const getZipEntries = (zip: JSZip) => Object.values(zip.files).filter((entry) => !entry.dir);

const normalizeArchivePath = (filePath: string): string =>
  path.posix.normalize(filePath.replace(/\\/g, "/"));

const assertSafeArchivePath = (filePath: string) => {
  const normalized = normalizeArchivePath(filePath);
  if (
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("\0")
  ) {
    throw new ImportValidationError(`Unsafe archive path: ${filePath}`);
  }
};

const assertSafeZipArchive = (zip: JSZip, maxEntries: number) => {
  const entries = getZipEntries(zip);
  if (entries.length > maxEntries) {
    throw new ImportValidationError("Archive contains too many files");
  }
  for (const entry of entries) {
    assertSafeArchivePath(entry.name);
  }
};

const getSafeZipEntry = (zip: JSZip, filePath: string) => {
  const normalizedPath = normalizeArchivePath(filePath);
  assertSafeArchivePath(normalizedPath);
  return zip.file(normalizedPath);
};

const sanitizePathSegment = (input: string, fallback: string): string => {
  const value = typeof input === "string" ? input.trim() : "";
  const cleaned = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
};

const makeUniqueName = (base: string, used: Set<string>): string => {
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}__${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
};

const findSqliteTable = (tables: string[], candidates: string[]): string | null => {
  const byLower = new Map(tables.map((t) => [t.toLowerCase(), t]));
  for (const candidate of candidates) {
    const found = byLower.get(candidate.toLowerCase());
    if (found) return found;
  }
  return null;
};

const parseOptionalJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  if (typeof raw === "object" && raw !== null) {
    return raw as T;
  }
  return fallback;
};

const isPathInsideDirectory = (candidatePath: string, rootDir: string): boolean => {
  const relativePath = path.relative(rootDir, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
};

const isSafeMulterTempFilename = (value: string): boolean =>
  /^[a-f0-9]{32}$/.test(value);

const resolveSafeUploadedFilePath = async (
  fileMeta: { filename?: unknown },
  uploadRoot: string
): Promise<string> => {
  const absoluteUploadRoot = path.resolve(uploadRoot);
  let canonicalUploadRoot = absoluteUploadRoot;

  try {
    canonicalUploadRoot = await fsPromises.realpath(absoluteUploadRoot);
  } catch {
    throw new ImportValidationError("Invalid upload path");
  }

  const filename = typeof fileMeta.filename === "string" ? fileMeta.filename : "";
  if (!isSafeMulterTempFilename(filename)) {
    throw new ImportValidationError("Invalid upload path");
  }

  const joinedPath = path.resolve(canonicalUploadRoot, filename);
  if (!isPathInsideDirectory(joinedPath, canonicalUploadRoot)) {
    throw new ImportValidationError("Invalid upload path");
  }

  return joinedPath;
};

const openReadonlySqliteDb = (filePath: string): any => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require("node:sqlite") as any;
    return new DatabaseSync(filePath, {
      readOnly: true,
      enableForeignKeyConstraints: false,
    });
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3") as any;
    return new Database(filePath, { readonly: true, fileMustExist: true });
  }
};

const getCurrentLatestPrismaMigrationName = async (backendRoot: string): Promise<string | null> => {
  try {
    const migrationsDir = path.resolve(backendRoot, "prisma/migrations");
    const entries = await fsPromises.readdir(migrationsDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !name.startsWith("."));
    if (dirs.length === 0) return null;
    dirs.sort();
    return dirs[dirs.length - 1] || null;
  } catch {
    return null;
  }
};

export const registerImportExportRoutes = (deps: RegisterImportExportDeps) => {
  const {
    app,
    prisma,
    requireAuth,
    asyncHandler,
    upload,
    uploadDir,
    backendRoot,
    getBackendVersion,
    parseJsonField,
    sanitizeText,
    validateImportedDrawing,
    ensureTrashCollection,
    invalidateDrawingsCache,
    removeFileIfExists,
    verifyDatabaseIntegrityAsync,
    MAX_IMPORT_ARCHIVE_ENTRIES,
    MAX_IMPORT_COLLECTIONS,
    MAX_IMPORT_DRAWINGS,
    MAX_IMPORT_MANIFEST_BYTES,
    MAX_IMPORT_DRAWING_BYTES,
    MAX_IMPORT_TOTAL_EXTRACTED_BYTES,
  } = deps;

  app.get("/export/excalidash", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const extParam = typeof req.query.ext === "string" ? req.query.ext.toLowerCase() : "";
    const zipSuffix = extParam === "zip";
    const date = new Date().toISOString().split("T")[0];
    const filename = zipSuffix
      ? `excalidash-backup-${date}.excalidash.zip`
      : `excalidash-backup-${date}.excalidash`;

    const exportedAt = new Date().toISOString();
    const drawings = await prisma.drawing.findMany({
      where: { userId: req.user.id },
      include: { collection: true },
    });
    const userCollections = await prisma.collection.findMany({
      where: { userId: req.user.id },
    });

    const hasTrashDrawings = drawings.some((d) => d.collectionId === "trash");
    const collectionsToExport = [...userCollections];
    if (hasTrashDrawings && !collectionsToExport.some((c) => c.id === "trash")) {
      const trash = await prisma.collection.findUnique({ where: { id: "trash" } });
      if (trash) collectionsToExport.push(trash);
    }

    const exportSource = `${req.protocol}://${req.get("host")}`;
    const usedFolderNames = new Set<string>();
    const unorganizedFolder = makeUniqueName("Unorganized", usedFolderNames);
    const folderByCollectionId = new Map<string, string>();
    for (const collection of collectionsToExport) {
      const base = sanitizePathSegment(collection.name, "Collection");
      const folder = makeUniqueName(base, usedFolderNames);
      folderByCollectionId.set(collection.id, folder);
    }

    type DrawingWithCollection = Prisma.DrawingGetPayload<{ include: { collection: true } }>;
    const drawingsManifest = drawings.map((drawing: DrawingWithCollection) => {
      const folder = drawing.collectionId
        ? folderByCollectionId.get(drawing.collectionId) || unorganizedFolder
        : unorganizedFolder;
      const fileNameBase = sanitizePathSegment(drawing.name, "Untitled");
      const fileName = `${fileNameBase}__${drawing.id.slice(0, 8)}.excalidraw`;
      return {
        id: drawing.id,
        name: drawing.name,
        filePath: `${folder}/${fileName}`,
        collectionId: drawing.collectionId ?? null,
        version: drawing.version,
        createdAt: drawing.createdAt.toISOString(),
        updatedAt: drawing.updatedAt.toISOString(),
      };
    });

    const manifest = {
      format: "excalidash" as const,
      formatVersion: 1 as const,
      exportedAt,
      excalidashBackendVersion: getBackendVersion(),
      userId: req.user.id,
      unorganizedFolder,
      collections: collectionsToExport.map((c) => ({
        id: c.id,
        name: c.name,
        folder: folderByCollectionId.get(c.id) || sanitizePathSegment(c.name, "Collection"),
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
      drawings: drawingsManifest,
    };

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("Archive error:", err);
      res.status(500).json({ error: "Failed to create archive" });
    });
    archive.pipe(res);

    archive.append(JSON.stringify(manifest, null, 2), { name: "excalidash.manifest.json" });

    const drawingsManifestById = new Map(drawingsManifest.map((d) => [d.id, d]));
    for (const drawing of drawings) {
      const meta = drawingsManifestById.get(drawing.id);
      if (!meta) continue;
      const drawingData = {
        type: "excalidraw" as const,
        version: 2 as const,
        source: exportSource,
        elements: parseJsonField(drawing.elements, [] as unknown[]),
        appState: parseJsonField(drawing.appState, {} as Record<string, unknown>),
        files: parseJsonField(drawing.files, {} as Record<string, unknown>),
        excalidash: {
          drawingId: drawing.id,
          collectionId: drawing.collectionId ?? null,
          exportedAt,
        },
      };
      assertSafeArchivePath(meta.filePath);
      archive.append(JSON.stringify(drawingData, null, 2), { name: meta.filePath });
    }

    const readme = `ExcaliDash Backup (.excalidash)

This file is a zip archive containing a versioned ExcaliDash manifest and your drawings,
organized into folders by collection.

Files:
- excalidash.manifest.json (required)
- <Collection Folder>/*.excalidraw

ExportedAt: ${exportedAt}
FormatVersion: 1
BackendVersion: ${getBackendVersion()}
Collections: ${collectionsToExport.length}
Drawings: ${drawings.length}
`;
    archive.append(readme, { name: "README.txt" });
    await archive.finalize();
  }));

  app.post("/import/excalidash/verify", requireAuth, upload.single("archive"), asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    let stagedPath: string;
    try {
      stagedPath = await resolveSafeUploadedFilePath(
        { filename: req.file.filename },
        uploadDir
      );
    } catch (error) {
      if (error instanceof ImportValidationError) {
        return res.status(error.status).json({ error: "Invalid upload", message: error.message });
      }
      throw error;
    }
    try {
      const buffer = await fsPromises.readFile(stagedPath);
      const zip = await JSZip.loadAsync(buffer);
      try {
        assertSafeZipArchive(zip, MAX_IMPORT_ARCHIVE_ENTRIES);
      } catch (error) {
        if (error instanceof ImportValidationError) {
          return res.status(error.status).json({ error: "Invalid backup", message: error.message });
        }
        throw error;
      }

      const manifestFile = getSafeZipEntry(zip, "excalidash.manifest.json");
      if (!manifestFile) {
        return res.status(400).json({ error: "Invalid backup", message: "Missing excalidash.manifest.json" });
      }
      const rawManifest = await manifestFile.async("string");
      if (Buffer.byteLength(rawManifest, "utf8") > MAX_IMPORT_MANIFEST_BYTES) {
        return res.status(400).json({
          error: "Invalid backup manifest",
          message: "excalidash.manifest.json is too large",
        });
      }

      let manifestJson: unknown;
      try {
        manifestJson = JSON.parse(rawManifest);
      } catch {
        return res.status(400).json({
          error: "Invalid backup manifest",
          message: "excalidash.manifest.json is not valid JSON",
        });
      }
      const parsed = excalidashManifestSchemaV1.safeParse(manifestJson);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid backup manifest",
          message: "Malformed excalidash.manifest.json",
        });
      }
      const manifest = parsed.data;
      if (manifest.collections.length > MAX_IMPORT_COLLECTIONS) {
        return res.status(400).json({
          error: "Invalid backup manifest",
          message: `Too many collections (max ${MAX_IMPORT_COLLECTIONS})`,
        });
      }
      if (manifest.drawings.length > MAX_IMPORT_DRAWINGS) {
        return res.status(400).json({
          error: "Invalid backup manifest",
          message: `Too many drawings (max ${MAX_IMPORT_DRAWINGS})`,
        });
      }
      for (const drawing of manifest.drawings) {
        if (!getSafeZipEntry(zip, drawing.filePath)) {
          return res.status(400).json({
            error: "Invalid backup",
            message: `Missing drawing file: ${drawing.filePath}`,
          });
        }
      }

      return res.json({
        valid: true,
        formatVersion: manifest.formatVersion,
        exportedAt: manifest.exportedAt,
        excalidashBackendVersion: manifest.excalidashBackendVersion || null,
        collections: manifest.collections.length,
        drawings: manifest.drawings.length,
      });
    } finally {
      await removeFileIfExists(stagedPath);
    }
  }));

  app.post("/import/excalidash", requireAuth, upload.single("archive"), asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    let stagedPath: string;
    try {
      stagedPath = await resolveSafeUploadedFilePath(
        { filename: req.file.filename },
        uploadDir
      );
    } catch (error) {
      if (error instanceof ImportValidationError) {
        return res.status(error.status).json({ error: "Invalid upload", message: error.message });
      }
      throw error;
    }
    try {
      const buffer = await fsPromises.readFile(stagedPath);
      const zip = await JSZip.loadAsync(buffer);
      try {
        assertSafeZipArchive(zip, MAX_IMPORT_ARCHIVE_ENTRIES);
      } catch (error) {
        if (error instanceof ImportValidationError) {
          return res.status(error.status).json({ error: "Invalid backup", message: error.message });
        }
        throw error;
      }

      const manifestFile = getSafeZipEntry(zip, "excalidash.manifest.json");
      if (!manifestFile) {
        return res.status(400).json({ error: "Invalid backup", message: "Missing excalidash.manifest.json" });
      }
      const rawManifest = await manifestFile.async("string");
      if (Buffer.byteLength(rawManifest, "utf8") > MAX_IMPORT_MANIFEST_BYTES) {
        return res.status(400).json({
          error: "Invalid backup manifest",
          message: "excalidash.manifest.json is too large",
        });
      }

      let manifestJson: unknown;
      try {
        manifestJson = JSON.parse(rawManifest);
      } catch {
        return res.status(400).json({
          error: "Invalid backup manifest",
          message: "excalidash.manifest.json is not valid JSON",
        });
      }
      const parsed = excalidashManifestSchemaV1.safeParse(manifestJson);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid backup manifest",
          message: "Malformed excalidash.manifest.json",
        });
      }
      const manifest = parsed.data;

      if (manifest.collections.length > MAX_IMPORT_COLLECTIONS) {
        return res.status(400).json({
          error: "Invalid backup manifest",
          message: `Too many collections (max ${MAX_IMPORT_COLLECTIONS})`,
        });
      }
      if (manifest.drawings.length > MAX_IMPORT_DRAWINGS) {
        return res.status(400).json({
          error: "Invalid backup manifest",
          message: `Too many drawings (max ${MAX_IMPORT_DRAWINGS})`,
        });
      }

      type PreparedImportDrawing = {
        id: string;
        name: string;
        version: number | undefined;
        collectionId: string | null;
        sanitized: ReturnType<typeof sanitizeDrawingData>;
      };
      const preparedDrawings: PreparedImportDrawing[] = [];
      let extractedBytes = Buffer.byteLength(rawManifest, "utf8");
      try {
        for (const d of manifest.drawings) {
          const entry = getSafeZipEntry(zip, d.filePath);
          if (!entry) throw new ImportValidationError(`Missing drawing file: ${d.filePath}`);

          const raw = await entry.async("string");
          const rawSize = Buffer.byteLength(raw, "utf8");
          if (rawSize > MAX_IMPORT_DRAWING_BYTES) {
            throw new ImportValidationError(`Drawing is too large: ${d.filePath}`);
          }
          extractedBytes += rawSize;
          if (extractedBytes > MAX_IMPORT_TOTAL_EXTRACTED_BYTES) {
            throw new ImportValidationError("Backup contents exceed maximum import size");
          }

          let parsedJson: any;
          try {
            parsedJson = JSON.parse(raw) as any;
          } catch {
            throw new ImportValidationError(`Drawing JSON is invalid: ${d.filePath}`);
          }

          const imported = {
            name: d.name,
            elements: Array.isArray(parsedJson?.elements) ? parsedJson.elements : [],
            appState:
              typeof parsedJson?.appState === "object" && parsedJson.appState !== null
                ? parsedJson.appState
                : {},
            files:
              typeof parsedJson?.files === "object" && parsedJson.files !== null
                ? parsedJson.files
                : {},
            preview: null as string | null,
            collectionId: d.collectionId,
          };

          if (!validateImportedDrawing(imported)) {
            throw new ImportValidationError(`Drawing failed validation: ${d.filePath}`);
          }

          preparedDrawings.push({
            id: d.id,
            name: sanitizeText(imported.name, 255) || "Untitled Drawing",
            version: typeof d.version === "number" ? d.version : undefined,
            collectionId: d.collectionId,
            sanitized: sanitizeDrawingData(imported),
          });
        }
      } catch (error) {
        if (error instanceof ImportValidationError) {
          return res.status(error.status).json({ error: "Invalid backup", message: error.message });
        }
        throw error;
      }

      const result = await prisma.$transaction(async (tx) => {
        const collectionIdMap = new Map<string, string>();
        let collectionsCreated = 0;
        let collectionsUpdated = 0;
        let collectionIdConflicts = 0;
        let drawingsCreated = 0;
        let drawingsUpdated = 0;
        let drawingIdConflicts = 0;

        const needsTrash =
          manifest.collections.some((c) => c.id === "trash") ||
          preparedDrawings.some((d) => d.collectionId === "trash");
        if (needsTrash) await ensureTrashCollection(tx, req.user!.id);

        for (const c of manifest.collections) {
          if (c.id === "trash") {
            collectionIdMap.set("trash", "trash");
            continue;
          }

          const existing = await tx.collection.findUnique({ where: { id: c.id } });
          if (!existing) {
            await tx.collection.create({
              data: { id: c.id, name: sanitizeText(c.name, 100) || "Collection", userId: req.user!.id },
            });
            collectionIdMap.set(c.id, c.id);
            collectionsCreated += 1;
            continue;
          }

          if (existing.userId === req.user!.id) {
            await tx.collection.update({
              where: { id: c.id },
              data: { name: sanitizeText(c.name, 100) || "Collection" },
            });
            collectionIdMap.set(c.id, c.id);
            collectionsUpdated += 1;
            continue;
          }

          const newId = uuidv4();
          await tx.collection.create({
            data: { id: newId, name: sanitizeText(c.name, 100) || "Collection", userId: req.user!.id },
          });
          collectionIdMap.set(c.id, newId);
          collectionsCreated += 1;
          collectionIdConflicts += 1;
        }

        const resolveCollectionId = (collectionId: string | null): string | null => {
          if (!collectionId) return null;
          if (collectionId === "trash") return "trash";
          return collectionIdMap.get(collectionId) || null;
        };

        for (const prepared of preparedDrawings) {
          const targetCollectionId = resolveCollectionId(prepared.collectionId);
          const existing = await tx.drawing.findUnique({ where: { id: prepared.id } });
          if (!existing) {
            await tx.drawing.create({
              data: {
                id: prepared.id,
                name: prepared.name,
                elements: JSON.stringify(prepared.sanitized.elements),
                appState: JSON.stringify(prepared.sanitized.appState),
                files: JSON.stringify(prepared.sanitized.files || {}),
                preview: prepared.sanitized.preview ?? null,
                version: prepared.version ?? 1,
                userId: req.user!.id,
                collectionId: targetCollectionId,
              },
            });
            drawingsCreated += 1;
            continue;
          }

          if (existing.userId === req.user!.id) {
            await tx.drawing.update({
              where: { id: prepared.id },
              data: {
                name: prepared.name,
                elements: JSON.stringify(prepared.sanitized.elements),
                appState: JSON.stringify(prepared.sanitized.appState),
                files: JSON.stringify(prepared.sanitized.files || {}),
                preview: prepared.sanitized.preview ?? null,
                version: prepared.version ?? existing.version,
                collectionId: targetCollectionId,
              },
            });
            drawingsUpdated += 1;
            continue;
          }

          const newId = uuidv4();
          await tx.drawing.create({
            data: {
              id: newId,
              name: prepared.name,
              elements: JSON.stringify(prepared.sanitized.elements),
              appState: JSON.stringify(prepared.sanitized.appState),
              files: JSON.stringify(prepared.sanitized.files || {}),
              preview: prepared.sanitized.preview ?? null,
              version: prepared.version ?? 1,
              userId: req.user!.id,
              collectionId: targetCollectionId,
            },
          });
          drawingsCreated += 1;
          drawingIdConflicts += 1;
        }

        return {
          collections: { created: collectionsCreated, updated: collectionsUpdated, idConflicts: collectionIdConflicts },
          drawings: { created: drawingsCreated, updated: drawingsUpdated, idConflicts: drawingIdConflicts },
        };
      });

      invalidateDrawingsCache();
      return res.json({ success: true, message: "Backup imported successfully", ...result });
    } finally {
      await removeFileIfExists(stagedPath);
    }
  }));

  app.post("/import/sqlite/legacy/verify", requireAuth, upload.single("db"), asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    let stagedPath: string;
    try {
      stagedPath = await resolveSafeUploadedFilePath(
        { filename: req.file.filename },
        uploadDir
      );
    } catch (error) {
      if (error instanceof ImportValidationError) {
        return res.status(error.status).json({ error: "Invalid upload", message: error.message });
      }
      throw error;
    }
    try {
      const isValid = await verifyDatabaseIntegrityAsync(stagedPath);
      if (!isValid) return res.status(400).json({ error: "Invalid database format" });

      let db: any | null = null;
      try {
        db = openReadonlySqliteDb(stagedPath);
        const tables: string[] = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row: any) => String(row.name));

        const drawingTable = findSqliteTable(tables, ["Drawing", "drawings"]);
        const collectionTable = findSqliteTable(tables, ["Collection", "collections"]);
        if (!drawingTable) {
          return res.status(400).json({ error: "Invalid legacy DB", message: "Missing Drawing table" });
        }

        const drawingsCount = Number(db.prepare(`SELECT COUNT(1) as c FROM "${drawingTable}"`).get()?.c ?? 0);
        const collectionsCount = collectionTable
          ? Number(db.prepare(`SELECT COUNT(1) as c FROM "${collectionTable}"`).get()?.c ?? 0)
          : 0;
        if (drawingsCount > MAX_IMPORT_DRAWINGS) {
          return res.status(400).json({
            error: "Invalid legacy DB",
            message: `Too many drawings (max ${MAX_IMPORT_DRAWINGS})`,
          });
        }
        if (collectionsCount > MAX_IMPORT_COLLECTIONS) {
          return res.status(400).json({
            error: "Invalid legacy DB",
            message: `Too many collections (max ${MAX_IMPORT_COLLECTIONS})`,
          });
        }

        let latestMigration: string | null = null;
        const migrationsTable = findSqliteTable(tables, ["_prisma_migrations"]);
        if (migrationsTable) {
          try {
            const row = db
              .prepare(
                `SELECT migration_name as name, finished_at as finishedAt FROM "${migrationsTable}" ORDER BY finished_at DESC LIMIT 1`
              )
              .get();
            if (row?.name) latestMigration = String(row.name);
          } catch {
            latestMigration = null;
          }
        }

        return res.json({
          valid: true,
          drawings: drawingsCount,
          collections: collectionsCount,
          latestMigration,
          currentLatestMigration: await getCurrentLatestPrismaMigrationName(backendRoot),
        });
      } catch {
        return res.status(500).json({
          error: "Legacy DB support unavailable",
          message:
            "Failed to open the SQLite database for inspection. If you're on Node < 22, you may need to rebuild native dependencies (e.g. `cd backend && npm rebuild better-sqlite3`).",
        });
      } finally {
        try {
          db?.close?.();
        } catch {}
      }
    } finally {
      await removeFileIfExists(stagedPath);
    }
  }));

  app.post("/import/sqlite/legacy", requireAuth, upload.single("db"), asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    let stagedPath: string;
    try {
      stagedPath = await resolveSafeUploadedFilePath(
        { filename: req.file.filename },
        uploadDir
      );
    } catch (error) {
      if (error instanceof ImportValidationError) {
        return res.status(error.status).json({ error: "Invalid upload", message: error.message });
      }
      throw error;
    }
    try {
      const isValid = await verifyDatabaseIntegrityAsync(stagedPath);
      if (!isValid) return res.status(400).json({ error: "Invalid database format" });

      let legacyDb: any | null = null;
      try {
        legacyDb = openReadonlySqliteDb(stagedPath);
        const tables: string[] = legacyDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row: any) => String(row.name));

        const drawingTable = findSqliteTable(tables, ["Drawing", "drawings"]);
        const collectionTable = findSqliteTable(tables, ["Collection", "collections"]);
        if (!drawingTable) {
          return res.status(400).json({ error: "Invalid legacy DB", message: "Missing Drawing table" });
        }

        const importedCollections: any[] = collectionTable
          ? legacyDb.prepare(`SELECT * FROM "${collectionTable}"`).all()
          : [];
        const importedDrawings: any[] = legacyDb.prepare(`SELECT * FROM "${drawingTable}"`).all();

        if (importedCollections.length > MAX_IMPORT_COLLECTIONS) {
          return res.status(400).json({
            error: "Invalid legacy DB",
            message: `Too many collections (max ${MAX_IMPORT_COLLECTIONS})`,
          });
        }
        if (importedDrawings.length > MAX_IMPORT_DRAWINGS) {
          return res.status(400).json({
            error: "Invalid legacy DB",
            message: `Too many drawings (max ${MAX_IMPORT_DRAWINGS})`,
          });
        }

        type PreparedLegacyDrawing = {
          importedId: string | null;
          name: string;
          sanitized: ReturnType<typeof sanitizeDrawingData>;
          collectionIdRaw: unknown;
          collectionNameRaw: unknown;
          versionRaw: unknown;
        };

        const preparedDrawings: PreparedLegacyDrawing[] = [];
        for (const d of importedDrawings) {
          const importPayload = {
            name: typeof d.name === "string" ? d.name : "Untitled Drawing",
            elements: parseOptionalJson<unknown[]>(d.elements, []),
            appState: parseOptionalJson<Record<string, unknown>>(d.appState, {}),
            files: parseOptionalJson<Record<string, unknown>>(d.files, {}),
            preview: typeof d.preview === "string" ? d.preview : null,
            collectionId: null as string | null,
          };

          if (!validateImportedDrawing(importPayload)) {
            return res.status(400).json({
              error: "Invalid imported drawing",
              message: "Legacy database contains invalid drawing data",
            });
          }

          preparedDrawings.push({
            importedId: typeof d.id === "string" ? d.id : null,
            name: sanitizeText(importPayload.name, 255) || "Untitled Drawing",
            sanitized: sanitizeDrawingData(importPayload),
            collectionIdRaw: d.collectionId,
            collectionNameRaw: d.collectionName,
            versionRaw: d.version,
          });
        }

        const result = await prisma.$transaction(async (tx) => {
          const hasTrash = importedDrawings.some((d) => String(d.collectionId || "") === "trash");
          if (hasTrash) await ensureTrashCollection(tx, req.user!.id);

          const collectionIdMap = new Map<string, string>();
          let collectionsCreated = 0;
          let collectionsUpdated = 0;
          let collectionIdConflicts = 0;
          let drawingsCreated = 0;
          let drawingsUpdated = 0;
          let drawingIdConflicts = 0;

          for (const c of importedCollections) {
            const importedId = typeof c.id === "string" ? c.id : null;
            const name = typeof c.name === "string" ? c.name : "Collection";

            if (importedId === "trash" || name === "Trash") {
              collectionIdMap.set(importedId || "trash", "trash");
              continue;
            }

            if (!importedId) {
              const newId = uuidv4();
              await tx.collection.create({
                data: { id: newId, name: sanitizeText(name, 100) || "Collection", userId: req.user!.id },
              });
              collectionIdMap.set(`__name:${name}`, newId);
              collectionsCreated += 1;
              continue;
            }

            const existing = await tx.collection.findUnique({ where: { id: importedId } });
            if (!existing) {
              await tx.collection.create({
                data: { id: importedId, name: sanitizeText(name, 100) || "Collection", userId: req.user!.id },
              });
              collectionIdMap.set(importedId, importedId);
              collectionsCreated += 1;
              continue;
            }
            if (existing.userId === req.user!.id) {
              await tx.collection.update({
                where: { id: importedId },
                data: { name: sanitizeText(name, 100) || "Collection" },
              });
              collectionIdMap.set(importedId, importedId);
              collectionsUpdated += 1;
              continue;
            }

            const newId = uuidv4();
            await tx.collection.create({
              data: { id: newId, name: sanitizeText(name, 100) || "Collection", userId: req.user!.id },
            });
            collectionIdMap.set(importedId, newId);
            collectionsCreated += 1;
            collectionIdConflicts += 1;
          }

          const resolveImportedCollectionId = (
            rawCollectionId: unknown,
            rawCollectionName: unknown
          ): string | null => {
            const id = typeof rawCollectionId === "string" ? rawCollectionId : null;
            const name = typeof rawCollectionName === "string" ? rawCollectionName : null;

            if (id === "trash" || name === "Trash") return "trash";
            if (id && collectionIdMap.has(id)) return collectionIdMap.get(id)!;
            if (name && collectionIdMap.has(`__name:${name}`)) return collectionIdMap.get(`__name:${name}`)!;
            return null;
          };

          for (const d of preparedDrawings) {
            const resolvedCollectionId = resolveImportedCollectionId(d.collectionIdRaw, d.collectionNameRaw);
            const existing = d.importedId ? await tx.drawing.findUnique({ where: { id: d.importedId } }) : null;

            if (!existing) {
              const idToUse = d.importedId || uuidv4();
              await tx.drawing.create({
                data: {
                  id: idToUse,
                  name: d.name,
                  elements: JSON.stringify(d.sanitized.elements),
                  appState: JSON.stringify(d.sanitized.appState),
                  files: JSON.stringify(d.sanitized.files || {}),
                  preview: d.sanitized.preview ?? null,
                  version: Number.isFinite(Number(d.versionRaw)) ? Number(d.versionRaw) : 1,
                  userId: req.user!.id,
                  collectionId: resolvedCollectionId ?? null,
                },
              });
              drawingsCreated += 1;
              continue;
            }

            if (existing.userId === req.user!.id) {
              await tx.drawing.update({
                where: { id: existing.id },
                data: {
                  name: d.name,
                  elements: JSON.stringify(d.sanitized.elements),
                  appState: JSON.stringify(d.sanitized.appState),
                  files: JSON.stringify(d.sanitized.files || {}),
                  preview: d.sanitized.preview ?? null,
                  version: Number.isFinite(Number(d.versionRaw)) ? Number(d.versionRaw) : existing.version,
                  collectionId: resolvedCollectionId ?? null,
                },
              });
              drawingsUpdated += 1;
              continue;
            }

            const newId = uuidv4();
            await tx.drawing.create({
              data: {
                id: newId,
                name: d.name,
                elements: JSON.stringify(d.sanitized.elements),
                appState: JSON.stringify(d.sanitized.appState),
                files: JSON.stringify(d.sanitized.files || {}),
                preview: d.sanitized.preview ?? null,
                version: Number.isFinite(Number(d.versionRaw)) ? Number(d.versionRaw) : 1,
                userId: req.user!.id,
                collectionId: resolvedCollectionId ?? null,
              },
            });
            drawingsCreated += 1;
            drawingIdConflicts += 1;
          }

          return {
            collections: { created: collectionsCreated, updated: collectionsUpdated, idConflicts: collectionIdConflicts },
            drawings: { created: drawingsCreated, updated: drawingsUpdated, idConflicts: drawingIdConflicts },
          };
        });

        invalidateDrawingsCache();
        return res.json({ success: true, ...result });
      } catch {
        return res.status(500).json({
          error: "Legacy DB support unavailable",
          message:
            "Failed to open the SQLite database for import. If you're on Node < 22, you may need to rebuild native dependencies (e.g. `cd backend && npm rebuild better-sqlite3`).",
        });
      } finally {
        try {
          legacyDb?.close?.();
        } catch {}
      }
    } finally {
      await removeFileIfExists(stagedPath);
    }
  }));
};
