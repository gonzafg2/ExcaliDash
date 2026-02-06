const { parentPort, workerData } = require('worker_threads');

if (!parentPort) throw new Error("Must be run in a worker thread");

const openReadonlyDb = (filePath) => {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(filePath, {
      readOnly: true,
      enableForeignKeyConstraints: false,
    });
    return { kind: "node:sqlite", db };
  } catch (_err) {
    // Fall back to better-sqlite3 on Node versions that don't have node:sqlite.
    const Database = require("better-sqlite3");
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    return { kind: "better-sqlite3", db };
  }
};

try {
  const { filePath } = workerData;
  const { db } = openReadonlyDb(filePath);
  
  // This is the CPU-heavy operation
  const result = db.prepare("PRAGMA integrity_check;").get();
  
  db.close();
  parentPort.postMessage(result.integrity_check === "ok");
} catch (error) {
  // Any error means invalid or corrupt DB
  parentPort.postMessage(false);
}
