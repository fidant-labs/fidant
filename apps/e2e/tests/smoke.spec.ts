import { canaryFile, canaryKey, expect, test } from "../src/fixtures.ts";

// A host outside the stack. The route aborts requests to it before DNS, and the browser's
// host-resolver-rules resolve it to nothing, so these tests never reach the internet.
const outside = "https://example.com/";

test("the app loads for a sender and a recipient", async ({
  actor,
  observed,
  baseURL,
  leaks,
  canary,
}) => {
  // Nothing sends these yet; the leak check after the test must find neither.
  leaks.watch(canaryFile(canary.fork("file")));
  leaks.watchKey("fragment secret", canaryKey(canary.fork("key")));
  const actors = { sender: await actor("sender"), recipient: await actor("recipient") };

  for (const [name, { page }] of Object.entries(actors)) {
    await page.goto("/");
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await expect(page.locator("#app")).not.toBeEmpty();

    const records = await observed(name).records();
    const root = new URL("/", baseURL).href;
    expect(records).toContainEqual(
      expect.objectContaining({ type: "response", url: root, status: 200 }),
    );
    expect(observed(name).blocked).toEqual([]);
  }
});

test("request bodies are recorded", async ({ page, observed, baseURL, leaks }) => {
  // The empty POST has no visible body, which is a leak-check limit finding by design.
  leaks.expectLeaks();
  await page.goto("/");
  await page.evaluate(async () => {
    await fetch("/text", { method: "POST", body: "a text body" });
    await fetch("/blob", { method: "PUT", body: new Blob([new Uint8Array([0, 1, 254, 255])]) });
    await fetch("/empty", { method: "POST" });
  });
  const requests = (await observed("default").records()).filter(
    (record) => record.type === "request",
  );
  const at = (path: string) =>
    requests.find((record) => record.url === new URL(path, baseURL).href);
  expect(at("/text")?.body).toBe(Buffer.from("a text body").toString("base64"));
  expect(at("/blob")?.body).toBe("AAH+/w==");
  // Chromium does not say whether a POST without an exposed body was empty, so it is marked.
  expect(at("/empty")).toMatchObject({ bodyMissing: true });
  expect(at("/empty")?.body).toBeUndefined();
});

test.describe("the blocker", () => {
  test.use({ allowBlocked: true });

  test("a navigation outside the stack is blocked and recorded", async ({ page, observed }) => {
    await expect(page.goto(outside)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    expect(observed("default").blocked).toEqual([
      expect.objectContaining({ url: outside, kind: "http" }),
    ]);
  });

  test("a websocket outside the stack is blocked and recorded", async ({ page, observed }) => {
    await page.goto("/");
    const closed = await page.evaluate(
      (url) =>
        new Promise<{ code: number }>((resolve) => {
          const socket = new WebSocket(url);
          socket.addEventListener("close", (event) => resolve({ code: event.code }));
        }),
      "wss://example.com/",
    );
    expect(closed.code).not.toBe(1000);
    expect(observed("default").blocked).toEqual([
      expect.objectContaining({ url: "wss://example.com/", kind: "websocket" }),
    ]);
  });
});

test("a request outside the stack fails the test by default", async ({ page }) => {
  // Expected to fail: the fixture's teardown fails any test whose browser left the stack.
  test.fail();
  await page.goto(outside).catch(() => {});
});

test("a context without a recorder fails the test", async ({ browser }) => {
  // Expected to fail: the fixture's teardown fails any test that left a context unrecorded.
  test.fail();
  await browser.newContext();
});

test("each page has its own tab title", async ({ page }) => {
  for (const [path, title] of [
    ["/", "Fidant: private file transfer"],
    ["/send", "Send a file – Fidant"],
    ["/secret", "Share a secret – Fidant"],
    ["/privacy", "Privacy – Fidant"],
    ["/how", "How it works – Fidant"],
    ["/r/unknown", "Receive – Fidant"],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveTitle(title);
  }
});

test("the theme menu is in the header on wide screens and in the footer on phones", async ({
  page,
}) => {
  await page.goto("/");
  const header = page.locator("header").getByRole("button", { name: "Theme" });
  const footer = page.locator("footer").getByRole("button", { name: "Theme" });
  await expect(header).toBeVisible();
  await expect(footer).toBeHidden();

  await page.setViewportSize({ width: 360, height: 800 });
  await expect(header).toBeHidden();
  await footer.click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("menu")).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 800 });
  await header.click();
  await expect(page.getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
