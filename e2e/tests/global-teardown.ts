import { promises as fs } from "fs";
import path from "path";

const AUTH_STATE_PATH = path.resolve(__dirname, ".auth/storageState.json");

const globalTeardown = async () => {
  try {
    await fs.unlink(AUTH_STATE_PATH);
  } catch {
    // Ignore missing auth state file.
  }
};

export default globalTeardown;
