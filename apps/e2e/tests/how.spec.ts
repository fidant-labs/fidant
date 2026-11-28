import type { Page } from "@playwright/test";
import { allowClipboard, expect, test } from "../src/fixtures.ts";

// The drawings animate, which the config's reduced motion would turn off.
test.use({ reducedMotion: "no-preference" });

const SECTIONS = [
  "stays",
  "encryption",
  "link",
  "open",
  "direct",
  "relay",
  "transfer",
  "verification",
  "masking",
  "never",
  "protection",
  "tech",
];

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
  await expect(page.locator("header nav").getByRole("link")).toHaveCount(3);
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

test("the landing page links to the steps, which end with a link to /privacy", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Read how it works" }).click();
  await expect(page).toHaveURL(/\/how$/);
  await expect(page.locator("main h1")).toHaveText("How it works");

  const sections = page.locator("main section");
  await expect(sections).toHaveCount(SECTIONS.length);
  for (const [index, id] of SECTIONS.entries()) {
    await expect(sections.nth(index)).toHaveId(id);
    await expect(sections.nth(index).locator("h2")).toHaveCount(1);
    await expect(sections.nth(index).locator(':scope > svg[aria-hidden="true"]')).toHaveCount(1);
  }
  await expect(page.getByRole("link", { name: "Read the privacy page" })).toHaveAttribute(
    "href",
    "/privacy",
  );
  await expect(page.locator("footer").getByRole("link", { name: "How it works" })).toHaveAttribute(
    "href",
    "/how",
  );
});

test("each step has a Read more page with the step menu and the next step", async ({ page }) => {
  const slugs = [
    "file",
    "encryption",
    "link",
    "connect",
    "direct",
    "relay",
    "transfer",
    "verification",
    "masking",
    "traces",
    "protection",
    "tech",
  ];
  await page.goto("/how");
  const menu = page.getByRole("navigation", { name: "Steps" }).getByRole("link");
  await expect(menu).toHaveCount(slugs.length + 1);
  await expect(menu.first()).toHaveAttribute("aria-current", "page");
  const readMore = page.getByRole("link", { name: /^Read more/ });
  await expect(readMore).toHaveCount(slugs.length);
  for (const [index, slug] of slugs.entries()) {
    await expect(readMore.nth(index)).toHaveAttribute("href", `/how/${slug}`);
  }

  await readMore.first().click();
  await expect(page).toHaveURL(/\/how\/file$/);
  await expect(page.locator("main h1")).toHaveText("Your file stays on your computer");
  await expect(page.locator("main h1")).toBeFocused();
  await expect(page).toHaveTitle("Your file stays on your computer – Fidant");
  await expect(menu.nth(1)).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#parts")).toBeVisible();

  await page.getByRole("link", { name: "It is locked twice" }).click();
  await expect(page).toHaveURL(/\/how\/encryption$/);
  await expect(menu.nth(2)).toHaveAttribute("aria-current", "page");

  await menu.nth(3).click();
  await expect(page).toHaveURL(/\/how\/link$/);
  await expect(
    page.getByRole("heading", { name: "How the link reaches the recipient" }),
  ).toBeVisible();
  await expect(page.getByRole("table", { name: "Who can see the key" })).toBeVisible();

  // A technical word links to its entry in the word list, which scrolls into view and takes focus.
  await page.goto("/how/direct");
  await page.locator('main a[href="/how/tech#stun"]').first().click();
  await expect(page).toHaveURL(/\/how\/tech#stun$/);
  await expect(page.locator("#stun h2")).toBeFocused();
  await expectBelowHeader(page, "#stun");

  // An in-app link to the entry already in the address still brings it back into view.
  await page.goto("/how/tech#dtls");
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await page.locator('#aes a[href="/how/tech#dtls"]').click();
  await expect(page).toHaveURL(/\/how\/tech#dtls$/);
  await expectBelowHeader(page, "#dtls");
  await expect(page.locator("#dtls h2")).toBeFocused();

  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const slug of slugs) {
      await page.goto(`/how/${slug}`);
      await expect(page.locator("main h1")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
  }
});

test("the old /technical address opens /how", async ({ page }) => {
  await page.goto("/technical");
  await expect(page).toHaveURL(/\/how$/);
  await expect(page.locator("main h1")).toHaveText("How it works");
});

test("a heading's button copies a link to its section", async ({ page, context }) => {
  await page.goto("/how/link");
  await allowClipboard(context, new URL(page.url()).origin);
  await page.locator("#linkRisks h2").hover();
  await page.locator("#linkRisks").getByRole("button", { name: "Copy link to this part" }).click();
  const origin = new URL(page.url()).origin;
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${origin}/how/link#linkRisks`,
  );
  await expect(page.locator("#linkRisks [aria-live]")).toHaveText("Link copied");
});

test("the top nav links to How it works between Send and Privacy", async ({ page }) => {
  await page.goto("/how");
  const links = page.locator("header nav").getByRole("link");
  await expect(links).toHaveText(["Send", "How it works", "Privacy"]);
  await expect(links.nth(0)).toHaveAttribute("href", "/send");
  await expect(links.nth(1)).toHaveAttribute("href", "/how");
  await expect(links.nth(1)).toHaveAttribute("aria-current", "page");
  await expect(
    page.locator("footer").getByRole("link", { name: "Share a secret" }),
  ).toHaveAttribute("href", "/send/secret");
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

  test("the Swedish header fits all three links at 768 px", async ({ page }) => {
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
