import { defineConfig } from "@playwright/test";
import { boxIp, remoteBrowsers, serverIp, turnIp } from "./src/stack/networks.ts";

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
            // so the TURN server's address is excluded as well (127.0.0.1 locally). The box's names
            // resolve to its container.
            networks
              ? `--host-resolver-rules=MAP fidant.se ${boxIp}, MAP turn.fidant.se ${boxIp}, MAP * ~NOTFOUND, EXCLUDE ${serverIp}, EXCLUDE ${turnIp}`
              : "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
            // Expose real host candidates in WebRTC instead of mDNS names.
            "--disable-features=WebRtcHideLocalIpsWithMdns",
          ],
        },
      },
    },
  ],
});
