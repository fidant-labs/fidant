import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// The first-demo send flow in headless Chromium against the real server. Each
// test starts its own server (see fixtures.ts), so there is no `webServer`.
// Run `pnpm build` first: the server serves apps/web/dist.
export default defineConfig({
  testDir: ".",
  outputDir: fileURLToPath(new URL("../test-results/", import.meta.url)),
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: fileURLToPath(new URL("../playwright-report/", import.meta.url)),
      },
    ],
  ],
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  forbidOnly: Boolean(process.env.CI),
  use: {
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // Without this, Chromium hides local addresses behind mDNS names,
          // which CI runners can't resolve, so peers never connect. Tests only.
          args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
        },
      },
    },
  ],
});
