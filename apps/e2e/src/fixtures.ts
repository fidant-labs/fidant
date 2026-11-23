import { join } from "node:path";
import { type BrowserContext, test as base, type Page } from "@playwright/test";
import { parseStackOrigins } from "./hosts.ts";
import {
  assertActorName,
  type BlockedRecord,
  type ObservationRecord,
  testSlug,
} from "./observations.ts";
import { observationsDir } from "./paths.ts";
import { Recorder } from "./recorder.ts";

export { expect } from "@playwright/test";

/** A browser context of its own, such as the sender or the recipient, with one page open. */
export interface Actor {
  context: BrowserContext;
  page: Page;
}

/** What the harness saw for one actor so far. */
export interface Observed {
  blocked: readonly BlockedRecord[];
  records(): Promise<ObservationRecord[]>;
}

interface Fixtures {
  /** Opens a recorded context named `name`, with its own observations file. */
  actor: (name: string) => Promise<Actor>;
  /** Looks up an actor's observations. The built-in `context` fixture is the actor "default". */
  observed: (name: string) => Observed;
  /**
   * Set with `test.use({ allowBlocked: true })` to keep requests outside the stack from failing
   * the test, for a test that checks the blocker itself. They are still aborted and recorded.
   */
  allowBlocked: boolean;
  _recorders: Map<string, Recorder>;
}

export const test = base.extend<Fixtures>({
  allowBlocked: [false, { option: true }],

  _recorders: async ({ allowBlocked }, use) => {
    const recorders = new Map<string, Recorder>();
    await use(recorders);
    // Runs after the context and actor fixtures have written their records.
    if (allowBlocked) return;
    const blocked = [...recorders.values()].flatMap((recorder) =>
      recorder.blocked.map(({ kind, url }) => `  ${recorder.actor} (${kind}): ${url}`),
    );
    if (blocked.length > 0) {
      throw new Error(
        `The browser tried to reach ${blocked.length} URL(s) outside the local stack. ` +
          `They were aborted:\n${blocked.join("\n")}`,
      );
    }
  },

  context: async ({ context, _recorders }, use, testInfo) => {
    const recorder = await record(_recorders, "default", context);
    await use(context);
    await recorder.write(testDir(testInfo));
  },

  actor: async ({ browser, baseURL, ignoreHTTPSErrors, _recorders }, use, testInfo) => {
    const opened: { recorder: Recorder; context: BrowserContext }[] = [];
    await use(async (name) => {
      assertActorName(name);
      if (name === "default") throw new Error('The actor name "default" is the built-in context.');
      if (_recorders.has(name)) throw new Error(`The actor "${name}" already exists.`);
      const context = await browser.newContext({
        ...(baseURL === undefined ? {} : { baseURL }),
        ignoreHTTPSErrors,
      });
      const recorder = await record(_recorders, name, context);
      opened.push({ recorder, context });
      return { context, page: await context.newPage() };
    });
    for (const { recorder, context } of opened) {
      await recorder.write(testDir(testInfo));
      await context.close();
    }
  },

  observed: async ({ _recorders }, use) => {
    await use((name) => {
      const recorder = _recorders.get(name);
      if (!recorder) throw new Error(`No actor named "${name}" in this test.`);
      return { blocked: recorder.blocked, records: () => recorder.records() };
    });
  },
});

async function record(
  recorders: Map<string, Recorder>,
  name: string,
  context: BrowserContext,
): Promise<Recorder> {
  const recorder = new Recorder(name, parseStackOrigins(process.env.STACK_ORIGINS));
  recorders.set(name, recorder);
  await recorder.attach(context);
  return recorder;
}

function testDir(testInfo: {
  project: { name: string };
  titlePath: string[];
  retry: number;
  repeatEachIndex: number;
}): string {
  const path = [testInfo.project.name, ...testInfo.titlePath];
  if (testInfo.repeatEachIndex > 0) path.push(`repeat ${testInfo.repeatEachIndex}`);
  if (testInfo.retry > 0) path.push(`retry ${testInfo.retry}`);
  return join(observationsDir, testSlug(path));
}
