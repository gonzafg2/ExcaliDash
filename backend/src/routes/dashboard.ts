import express from "express";
import { z } from "zod";
import { Prisma, PrismaClient } from "../generated/client";

type SortField = "name" | "createdAt" | "updatedAt";
type SortDirection = "asc" | "desc";

type BuildDrawingsCacheKey = (keyParts: {
  userId: string;
  searchTerm: string;
  collectionFilter: string;
  includeData: boolean;
  sortField: SortField;
  sortDirection: SortDirection;
}) => string;

type EnsureTrashCollection = (
  db: Prisma.TransactionClient | PrismaClient,
  userId: string
) => Promise<void>;

type LogAuditEvent = (params: {
  userId: string;
  action: string;
  resource?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
}) => Promise<void>;

type DashboardRouteDeps = {
  prisma: PrismaClient;
  requireAuth: express.RequestHandler;
  asyncHandler: <T = void>(
    fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<T>
  ) => express.RequestHandler;
  parseJsonField: <T>(rawValue: string | null | undefined, fallback: T) => T;
  sanitizeText: (input: unknown, maxLength?: number) => string;
  validateImportedDrawing: (data: unknown) => boolean;
  drawingCreateSchema: z.ZodTypeAny;
  drawingUpdateSchema: z.ZodTypeAny;
  respondWithValidationErrors: (res: express.Response, issues: z.ZodIssue[]) => void;
  collectionNameSchema: z.ZodTypeAny;
  ensureTrashCollection: EnsureTrashCollection;
  invalidateDrawingsCache: () => void;
  buildDrawingsCacheKey: BuildDrawingsCacheKey;
  getCachedDrawingsBody: (key: string) => Buffer | null;
  cacheDrawingsResponse: (key: string, payload: unknown) => Buffer;
  MAX_PAGE_SIZE: number;
  config: {
    nodeEnv: string;
    enableAuditLogging: boolean;
  };
  logAuditEvent: LogAuditEvent;
};

export const registerDashboardRoutes = (
  app: express.Express,
  deps: DashboardRouteDeps
) => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    parseJsonField,
    sanitizeText,
    validateImportedDrawing,
    drawingCreateSchema,
    drawingUpdateSchema,
    respondWithValidationErrors,
    collectionNameSchema,
    ensureTrashCollection,
    invalidateDrawingsCache,
    buildDrawingsCacheKey,
    getCachedDrawingsBody,
    cacheDrawingsResponse,
    MAX_PAGE_SIZE,
    config,
    logAuditEvent,
  } = deps;

  const getUserTrashCollectionId = (userId: string): string => `trash:${userId}`;
  const isTrashCollectionId = (
    collectionId: string | null | undefined,
    userId: string
  ): boolean =>
    Boolean(collectionId) &&
    (collectionId === "trash" || collectionId === getUserTrashCollectionId(userId));
  const toInternalTrashCollectionId = (
    collectionId: string | null | undefined,
    userId: string
  ): string | null | undefined =>
    collectionId === "trash" ? getUserTrashCollectionId(userId) : collectionId;
  const toPublicTrashCollectionId = (
    collectionId: string | null | undefined,
    userId: string
  ): string | null | undefined =>
    isTrashCollectionId(collectionId, userId) ? "trash" : collectionId;

  app.get("/drawings", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const trashCollectionId = getUserTrashCollectionId(req.user.id);
    const { search, collectionId, includeData, limit, offset, sortField, sortDirection } = req.query;
    const where: Prisma.DrawingWhereInput = { userId: req.user.id };
    const searchTerm =
      typeof search === "string" && search.trim().length > 0 ? search.trim() : undefined;

    if (searchTerm) {
      where.name = { contains: searchTerm };
    }

    let collectionFilterKey = "default";
    if (collectionId === "null") {
      where.collectionId = null;
      collectionFilterKey = "null";
    } else if (collectionId) {
      const normalizedCollectionId = String(collectionId);
      if (normalizedCollectionId === "trash") {
        where.collectionId = { in: [trashCollectionId, "trash"] };
        collectionFilterKey = "trash";
      } else {
        const collection = await prisma.collection.findFirst({
          where: { id: normalizedCollectionId, userId: req.user.id },
        });
        if (!collection) {
          return res.status(404).json({ error: "Collection not found" });
        }
        where.collectionId = normalizedCollectionId;
        collectionFilterKey = `id:${normalizedCollectionId}`;
      }
    } else {
      where.OR = [
        { collectionId: { notIn: [trashCollectionId, "trash"] } },
        { collectionId: null },
      ];
    }

    const shouldIncludeData =
      typeof includeData === "string"
        ? includeData.toLowerCase() === "true" || includeData === "1"
        : false;
    const parsedSortField: SortField =
      sortField === "name" || sortField === "createdAt" || sortField === "updatedAt"
        ? sortField
        : "updatedAt";
    const parsedSortDirection: SortDirection =
      sortDirection === "asc" || sortDirection === "desc"
        ? sortDirection
        : parsedSortField === "name"
        ? "asc"
        : "desc";

    const rawLimit = limit ? Number.parseInt(limit as string, 10) : undefined;
    const rawOffset = offset ? Number.parseInt(offset as string, 10) : undefined;
    const parsedLimit =
      rawLimit !== undefined && Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE)
        : undefined;
    const parsedOffset =
      rawOffset !== undefined && Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : undefined;

    const cacheKey =
      buildDrawingsCacheKey({
        userId: req.user.id,
        searchTerm: searchTerm ?? "",
        collectionFilter: collectionFilterKey,
        includeData: shouldIncludeData,
        sortField: parsedSortField,
        sortDirection: parsedSortDirection,
      }) + `:${parsedLimit}:${parsedOffset}`;

    const cachedBody = getCachedDrawingsBody(cacheKey);
    if (cachedBody) {
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Content-Type", "application/json");
      return res.send(cachedBody);
    }

    const summarySelect: Prisma.DrawingSelect = {
      id: true,
      name: true,
      collectionId: true,
      preview: true,
      version: true,
      createdAt: true,
      updatedAt: true,
    };

    const orderBy: Prisma.DrawingOrderByWithRelationInput =
      parsedSortField === "name"
        ? { name: parsedSortDirection }
        : parsedSortField === "createdAt"
        ? { createdAt: parsedSortDirection }
        : { updatedAt: parsedSortDirection };

    const queryOptions: Prisma.DrawingFindManyArgs = { where, orderBy };
    if (parsedLimit !== undefined) queryOptions.take = parsedLimit;
    if (parsedOffset !== undefined) queryOptions.skip = parsedOffset;
    if (!shouldIncludeData) queryOptions.select = summarySelect;

    const [drawings, totalCount] = await Promise.all([
      prisma.drawing.findMany(queryOptions),
      prisma.drawing.count({ where }),
    ]);

    let responsePayload: any[] = drawings as any[];
    if (shouldIncludeData) {
      responsePayload = (drawings as any[]).map((d: any) => ({
        ...d,
        collectionId: toPublicTrashCollectionId(d.collectionId, req.user!.id),
        elements: parseJsonField(d.elements, []),
        appState: parseJsonField(d.appState, {}),
        files: parseJsonField(d.files, {}),
      }));
    } else {
      responsePayload = (drawings as any[]).map((d: any) => ({
        ...d,
        collectionId: toPublicTrashCollectionId(d.collectionId, req.user!.id),
      }));
    }

    const finalResponse = {
      drawings: responsePayload,
      totalCount,
      limit: parsedLimit,
      offset: parsedOffset,
    };

    const body = cacheDrawingsResponse(cacheKey, finalResponse);
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Content-Type", "application/json");
    return res.send(body);
  }));

  app.get("/drawings/:id", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
    const drawing = await prisma.drawing.findFirst({
      where: {
        id,
        userId: req.user.id,
      },
    });
    if (!drawing) {
      return res.status(404).json({ error: "Drawing not found", message: "Drawing does not exist" });
    }

    return res.json({
      ...drawing,
      collectionId: toPublicTrashCollectionId(drawing.collectionId, req.user.id),
      elements: parseJsonField(drawing.elements, []),
      appState: parseJsonField(drawing.appState, {}),
      files: parseJsonField(drawing.files, {}),
    });
  }));

  app.post("/drawings", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const isImportedDrawing = req.headers["x-imported-file"] === "true";
    if (isImportedDrawing && !validateImportedDrawing(req.body)) {
      return res.status(400).json({
        error: "Invalid imported drawing file",
        message: "The imported file contains potentially malicious content or invalid structure",
      });
    }

    const parsed = drawingCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondWithValidationErrors(res, parsed.error.issues);
    }

    const payload = parsed.data as {
      name?: string;
      collectionId?: string | null;
      elements: unknown[];
      appState: Record<string, unknown>;
      preview?: string | null;
      files?: Record<string, unknown>;
    };
    const drawingName = payload.name ?? "Untitled Drawing";
    const targetCollectionIdRaw = payload.collectionId === undefined ? null : payload.collectionId;
    const targetCollectionId =
      toInternalTrashCollectionId(targetCollectionIdRaw, req.user.id) ?? null;

    if (targetCollectionId && !isTrashCollectionId(targetCollectionId, req.user.id)) {
      const collection = await prisma.collection.findFirst({
        where: { id: targetCollectionId, userId: req.user.id },
      });
      if (!collection) return res.status(404).json({ error: "Collection not found" });
    } else if (targetCollectionIdRaw === "trash") {
      await ensureTrashCollection(prisma, req.user.id);
    }

    const newDrawing = await prisma.drawing.create({
      data: {
        name: drawingName,
        elements: JSON.stringify(payload.elements),
        appState: JSON.stringify(payload.appState),
        userId: req.user.id,
        collectionId: targetCollectionId,
        preview: payload.preview ?? null,
        files: JSON.stringify(payload.files ?? {}),
      },
    });
    invalidateDrawingsCache();

    return res.json({
      ...newDrawing,
      collectionId: toPublicTrashCollectionId(newDrawing.collectionId, req.user.id),
      elements: parseJsonField(newDrawing.elements, []),
      appState: parseJsonField(newDrawing.appState, {}),
      files: parseJsonField(newDrawing.files, {}),
    });
  }));

  app.put("/drawings/:id", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
    const existingDrawing = await prisma.drawing.findFirst({
      where: { id, userId: req.user.id },
    });
    if (!existingDrawing) return res.status(404).json({ error: "Drawing not found" });

    const parsed = drawingUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      if (config.nodeEnv === "development") {
        console.error("[API] Validation failed", { id, errors: parsed.error.issues });
      }
      return respondWithValidationErrors(res, parsed.error.issues);
    }

    const payload = parsed.data as {
      name?: string;
      collectionId?: string | null;
      elements?: unknown[];
      appState?: Record<string, unknown>;
      preview?: string | null;
      files?: Record<string, unknown>;
      version?: number;
    };
    const trashCollectionId = getUserTrashCollectionId(req.user.id);
    const isSceneUpdate =
      payload.elements !== undefined ||
      payload.appState !== undefined ||
      payload.files !== undefined;
    const data: Prisma.DrawingUpdateInput = isSceneUpdate
      ? { version: { increment: 1 } }
      : {};

    if (payload.name !== undefined) data.name = payload.name;
    if (payload.elements !== undefined) data.elements = JSON.stringify(payload.elements);
    if (payload.appState !== undefined) data.appState = JSON.stringify(payload.appState);
    if (payload.files !== undefined) data.files = JSON.stringify(payload.files);
    if (payload.preview !== undefined) data.preview = payload.preview;

    if (payload.collectionId !== undefined) {
      if (payload.collectionId === "trash") {
        await ensureTrashCollection(prisma, req.user.id);
        (data as Prisma.DrawingUncheckedUpdateInput).collectionId = trashCollectionId;
      } else if (payload.collectionId) {
        const collection = await prisma.collection.findFirst({
          where: { id: payload.collectionId, userId: req.user.id },
        });
        if (!collection) return res.status(404).json({ error: "Collection not found" });
        (data as Prisma.DrawingUncheckedUpdateInput).collectionId = payload.collectionId;
      } else {
        (data as Prisma.DrawingUncheckedUpdateInput).collectionId = null;
      }
    }

    const updateWhere: Prisma.DrawingWhereInput = { id, userId: req.user.id };
    if (isSceneUpdate && payload.version !== undefined) {
      updateWhere.version = payload.version;
    }

    const updateResult = await prisma.drawing.updateMany({
      where: updateWhere,
      data,
    });
    if (updateResult.count === 0) {
      if (isSceneUpdate && payload.version !== undefined) {
        const latestDrawing = await prisma.drawing.findFirst({
          where: { id, userId: req.user.id },
          select: { version: true },
        });
        return res.status(409).json({
          error: "Conflict",
          code: "VERSION_CONFLICT",
          message: "Drawing has changed since this editor state was loaded.",
          currentVersion: latestDrawing?.version ?? null,
        });
      }
      return res.status(404).json({ error: "Drawing not found" });
    }

    const updatedDrawing = await prisma.drawing.findFirst({
      where: { id, userId: req.user.id },
    });
    if (!updatedDrawing) {
      return res.status(404).json({ error: "Drawing not found" });
    }
    invalidateDrawingsCache();

    return res.json({
      ...updatedDrawing,
      collectionId: toPublicTrashCollectionId(updatedDrawing.collectionId, req.user.id),
      elements: parseJsonField(updatedDrawing.elements, []),
      appState: parseJsonField(updatedDrawing.appState, {}),
      files: parseJsonField(updatedDrawing.files, {}),
    });
  }));

  app.delete("/drawings/:id", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const { id } = req.params;

    const drawing = await prisma.drawing.findFirst({ where: { id, userId: req.user.id } });
    if (!drawing) return res.status(404).json({ error: "Drawing not found" });

    const deleteResult = await prisma.drawing.deleteMany({
      where: { id, userId: req.user.id },
    });
    if (deleteResult.count === 0) {
      return res.status(404).json({ error: "Drawing not found" });
    }
    invalidateDrawingsCache();

    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: req.user.id,
        action: "drawing_deleted",
        resource: `drawing:${id}`,
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
        details: { drawingId: id, drawingName: drawing.name },
      });
    }

    return res.json({ success: true });
  }));

  app.post("/drawings/:id/duplicate", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
    const original = await prisma.drawing.findFirst({ where: { id, userId: req.user.id } });
    if (!original) return res.status(404).json({ error: "Original drawing not found" });
    let duplicatedCollectionId = original.collectionId;
    if (isTrashCollectionId(original.collectionId, req.user.id)) {
      await ensureTrashCollection(prisma, req.user.id);
      duplicatedCollectionId = getUserTrashCollectionId(req.user.id);
    }

    const newDrawing = await prisma.drawing.create({
      data: {
        name: `${original.name} (Copy)`,
        elements: original.elements,
        appState: original.appState,
        files: original.files,
        userId: req.user.id,
        collectionId: duplicatedCollectionId,
        version: 1,
      },
    });
    invalidateDrawingsCache();

    return res.json({
      ...newDrawing,
      collectionId: toPublicTrashCollectionId(newDrawing.collectionId, req.user.id),
      elements: parseJsonField(newDrawing.elements, []),
      appState: parseJsonField(newDrawing.appState, {}),
      files: parseJsonField(newDrawing.files, {}),
    });
  }));

  app.get("/collections", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const trashCollectionId = getUserTrashCollectionId(req.user.id);
    await ensureTrashCollection(prisma, req.user.id);

    const rawCollections = await prisma.collection.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    const hasInternalTrash = rawCollections.some((collection) => collection.id === trashCollectionId);
    const collections = rawCollections
      .filter((collection) => !(hasInternalTrash && collection.id === "trash"))
      .map((collection) =>
        collection.id === trashCollectionId
          ? { ...collection, id: "trash", name: "Trash" }
          : collection
      );
    return res.json(collections);
  }));

  app.post("/collections", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const parsed = collectionNameSchema.safeParse(req.body.name);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Collection name must be between 1 and 100 characters",
      });
    }

    const sanitizedName = sanitizeText(parsed.data, 100);
    const newCollection = await prisma.collection.create({
      data: { name: sanitizedName, userId: req.user.id },
    });
    return res.json(newCollection);
  }));

  app.put("/collections/:id", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
    if (isTrashCollectionId(id, req.user.id)) {
      return res.status(400).json({
        error: "Validation error",
        message: "Trash collection cannot be renamed",
      });
    }
    const existingCollection = await prisma.collection.findFirst({
      where: { id, userId: req.user.id },
    });
    if (!existingCollection) return res.status(404).json({ error: "Collection not found" });

    const parsed = collectionNameSchema.safeParse(req.body.name);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation error",
        message: "Collection name must be between 1 and 100 characters",
      });
    }

    const sanitizedName = sanitizeText(parsed.data, 100);
    const updateResult = await prisma.collection.updateMany({
      where: { id, userId: req.user.id },
      data: { name: sanitizedName },
    });
    if (updateResult.count === 0) {
      return res.status(404).json({ error: "Collection not found" });
    }
    const updatedCollection = await prisma.collection.findFirst({
      where: { id, userId: req.user.id },
    });
    if (!updatedCollection) {
      return res.status(404).json({ error: "Collection not found" });
    }
    return res.json(updatedCollection);
  }));

  app.delete("/collections/:id", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
    if (isTrashCollectionId(id, req.user.id)) {
      return res.status(400).json({
        error: "Validation error",
        message: "Trash collection cannot be deleted",
      });
    }
    const collection = await prisma.collection.findFirst({
      where: { id, userId: req.user.id },
    });
    if (!collection) return res.status(404).json({ error: "Collection not found" });

    await prisma.$transaction([
      prisma.drawing.updateMany({
        where: { collectionId: id, userId: req.user.id },
        data: { collectionId: null },
      }),
      prisma.collection.deleteMany({ where: { id, userId: req.user.id } }),
    ]);
    invalidateDrawingsCache();

    if (config.enableAuditLogging) {
      await logAuditEvent({
        userId: req.user.id,
        action: "collection_deleted",
        resource: `collection:${id}`,
        ipAddress: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.headers["user-agent"] || undefined,
        details: { collectionId: id, collectionName: collection.name },
      });
    }

    return res.json({ success: true });
  }));

  app.get("/library", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const libraryId = `user_${req.user.id}`;
    const library = await prisma.library.findUnique({ where: { id: libraryId } });
    if (!library) return res.json({ items: [] });

    return res.json({ items: parseJsonField(library.items, []) });
  }));

  app.put("/library", requireAuth, asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "Items must be an array" });
    }

    const libraryId = `user_${req.user.id}`;
    const library = await prisma.library.upsert({
      where: { id: libraryId },
      update: { items: JSON.stringify(items) },
      create: { id: libraryId, items: JSON.stringify(items) },
    });

    return res.json({ items: parseJsonField(library.items, []) });
  }));
};
