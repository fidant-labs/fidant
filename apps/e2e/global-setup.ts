import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSeed, runSeed } from "./src/leaks/canary.ts";
import { saveMail } from "./src/mail.ts";
import { repoRoot, resetObservations, runDir } from "./src/paths.ts";
import { startStack } from "./src/stack/index.ts";
import { assertDocker, dockerNetworks, dockerServer } from "./src/stack/networks.ts";
import { sweepRun } from "./src/sweep.ts";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const networks = Boolean(process.env.SIGILL_E2E_NETWORKS);
  if (networks) {
    assertDocker();
  }
  if (!existsSync(join(repoRoot, "apps", "web", "dist", "index.html"))) {
    throw new Error("The web client is not built. Run `pnpm e2e` from the repository root.");
  }
  // Canaries come from this seed. It is not a key, so it is printed for replaying a failure.
  const seed = formatSeed(runSeed());
  process.env.SIGILL_E2E_SEED = seed;
  console.log(`Canary seed: ${seed} (set SIGILL_E2E_SEED to replay it)`);

  await resetObservations();
  // The registry holds the secrets tests watch, so it stays out of observations/, which CI uploads.
  const registry = await mkdtemp(join(tmpdir(), "sigill-e2e-registry-"));
  process.env.SIGILL_E2E_REGISTRY = registry;
  const removeRegistry = () => rmSync(registry, { recursive: true, force: true });
  // Backstop for a run that ends without global teardown. Only synchronous work runs on exit.
  process.once("exit", removeRegistry);

  let stack: Awaited<ReturnType<typeof startStack>>;
  try {
    stack = await startStack(networks ? [dockerNetworks, dockerServer] : undefined);
  } catch (error) {
    removeRegistry();
    throw error;
  }
  // Workers start after global setup and inherit this, so the config's use.baseURL sees it.
  process.env.SIGILL_E2E_BASE_URL = stack.baseURL;
  // The recording fixture blocks every origin not in this comma-separated list.
  process.env.SIGILL_E2E_STACK_ORIGINS = stack.origins.join(",");
  // Set only when coturn runs, so a relay spec can skip without it.
  if (stack.env.TURN_URLS) {
    process.env.SIGILL_E2E_TURN_URLS = stack.env.TURN_URLS;
  }
  // Paths only, never the secrets: a restarted server inherits this environment.
  if (stack.env.RELAYS_FILE && stack.env.RELAY_MASTER_FILE) {
    process.env.SIGILL_E2E_RELAYS_FILE = stack.env.RELAYS_FILE;
    process.env.SIGILL_E2E_RELAY_MASTER_FILE = stack.env.RELAY_MASTER_FILE;
  }
  // Mailpit's API, set only when it runs, so an email spec can skip without it.
  if (stack.env.MAILPIT_API) {
    process.env.SIGILL_E2E_MAILPIT = stack.env.MAILPIT_API;
  }

  return async () => {
    try {
      // Leftover mail is saved while Mailpit runs; the stack stops before the sweep reads the logs.
      await saveMail(runDir).finally(() => stack.stop());
      const report = await sweepRun(registry, seed);
      // Throwing here makes the run fail even when every test passed.
      if (report) {
        throw new Error(`Run-level leak sweep: ${report}`);
      }
    } finally {
      process.off("exit", removeRegistry);
      await rm(registry, { recursive: true, force: true });
    }
  };
}
