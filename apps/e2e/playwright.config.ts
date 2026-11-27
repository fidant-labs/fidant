import {
  defineConfig,
  type PlaywrightTestOptions,
  type PlaywrightWorkerOptions,
  type Project,
} from "@playwright/test";
import {
  albIp,
  boxIp,
  relayHost,
  relayIp,
  remoteBrowsers,
  serverIp,
  signalHost,
  turnHost,
  turnIp,
} from "./src/stack/networks.ts";

// `pnpm e2e:networks` runs only tests/networks.spec.ts, in browsers inside Docker networks.
const networks = Boolean(process.env.FIDANT_E2E_NETWORKS);
// `FIDANT_E2E_BROWSER=firefox pnpm e2e` picks the engine; unset, Chromium.
const browser = process.env.FIDANT_E2E_BROWSER || "chromium";
if (!["chromium", "firefox", "webkit"].includes(browser)) {
  throw new Error(
    `FIDANT_E2E_BROWSER takes one engine, chromium, firefox or webkit, not "${browser}". Run one engine per invocation: the server respawned after the restart tests keeps its 60 s warm-up (STARTING_MS), which the next engine's early tests would hit.`,
  );
}
if (networks && browser !== "chromium") {
  throw new Error("`pnpm e2e:networks` runs in Chromium only. Unset FIDANT_E2E_BROWSER.");
}
const picked = (projects: Project<PlaywrightTestOptions, PlaywrightWorkerOptions>[]) =>
  projects.filter(({ name }) => name === browser);
// Firefox and WebKit: HTTP and WebSocket off this machine go to a dead proxy (README network block table); Playwright proxies localhost in Firefox, hence the bypass.
const deadEnd = { server: "http://127.0.0.1:9", bypass: "localhost,127.0.0.1" };

export default defineConfig({
  testDir: "tests",
  ...(networks ? { testMatch: "networks.spec.ts" } : { testIgnore: "networks.spec.ts" }),
  outputDir: "test-results",
  globalSetup: "./global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    // Set by global setup once the stack is running. Workers start later and inherit it.
    baseURL: process.env.FIDANT_E2E_BASE_URL,
    // A missing element fails within seconds instead of at the test timeout.
    actionTimeout: 5_000,
    navigationTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ignoreHTTPSErrors: true,
    // The app picks Swedish for a Swedish browser; the specs check the English text.
    locale: "en-US",
    // Service-worker traffic is a routing blind spot for the recorder. Revisit if FID-7 adds a worker.
    serviceWorkers: "block",
  },
  projects: picked([
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // The built-in browser fixture, which checks for unrecorded contexts, needs no host Chromium.
        ...(networks ? { connectOptions: { wsEndpoint: remoteBrowsers.a1 } } : {}),
        launchOptions: {
          args: [
            // Resolve every host except the server's to nothing, so a stray request cannot reach the
            // internet. The rule catches IP literals too, and TURN over TCP goes through the resolver,
            // so the TURN servers' addresses are excluded as well (127.0.0.1 locally). The first
            // matching MAP wins, so coturn's TLS name maps to its address before `*` catches it, and
            // the box's, the relay box's and the signaling image's names resolve to their containers.
            networks
              ? `--host-resolver-rules=MAP ${turnHost} ${turnIp}, MAP fidant.se ${boxIp}, MAP turn.fidant.se ${boxIp}, MAP ${relayHost} ${relayIp}, MAP ${signalHost} ${albIp}, MAP * ~NOTFOUND, EXCLUDE ${serverIp}, EXCLUDE ${turnIp}, EXCLUDE ${relayIp}`
              : "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
            // TURN over TLS ignores ignoreHTTPSErrors, so trust coturn's per-run certificate by its
            // public key. Set by global setup; workers inherit it.
            ...(networks && process.env.FIDANT_E2E_TURN_SPKI
              ? [`--ignore-certificate-errors-spki-list=${process.env.FIDANT_E2E_TURN_SPKI}`]
              : []),
            // Expose real host candidates in WebRTC instead of mDNS names.
            "--disable-features=WebRtcHideLocalIpsWithMdns",
          ],
        },
      },
    },
    {
      name: "firefox",
      use: {
        browserName: "firefox",
        launchOptions: {
          proxy: deadEnd,
          firefoxUserPrefs: {
            "network.proxy.failover_direct": false,
            // Every name lookup, WebRTC's included, goes to a resolver that refuses it.
            "network.trr.mode": 3,
            "network.trr.uri": "https://127.0.0.1:9/dns-query",
            "media.peerconnection.ice.obfuscate_host_addresses": false,
            // Otherwise Firefox never asks the local coturn, which listens on 127.0.0.1.
            "media.peerconnection.ice.loopback": true,
          },
        },
      },
    },
    {
      name: "webkit",
      use: { browserName: "webkit", launchOptions: { proxy: deadEnd } },
    },
  ]),
});
