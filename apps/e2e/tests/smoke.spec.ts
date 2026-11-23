import { expect, test } from "../src/fixtures.ts";

// A host outside the stack. The route aborts requests to it before DNS, and the browser's
// host-resolver-rules resolve it to nothing, so these tests never reach the internet.
const outside = "https://example.com/";

test("the app loads for a sender and a recipient", async ({ actor, observed, baseURL }) => {
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
