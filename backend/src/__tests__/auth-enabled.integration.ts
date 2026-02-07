import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { StringValue } from "ms";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";

describe("Auth Enabled Toggle Authorization", () => {
  const userAgent = "vitest-auth-enabled";
  let prisma: PrismaClient;
  let app: any;
  let csrfHeaderName: string;
  let csrfToken: string;
  let regularUserToken: string;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();

    ({ app } = await import("../index"));

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: {
        authEnabled: true,
        registrationEnabled: false,
      },
      create: {
        id: "default",
        authEnabled: true,
        registrationEnabled: false,
      },
    });

    const passwordHash = await bcrypt.hash("password123", 10);
    const user = await prisma.user.create({
      data: {
        email: "regular-user@test.local",
        passwordHash,
        name: "Regular User",
        role: "USER",
        isActive: true,
      },
      select: {
        id: true,
        email: true,
      },
    });

    const signOptions: SignOptions = {
      expiresIn: config.jwtAccessExpiresIn as StringValue,
    };
    regularUserToken = jwt.sign(
      { userId: user.id, email: user.email, type: "access" },
      config.jwtSecret,
      signOptions
    );

    const agent = request.agent(app);
    const csrfRes = await agent
      .get("/csrf-token")
      .set("User-Agent", userAgent);
    csrfHeaderName = csrfRes.body.header;
    csrfToken = csrfRes.body.token;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects unauthenticated auth-enabled toggle when auth is enabled", async () => {
    const response = await request(app)
      .post("/auth/auth-enabled")
      .set("User-Agent", userAgent)
      .set(csrfHeaderName, csrfToken)
      .send({ enabled: false });

    expect(response.status).toBe(401);
  });

  it("rejects non-admin auth-enabled toggle", async () => {
    const response = await request(app)
      .post("/auth/auth-enabled")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${regularUserToken}`)
      .set(csrfHeaderName, csrfToken)
      .send({ enabled: false });

    expect(response.status).toBe(403);
    expect(response.body?.message).toContain("Admin access required");
  });
});
