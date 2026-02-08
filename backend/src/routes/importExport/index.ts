import { registerExcalidashImportRoutes } from "./excalidashImportRoutes";
import { registerExcalidashExportRoute } from "./exportRoutes";
import { registerLegacySqliteImportRoutes } from "./legacySqliteImportRoutes";
import { RegisterImportExportDeps } from "./shared";

export const registerImportExportRoutes = (deps: RegisterImportExportDeps) => {
  registerExcalidashExportRoute(deps);
  registerExcalidashImportRoutes(deps);
  registerLegacySqliteImportRoutes(deps);
};

export type { RegisterImportExportDeps } from "./shared";
