import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
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
        launchOptions: {
          args: [
            // Resolve every host except localhost to nothing, so a stray request cannot reach the internet.
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
            // Expose real host candidates in WebRTC instead of mDNS names.
            "--disable-features=WebRtcHideLocalIpsWithMdns",
          ],
        },
      },
    },
  ],
});
