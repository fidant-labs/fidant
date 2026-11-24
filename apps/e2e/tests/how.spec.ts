import type { Page } from "@playwright/test";
import { expect, test } from "../src/fixtures.ts";

const SECTIONS = ["stays", "link", "open", "direct", "relay", "never"];

let errors: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(String(error)));
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

async function expectBelowHeader(page: Page, selector: string) {
  await expect
    .poll(() =>
      page.evaluate((selector) => {
        const top = document.querySelector(selector)?.getBoundingClientRect().top ?? -1;
        const header = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
        return top >= header && top < innerHeight;
      }, selector),
    )
    .toBe(true);
}

test("the landing page links to the six steps, which end with a link to /privacy", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Read how it works" }).click();
  await expect(page).toHaveURL(/\/how$/);
  await expect(page.locator("main h1")).toHaveText("How it works");

  const sections = page.locator("main section");
  await expect(sections).toHaveCount(SECTIONS.length);
  for (const [index, id] of SECTIONS.entries()) {
    await expect(sections.nth(index)).toHaveId(id);
    await expect(sections.nth(index).locator("h2")).toHaveCount(1);
    await expect(sections.nth(index).locator('svg[aria-hidden="true"]')).toHaveCount(1);
  }
  await expect(page.locator("main a").last()).toHaveAttribute("href", "/privacy");
  await expect(page.locator("footer").getByRole("link", { name: "How it works" })).toHaveAttribute(
    "href",
    "/how",
  );
});

test.describe("in Swedish", () => {
  test.use({ locale: "sv-SE" });

  test("the page is in Swedish", async ({ page }) => {
    await page.goto("/how");
    await expect(page.locator("main h1")).toHaveText("Så fungerar det");
    await expect(page).toHaveTitle("Så fungerar det – Fidant");
  });
});

test("opening /how#relay shows the relay step below the header", async ({ page }) => {
  await page.goto("/how#relay");
  await expectBelowHeader(page, "#relay h2");
});

test("an in-app link to /how#relay shows and focuses the relay step", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main h1")).toBeVisible();
  await page.evaluate(() => {
    history.pushState(null, "", "/how#relay");
    dispatchEvent(new PopStateEvent("popstate"));
    scrollTo(0, 0);
  });
  await expect(page.locator("#relay h2")).toBeFocused();
  await expectBelowHeader(page, "#relay h2");
});

test("with reduced motion nothing animates", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/how");
  await expect(page.locator("main h1")).toHaveText("How it works");
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  for (const id of SECTIONS) {
    const drawing = page.locator(`#${id} > svg`);
    await drawing.scrollIntoViewIfNeeded();
    await expect(drawing).toHaveAttribute("data-seen", "");
  }
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test("a drawing waits until it is scrolled into view, then plays", async ({ page }) => {
  await page.goto("/how");
  const never = page.locator("#never > svg");
  const states = () =>
    never.evaluate((svg) => svg.getAnimations({ subtree: true }).map((a) => a.playState));
  await expect(never).toBeAttached();
  await expect(never).not.toHaveAttribute("data-seen");
  const before = await states();
  expect(before.length).toBeGreaterThan(0);
  expect(before.every((state) => state === "paused")).toBe(true);

  await never.scrollIntoViewIfNeeded();
  await expect(never).toHaveAttribute("data-seen", "");
  await expect
    .poll(async () =>
      (await states()).every((state) => state === "running" || state === "finished"),
    )
    .toBe(true);
});

test("the page fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/how");
  await expect(page.locator("main h1")).toBeVisible();
  const width = await page.evaluate(async () => {
    await document.fonts.ready;
    return { scroll: document.documentElement.scrollWidth, inner: innerWidth };
  });
  expect(width.scroll).toBeLessThanOrEqual(width.inner);
});
