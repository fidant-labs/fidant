import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  test as base,
  type Page,
} from "@playwright/test";
import { parseStackOrigins } from "./hosts.ts";
import { type Leaks, LeakWatch } from "./leak-watch.ts";
import { runSeed, SeededRandom } from "./leaks/canary.ts";
import { deleteSavedMail } from "./mail.ts";
import {
  assertActorName,
  type BlockedRecord,
  type ObservationRecord,
  testDirName,
} from "./observations.ts";
import { observationsDir } from "./paths.ts";
import { Recorder } from "./recorder.ts";

export { expect } from "@playwright/test";
export type { Leaks } from "./leak-watch.ts";
export { canaryFile, canaryKey } from "./leaks/canary.ts";

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
  /**
   * Set with `test.use({ remoteBrowsers: { sender: "ws://…" } })` to open those actors in a
   * browser served by `playwright run-server` at that endpoint, with the project's launch options.
   */
  remoteBrowsers: Record<string, string>;
  /** Registers this test's secrets. Its teardown fails the test if any of them leaked. */
  leaks: Leaks;
  /**
   * Random bytes for canaries, from the run seed and this test's title, so the same seed
   * (printed at the start of the run) makes the same canaries. Fork it per canary.
   */
  canary: SeededRandom;
  _leakWatch: LeakWatch;
  _recorders: Map<string, Recorder>;
  _actorContextOptions: BrowserContextOptions;
  _noUnrecordedContexts: undefined;
}

export const test = base.extend<Fixtures>({
  allowBlocked: [false, { option: true }],
  remoteBrowsers: [{}, { option: true }],

  // `_recorders` depends on this, so this is set up first and torn down last: the scan runs once
  // every context has closed and `_recorders` has completed and written the records.
  _leakWatch: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads dependencies from the pattern.
    async ({}, use, testInfo) => {
      const watch = await LeakWatch.start(testDirName(testInfo), process.env.SIGILL_E2E_REGISTRY);
      await use(watch);
      const report = await watch.check();
      // check() saved this test's mail, so the next test does not take it for its own.
      await deleteSavedMail(join(observationsDir, testDirName(testInfo)));
      if (report) {
        throw new Error(report);
      }
    },
    { auto: true },
  ],

  leaks: async ({ _leakWatch }, use) => {
    await use(_leakWatch);
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads dependencies from the pattern.
  canary: async ({}, use, testInfo) => {
    const seed = process.env.SIGILL_E2E_SEED;
    if (!seed) {
      throw new Error("SIGILL_E2E_SEED is not set. Run the suite through global setup.");
    }
    const path = [testInfo.project.name, ...testInfo.titlePath];
    await use(new SeededRandom(runSeed(seed)).fork(JSON.stringify(path)));
  },

  // Auto, so it is set up before any context and torn down after every context has closed.
  // Writing here means records that arrive while a context closes (websocket-close,
  // requestfailed, late blocks) still reach the file.
  _recorders: [
    async ({ allowBlocked, _leakWatch }, use, testInfo) => {
      const recorders = new Map<string, Recorder>();
      _leakWatch.recorders = recorders;
      await use(recorders);
      const dir = join(observationsDir, testDirName(testInfo));
      for (const recorder of recorders.values()) {
        await recorder.write(dir);
      }
      if (allowBlocked) {
        return;
      }
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
    { auto: true },
  ],

  // Torn down after the recorded contexts have closed, so any context still open was made
  // without a recorder. It is closed here so it cannot leak into the next test.
  _noUnrecordedContexts: [
    async ({ browser, _recorders }, use) => {
      await use(undefined);
      const recorded = new Set([..._recorders.values()].map((recorder) => recorder.context));
      const unrecorded = browser.contexts().filter((context) => !recorded.has(context));
      if (unrecorded.length === 0) {
        return;
      }
      await Promise.all(unrecorded.map((context) => context.close()));
      throw new Error(
        `${unrecorded.length} browser context(s) in this test had no traffic recorder. ` +
          "Open contexts with the `actor()` fixture, or use the default `page` or `context`, " +
          "instead of calling `browser.newContext()`.",
      );
    },
    { auto: true },
  ],

  context: async ({ context, _recorders }, use) => {
    await record(_recorders, "default", context);
    await use(context);
  },

  // The same options Playwright gives the default context: `contextOptions` overlaid with the
  // individual `use` options, so actors never drift from the config. Video is not recorded.
  _actorContextOptions: async (
    {
      contextOptions,
      acceptDownloads,
      bypassCSP,
      clientCertificates,
      colorScheme,
      contrast,
      deviceScaleFactor,
      extraHTTPHeaders,
      forcedColors,
      geolocation,
      hasTouch,
      httpCredentials,
      ignoreHTTPSErrors,
      isMobile,
      javaScriptEnabled,
      locale,
      offline,
      permissions,
      proxy,
      reducedMotion,
      screen,
      storageState,
      timezoneId,
      userAgent,
      viewport,
      baseURL,
      serviceWorkers,
    },
    use,
  ) => {
    // Playwright passes only the options that are set, so unset ones are dropped below.
    const options: { [K in keyof BrowserContextOptions]: BrowserContextOptions[K] | undefined } = {
      acceptDownloads,
      bypassCSP,
      clientCertificates: clientCertificates?.length ? clientCertificates : undefined,
      colorScheme,
      contrast,
      deviceScaleFactor,
      extraHTTPHeaders,
      forcedColors,
      geolocation,
      hasTouch,
      httpCredentials,
      ignoreHTTPSErrors,
      isMobile,
      javaScriptEnabled,
      locale,
      offline,
      permissions,
      proxy,
      reducedMotion,
      screen,
      storageState,
      timezoneId,
      userAgent,
      viewport,
      baseURL,
      serviceWorkers,
    };
    const set = Object.entries(options).filter(([, value]) => value !== undefined);
    await use({ ...contextOptions, ...Object.fromEntries(set) });
  },

  actor: async (
    { browser, playwright, launchOptions, remoteBrowsers, _actorContextOptions, _recorders },
    use,
  ) => {
    const opened: BrowserContext[] = [];
    const remotes: Browser[] = [];
    await use(async (name) => {
      assertActorName(name);
      if (name === "default") {
        throw new Error('The actor name "default" is the built-in context.');
      }
      if (_recorders.has(name)) {
        throw new Error(`The actor "${name}" already exists.`);
      }
      const ws = remoteBrowsers[name];
      let target = browser;
      if (ws) {
        // run-server drops launch args unless started with --unsafe.
        target = await playwright.chromium.connect(ws, {
          headers: { "x-playwright-launch-options": JSON.stringify(launchOptions) },
        });
        remotes.push(target);
      }
      const context = await target.newContext(_actorContextOptions);
      opened.push(context);
      await record(_recorders, name, context);
      return { context, page: await context.newPage() };
    });
    // `_recorders` writes the records once these have closed.
    for (const context of opened) {
      await context.close();
    }
    for (const remote of remotes) {
      await remote.close();
    }
  },

  observed: async ({ _recorders }, use) => {
    await use((name) => {
      const recorder = _recorders.get(name);
      if (!recorder) {
        throw new Error(`No actor named "${name}" in this test.`);
      }
      return { blocked: recorder.blocked, records: () => recorder.records() };
    });
  },
});

async function record(
  recorders: Map<string, Recorder>,
  name: string,
  context: BrowserContext,
): Promise<void> {
  const recorder = new Recorder(name, parseStackOrigins(process.env.SIGILL_E2E_STACK_ORIGINS));
  recorders.set(name, recorder);
  await recorder.attach(context);
}
