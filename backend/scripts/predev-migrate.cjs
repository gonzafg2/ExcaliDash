/* eslint-disable no-console */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const backendRoot = path.resolve(__dirname, "..");

const resolveDatabaseUrl = (rawUrl) => {
  const defaultDbPath = path.resolve(backendRoot, "prisma/dev.db");

  if (!rawUrl || String(rawUrl).trim().length === 0) {
    return `file:${defaultDbPath}`;
  }

  if (!String(rawUrl).startsWith("file:")) {
    return String(rawUrl);
  }

  const filePath = String(rawUrl).replace(/^file:/, "");
  const prismaDir = path.resolve(backendRoot, "prisma");
  const normalizedRelative = filePath.replace(/^\.\/?/, "");
  const hasLeadingPrismaDir =
    normalizedRelative === "prisma" || normalizedRelative.startsWith("prisma/");

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(hasLeadingPrismaDir ? backendRoot : prismaDir, normalizedRelative);

  return `file:${absolutePath}`;
};

const databaseUrl = resolveDatabaseUrl(process.env.DATABASE_URL);
process.env.DATABASE_URL = databaseUrl;

const nodeEnv = process.env.NODE_ENV || "development";

const run = (cmd) => {
  execSync(cmd, {
    cwd: backendRoot,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
};

const getDbFilePath = () => {
  if (!databaseUrl.startsWith("file:")) return null;
  return databaseUrl.replace(/^file:/, "");
};

const isNonEmptyLegacyDbWithoutMigrations = () => {
  const dbPath = getDbFilePath();
  if (!dbPath) return false;
  if (!fs.existsSync(dbPath)) return false;

  // Only attempt this heuristic for SQLite file DBs.
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  try {
    const hasMigrations =
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_prisma_migrations' LIMIT 1",
        )
        .get() !== undefined;

    const nonEmptyRow = db
      .prepare("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get();
    const nonEmpty = Number(nonEmptyRow?.cnt || 0) > 0;

    return nonEmpty && !hasMigrations;
  } finally {
    db.close();
  }
};

const backupDbIfPresent = () => {
  const dbPath = getDbFilePath();
  if (!dbPath) return null;
  if (!fs.existsSync(dbPath)) return null;

  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath, path.extname(dbPath));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(dir, `${base}.${stamp}.backup`);

  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
};

const isNonProd = nodeEnv !== "production";
const isFileDb = databaseUrl.startsWith("file:");

if (isNonProd && isFileDb && isNonEmptyLegacyDbWithoutMigrations()) {
  const backupPath = backupDbIfPresent();
  console.warn(
    `[predev] Prisma migrations cannot be deployed because the database was created without migrations.\n` +
      `  DATABASE_URL=${databaseUrl}\n` +
      (backupPath ? `  Backup: ${backupPath}\n` : "") +
      `  Resetting local SQLite database to apply migrations.`,
  );

  run("npx prisma migrate reset --force --skip-seed");
  process.exit(0);
}

run("npx prisma migrate deploy");
