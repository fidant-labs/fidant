import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, resetObservations } from "./src/paths.ts";
import { startStack } from "./src/stack/index.ts";

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(repoRoot, "apps", "web", "dist", "index.html"))) {
    throw new Error("The web client is not built. Run `pnpm e2e` from the repository root.");
  }
  await resetObservations();
  const stack = await startStack();
  // Workers start after global setup and inherit this, so the config's use.baseURL sees it.
  process.env.BASE_URL = stack.baseURL;
  // The recording fixture blocks every origin not in this comma-separated list.
  process.env.STACK_ORIGINS = stack.origins.join(",");
  return stack.stop;
}
