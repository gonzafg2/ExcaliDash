import { PrismaClient } from "../generated/client";

declare global {
   
  var __excalidashPrisma: PrismaClient | undefined;
}

const prismaClient = globalThis.__excalidashPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__excalidashPrisma = prismaClient;
}

export { prismaClient as prisma };
