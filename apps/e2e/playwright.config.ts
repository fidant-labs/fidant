import { defineConfig } from "@playwright/test";
import {
  boxIp,
  relayHost,
  relayIp,
  remoteBrowsers,
  serverIp,
  turnHost,
  turnIp,
} from "./src/stack/networks.ts";

// `pnpm e2e:networks` runs only tests/networks.spec.ts, in browsers inside Docker networks.
const networks = Boolean(process.env.SIGILL_E2E_NETWORKS);

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
    baseURL: process.env.SIGILL_E2E_BASE_URL,
    // A missing element fails within seconds instead of at the test timeout.
    actionTimeout: 5_000,
    navigationTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ignoreHTTPSErrors: true,
    // The app picks Swedish for a Swedish browser; the specs check the English text.
    locale: "en-US",
    // Service-worker traffic is a routing blind spot for the recorder. Revisit if SIG-7 adds a worker.
    serviceWorkers: "block",
  },
  projects: [
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
            // the box's and the relay box's names resolve to their containers.
            networks
              ? `--host-resolver-rules=MAP ${turnHost} ${turnIp}, MAP fidant.se ${boxIp}, MAP turn.fidant.se ${boxIp}, MAP ${relayHost} ${relayIp}, MAP * ~NOTFOUND, EXCLUDE ${serverIp}, EXCLUDE ${turnIp}, EXCLUDE ${relayIp}`
              : "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
            // TURN over TLS ignores ignoreHTTPSErrors, so trust coturn's per-run certificate by its
            // public key. Set by global setup; workers inherit it.
            ...(networks && process.env.SIGILL_E2E_TURN_SPKI
              ? [`--ignore-certificate-errors-spki-list=${process.env.SIGILL_E2E_TURN_SPKI}`]
              : []),
            // Expose real host candidates in WebRTC instead of mDNS names.
            "--disable-features=WebRtcHideLocalIpsWithMdns",
          ],
        },
      },
    },
  ],
});
