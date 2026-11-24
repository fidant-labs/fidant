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

async function expectNoOverflow(page: Page, width = 360) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/how");
  await expect(page.locator("main h1")).toBeVisible();
  // The header hides Share a secret below 768 px.
  await expect(page.locator("header nav").getByRole("link")).toHaveCount(width < 768 ? 3 : 4);
  const measured = await page.evaluate(async () => {
    await document.fonts.ready;
    const items = [...document.querySelectorAll("header nav li")];
    return {
      scroll: document.documentElement.scrollWidth,
      right: Math.max(...items.map((item) => item.getBoundingClientRect().right)),
      inner: innerWidth,
    };
  });
  expect(measured.scroll).toBeLessThanOrEqual(measured.inner);
  expect(measured.right).toBeLessThanOrEqual(measured.inner);
}

async function expectFinalFrames(page: Page) {
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  const notFinal = await page.evaluate(
    () =>
      [...document.querySelectorAll("main svg *")].filter((element) => {
        const style = getComputedStyle(element);
        return (
          style.opacity !== "1" ||
          style.translate !== "none" ||
          !["0", "0px"].includes(style.strokeDashoffset)
        );
      }).length,
  );
  expect(notFinal).toBe(0);
}

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

test("the top nav links to How it works between Share a secret and Privacy", async ({ page }) => {
  await page.goto("/how");
  const links = page.locator("header nav").getByRole("link");
  await expect(links).toHaveText(["Send a file", "Share a secret", "How it works", "Privacy"]);
  await expect(links.nth(1)).toHaveAttribute("href", "/secret");
  await expect(links.nth(2)).toHaveAttribute("href", "/how");
  await expect(links.nth(2)).toHaveAttribute("aria-current", "page");
  await expect(
    page.locator("footer").getByRole("link", { name: "Share a secret" }),
  ).toHaveAttribute("href", "/secret");
});

test.describe("in Swedish", () => {
  test.use({ locale: "sv-SE" });

  test("the page is in Swedish", async ({ page }) => {
    await page.goto("/how");
    await expect(page.locator("main h1")).toHaveText("Så fungerar det");
    await expect(page).toHaveTitle("Så fungerar det – Fidant");
    await expect(page.locator("#relay h2")).toHaveText("Ibland går den via vårt relä");
  });

  test("the Swedish page fits a phone screen", async ({ page }) => {
    await expectNoOverflow(page);
  });

  test("the Swedish header fits all four links at 768 px", async ({ page }) => {
    await expectNoOverflow(page, 768);
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
  await expectFinalFrames(page);
});

test("printing shows every drawing at its final frame", async ({ page }) => {
  await page.emulateMedia({ media: "print" });
  await page.goto("/how");
  await expect(page.locator("main h1")).toHaveText("How it works");
  await expectFinalFrames(page);
});

test("a drawing below the fold waits, and each one plays once scrolled into view", async ({
  page,
}) => {
  await page.goto("/how");
  const states = (id: string) =>
    page
      .locator(`#${id} > svg`)
      .evaluate((svg) => svg.getAnimations({ subtree: true }).map((a) => a.playState));
  const never = page.locator("#never > svg");
  await expect(never).toBeAttached();
  await expect(never).not.toHaveAttribute("data-seen");
  const before = await states("never");
  expect(before.length).toBeGreaterThan(0);
  expect(before.every((state) => state === "paused")).toBe(true);

  for (const id of SECTIONS) {
    const drawing = page.locator(`#${id} > svg`);
    await drawing.scrollIntoViewIfNeeded();
    await expect(drawing).toHaveAttribute("data-seen", "");
    await expect
      .poll(async () => {
        const after = await states(id);
        return after.length > 0 && after.every((s) => s === "running" || s === "finished");
      })
      .toBe(true);
  }
});

test("the page fits a phone screen", async ({ page }) => {
  await expectNoOverflow(page);
});

test("only the How it works page looks up its fragment as an anchor", async ({ page }) => {
  const fragment = "A".repeat(43);
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, { idLookups: calls });
    const original = document.getElementById.bind(document);
    document.getElementById = (id: string) => {
      calls.push(id);
      return original(id);
    };
  });
  const lookups = () =>
    page.evaluate(() => (window as unknown as { idLookups: string[] }).idLookups);

  // The tab title is set by the effect that runs just before the anchor lookup.
  for (const [path, title] of [
    [`/r/unknown#${fragment}`, "Receive – Fidant"],
    [`/#${fragment}`, "Fidant: private file transfer"],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveTitle(title);
    expect(await lookups()).not.toContain(fragment);
  }
  await page.goto("/how#relay");
  await expect(page).toHaveTitle("How it works – Fidant");
  expect(await lookups()).toContain("relay");
});
