import { join } from "node:path";
import {
  type BrowserContext,
  type BrowserContextOptions,
  test as base,
  type Page,
} from "@playwright/test";
import { parseStackOrigins } from "./hosts.ts";
import {
  assertActorName,
  type BlockedRecord,
  type ObservationRecord,
  testDirName,
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
  _actorContextOptions: BrowserContextOptions;
  _noUnrecordedContexts: undefined;
}

export const test = base.extend<Fixtures>({
  allowBlocked: [false, { option: true }],

  // Auto, so it is set up before any context and torn down after every context has closed.
  // Writing here means records that arrive while a context closes (websocket-close,
  // requestfailed, late blocks) still reach the file.
  _recorders: [
    async ({ allowBlocked }, use, testInfo) => {
      const recorders = new Map<string, Recorder>();
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

  actor: async ({ browser, _actorContextOptions, _recorders }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (name) => {
      assertActorName(name);
      if (name === "default") {
        throw new Error('The actor name "default" is the built-in context.');
      }
      if (_recorders.has(name)) {
        throw new Error(`The actor "${name}" already exists.`);
      }
      const context = await browser.newContext(_actorContextOptions);
      opened.push(context);
      await record(_recorders, name, context);
      return { context, page: await context.newPage() };
    });
    // `_recorders` writes the records once these have closed.
    for (const context of opened) {
      await context.close();
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
