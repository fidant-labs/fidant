import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  test as base,
  expect,
  type Page,
} from "@playwright/test";
import { parseStackOrigins } from "./hosts.ts";
import { failOnLeaks, type Leaks, LeakWatch } from "./leak-watch.ts";
import { base32Token, runSeed, SeededRandom } from "./leaks/canary.ts";
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
  /** Put first in this test's remote browsers' `--host-resolver-rules`, where the first match wins. */
  hostRules: string;
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
  hostRules: ["", { option: true }],

  // `_recorders` depends on this, so this is set up first and torn down last: the scan runs once
  // every context has closed and `_recorders` has completed and written the records.
  _leakWatch: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads dependencies from the pattern.
    async ({}, use, testInfo) => {
      const watch = await LeakWatch.start(testDirName(testInfo), process.env.SIGILL_E2E_REGISTRY);
      await use(watch);
      // check() saved this test's mail: delete it, so the next test does not take it for its own.
      await failOnLeaks(watch, () => deleteSavedMail(join(observationsDir, testDirName(testInfo))));
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
    {
      browser,
      playwright,
      launchOptions,
      remoteBrowsers,
      hostRules,
      _actorContextOptions,
      _recorders,
    },
    use,
  ) => {
    const rules = "--host-resolver-rules=";
    const options = hostRules
      ? {
          ...launchOptions,
          args: launchOptions.args?.map((arg) =>
            arg.startsWith(rules) ? `${rules}${hostRules}, ${arg.slice(rules.length)}` : arg,
          ),
        }
      : launchOptions;
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
          headers: { "x-playwright-launch-options": JSON.stringify(options) },
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
  await context.addInitScript(logPeerFailures);
}

/** Runs in the page through addInitScript, so it may use nothing from this module: logs why a peer connection call failed, every error the page builds and its cause, what a data channel refused, and who closed a peer or channel after which frames, which the app keeps out of its console. */
function logPeerFailures() {
  const log = (text: string) => console.warn(`sigill-e2e: ${text}`);
  const native = (fn: unknown) =>
    typeof fn === "function" && Function.prototype.toString.call(fn).includes("[native code]");
  const NativeError = Error;
  const frames = (stack: string | undefined, skip: number, count: number) =>
    (stack ?? "")
      .split("\n")
      .slice(skip, skip + count)
      .map((line) => line.trim())
      .join(" | ");
  const stack = () => {
    const limit = NativeError.stackTraceLimit;
    NativeError.stackTraceLimit = 20;
    const lines = frames(new NativeError().stack, 3, 20);
    NativeError.stackTraceLimit = limit;
    return lines;
  };
  const describe = (error: unknown) =>
    error instanceof NativeError
      ? `${error.name}: ${error.message} | ${frames(error.stack, 1, 3)}`
      : String(error);
  const built = (args: unknown[]) => {
    const cause = (args[1] as { cause?: unknown } | undefined)?.cause;
    log(
      `error built: ${String(args[0])}${cause === undefined ? "" : ` (cause ${describe(cause)})`}`,
    );
  };
  globalThis.Error = new Proxy(NativeError, {
    construct(target, args: unknown[], newTarget: () => unknown) {
      built(args);
      return Reflect.construct(target, args, newTarget) as object;
    },
    apply(target, self, args: unknown[]) {
      built(args);
      return Reflect.apply(target, self, args) as object;
    },
  });
  const peer = RTCPeerConnection.prototype as unknown as Record<string, unknown>;
  for (const name of [
    "createOffer",
    "createAnswer",
    "setLocalDescription",
    "setRemoteDescription",
    "addIceCandidate",
  ]) {
    const method = peer[name];
    if (!native(method)) {
      continue;
    }
    peer[name] = function (this: RTCPeerConnection, ...args: unknown[]) {
      return (
        Reflect.apply(method as () => Promise<unknown>, this, args) as Promise<unknown>
      ).catch((error: unknown) => {
        const { name: kind, message } = error as Error;
        log(`${name} rejected: ${kind}: ${message}`);
        throw error;
      });
    };
  }
  // Frame headers only (kind, seq, length): the bytes after them are keys, names and file data.
  const trails = new WeakMap<RTCDataChannel, { in: string[]; out: string[] }>();
  const note = (channel: RTCDataChannel, way: "in" | "out", data: unknown) => {
    let entry: string = typeof data;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const view =
        data instanceof ArrayBuffer
          ? new DataView(data)
          : new DataView(data.buffer, data.byteOffset, data.byteLength);
      entry =
        view.byteLength < 10
          ? `?:${view.byteLength}`
          : `${view.getUint8(1)}#${view.getUint32(6)}:${view.byteLength}`;
    }
    const trail = trails.get(channel) ?? { in: [], out: [] };
    trails.set(channel, trail);
    trail[way] = [...trail[way], entry].slice(-12);
  };
  const channelProto = RTCDataChannel.prototype;
  const listen = channelProto.addEventListener;
  const watched = new WeakSet<RTCDataChannel>();
  channelProto.addEventListener = function (this: RTCDataChannel, ...args: unknown[]) {
    if (!watched.has(this)) {
      watched.add(this);
      Reflect.apply(listen, this, [
        "message",
        (event: MessageEvent) => note(this, "in", event.data),
      ]);
      Reflect.apply(listen, this, [
        "error",
        ({ error }: RTCErrorEvent) =>
          log(`channel error: ${error.errorDetail} ${error.sctpCauseCode ?? ""}: ${error.message}`),
      ]);
    }
    return Reflect.apply(listen, this, args);
  } as RTCDataChannel["addEventListener"];
  const send = channelProto.send;
  channelProto.send = function (this: RTCDataChannel, data: unknown) {
    try {
      Reflect.apply(send, this, [data]);
    } catch (error) {
      log(`channel send() threw in ${this.readyState}: ${describe(error)}`);
      throw error;
    }
    note(this, "out", data);
  } as RTCDataChannel["send"];
  for (const [label, proto] of [
    ["peer", RTCPeerConnection.prototype],
    ["channel", channelProto],
  ] as const) {
    const close = proto.close;
    if (!native(close)) {
      continue;
    }
    proto.close = function (this: unknown) {
      const seen = this instanceof RTCDataChannel ? trails.get(this) : undefined;
      const trail =
        this instanceof RTCDataChannel
          ? seen
            ? ` after in ${seen.in.join(" ")} out ${seen.out.join(" ")}`
            : " after no frames"
          : "";
      log(`${label} close() ${stack()}${trail}`);
      Reflect.apply(close, this, []);
    };
  }
}

/** A watched person's name, unique to this run. */
export function makeName(leaks: Leaks, canary: SeededRandom, first: string): string {
  const name = `${first}-${base32Token(canary.fork(`name ${first}`), 8)}`;
  leaks.watchText(`name ${first}`, name);
  return name;
}

export const recipientRow = (sender: Page, name: string) =>
  sender.getByRole("list", { name: "Recipients" }).getByRole("listitem").filter({ hasText: name });

/** Also finds the row once every link has delivered and the list sits folded under "Show details". */
export const delivered = (sender: Page, name: string) =>
  sender
    .getByRole("list", { name: "Recipients", includeHidden: true })
    .getByRole("listitem", { includeHidden: true })
    .filter({ hasText: name })
    .getByText(`Delivered through ${name}'s link`);

/** Chooses a file the send page accepts, then waits for the page to move focus to "Your name" a frame later, which would otherwise take the text of a field being filled. */
export async function chooseFile(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const input = page.getByLabel("Choose a file");
  await input.focus();
  await input.setInputFiles(file);
  await expect(page.getByLabel("Your name")).toBeFocused();
}

/** Runs in the page through addInitScript, so it may use nothing from this module: `cut()` closes the sender's peers, `stalled` stops its data channels sending. */
export function breakableSender() {
  const g = globalThis as { cut?: () => void; stalled?: boolean };
  const peers: RTCPeerConnection[] = [];
  const Native = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class extends Native {
    constructor(config?: RTCConfiguration) {
      super(config);
      peers.push(this);
    }
  };
  g.cut = () => {
    for (const peer of peers) {
      peer.close();
    }
  };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (this: RTCDataChannel, ...args: unknown[]) {
    if (!g.stalled) {
      Reflect.apply(send, this, args);
    }
  } as RTCDataChannel["send"];
}

/** Lets `context`'s pages at `origin` read and write the clipboard, with the permissions each engine has. Playwright's Firefox needs none. */
export async function allowClipboard(context: BrowserContext, origin: string): Promise<void> {
  const permissions: Record<string, string[]> = {
    chromium: ["clipboard-read", "clipboard-write"],
    webkit: ["clipboard-read"],
  };
  const engine = context.browser()?.browserType().name() ?? "";
  await context.grantPermissions(permissions[engine] ?? [], { origin });
}

/** Opens a footer menu by its button name, picks one of its radio options and waits for the menu to close. */
export async function choose(page: Page, menu: string, option: string): Promise<void> {
  await page.locator("footer").getByRole("button", { name: menu }).click();
  await page.getByRole("menuitemradio", { name: option }).click();
  await expect(page.getByRole("menu")).toBeHidden();
}
