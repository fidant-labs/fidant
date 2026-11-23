import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const e2eDir = join(repoRoot, "apps", "e2e");
export const observationsDir = join(e2eDir, "observations");
/** Logs and state that belong to the whole run rather than to one test. */
export const runDir = join(observationsDir, "run");

/** Empties observations/ so a run only holds its own files. */
export async function resetObservations(): Promise<void> {
  await rm(observationsDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
}
