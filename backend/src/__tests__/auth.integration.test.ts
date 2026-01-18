import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import {
  cleanupTestDb,
  getTestDatabaseUrl,
  getTestPrisma,
  initTestDb,
  setupTestDb,
} from "./testUtils";

let prisma = getTestPrisma();

describe("Authentication flows", () => {
  let app: any;

  beforeAll(async () => {
    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.AUTH_SESSION_SECRET = "test-secret";
    process.env.NODE_ENV = "test";
    setupTestDb();
    prisma = getTestPrisma();
    await initTestDb(prisma);
    const appModule = await import("../index");
    app = appModule.default || appModule.app || appModule;
  });

  beforeEach(async () => {
    await cleanupTestDb(prisma);
    await initTestDb(prisma);
  });

  const fetchCsrfToken = async () => {
    const csrf = await request(app).get("/csrf-token");
    return csrf.body?.token as string;
  };

  const createAdminSession = async () => {
    let token = await fetchCsrfToken();
    const bootstrap = await request(app)
      .post("/auth/bootstrap")
      .set("x-csrf-token", token)
      .send({ username: "admin", password: "password123" });

    if (bootstrap.status !== 201) {
      throw new Error(`Bootstrap failed: ${bootstrap.status} ${JSON.stringify(bootstrap.body)}`);
    }

    token = await fetchCsrfToken();
    const login = await request(app)
      .post("/auth/login")
      .set("x-csrf-token", token)
      .send({ username: "admin", password: "password123" });

    return login.headers["set-cookie"] as string[] | undefined;
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("requires bootstrap before registration", async () => {
    const token = await fetchCsrfToken();
    const response = await request(app)
      .post("/auth/register")
      .set("x-csrf-token", token)
      .send({ username: "user1", password: "password123" });
    expect(response.status).toBe(409);
  });

  it("bootstraps first admin and logs in", async () => {
    const cookie = await createAdminSession();
    expect(cookie).toBeTruthy();
  });

  it("toggles registration when admin", async () => {
    const cookie = await createAdminSession();
    expect(cookie).toBeTruthy();

    const token = await fetchCsrfToken();
    const toggle = await request(app)
      .post("/auth/registration/toggle")
      .set("Cookie", cookie)
      .set("x-csrf-token", token)
      .send({ enabled: true });

    expect(toggle.status).toBe(200);
    expect(toggle.body.registrationEnabled).toBe(true);
  });

  it("registers a new user when enabled", async () => {
    const cookie = await createAdminSession();
    expect(cookie).toBeTruthy();

    let token = await fetchCsrfToken();
    await request(app)
      .post("/auth/registration/toggle")
      .set("Cookie", cookie)
      .set("x-csrf-token", token)
      .send({ enabled: true });

    token = await fetchCsrfToken();
    const register = await request(app)
      .post("/auth/register")
      .set("x-csrf-token", token)
      .send({ username: "user1", password: "password123" });

    expect(register.status).toBe(201);
    expect(register.body.user.username).toBe("user1");
  });
});
