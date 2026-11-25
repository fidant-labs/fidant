import { choose, expect, makeName, test } from "../src/fixtures.ts";

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("/sv/security is the Swedish security page with its own head", async ({ page }) => {
    await page.goto("/sv/security");
    await expect(page.locator("main h1")).toHaveText("Säkerhet");
    await expect(page).toHaveTitle("Säkerhet – Fidant");
    await expect(page.locator("html")).toHaveAttribute("lang", "sv");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://fidant.se/sv/security",
    );
    for (const [lang, href] of [
      ["en", "https://fidant.se/security"],
      ["sv", "https://fidant.se/sv/security"],
      ["x-default", "https://fidant.se/security"],
    ] as const) {
      await expect(page.locator(`link[rel="alternate"][hreflang="${lang}"]`)).toHaveAttribute(
        "href",
        href,
      );
    }
  });

  test("an English page links to the other English pages", async ({ page }) => {
    await page.goto("/how");
    await expect(page.locator("main h1")).toHaveText("How it works");
    await page
      .locator("main")
      .getByRole("link", { name: /Read more/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/how\/file$/);
    await expect(page.locator("main h1")).not.toBeEmpty();
  });
});

test("every page in the sitemap answers with its own canonical", async ({ request }) => {
  const sitemap = await (await request.get("/sitemap.xml")).text();
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? "");
  expect(urls).toHaveLength(40);
  for (const url of urls) {
    const res = await request.get(url.replace("https://fidant.se", ""), { maxRedirects: 0 });
    expect(res.status(), url).toBe(200);
    expect(await res.text(), url).toContain(`<link rel="canonical" href="${url}" />`);
  }
  const llms = await (await request.get("/llms.txt")).text();
  for (const url of urls) {
    expect(llms, url).toContain(`](${url}): `);
  }
});

test("unknown paths are 404 and receive links are noindex", async ({ request }) => {
  const missing = await request.head("/no-such-page");
  expect(missing.status()).toBe(404);
  const receive = await request.head("/r/AAAAAAAAAAAAAAAAAAAAAA");
  expect(receive.status()).toBe(200);
  expect(receive.headers()["x-robots-tag"]).toBe("noindex");
  expect((await request.head("/about")).headers()["x-robots-tag"]).toBeUndefined();
});

test("the not-found page says so and links home", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.locator("main h1")).toHaveText("Page not found");
  await expect(page).toHaveTitle("Page not found – Fidant");
  await page.getByRole("main").getByRole("link", { name: "Go to the front page" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test.describe("in a Swedish browser", () => {
  test.use({ locale: "sv-SE" });

  test("/ opens /sv before any English shows", async ({ page }) => {
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const seen = JSON.parse(sessionStorage.getItem("seen") ?? "[]");
        seen.push([location.pathname, document.documentElement.hidden]);
        sessionStorage.setItem("seen", JSON.stringify(seen));
      });
    });
    await page.goto("/");
    await expect(page).toHaveURL(/\/sv$/);
    await expect(page.locator("main h1")).toHaveText(
      "Skicka en fil som bara mottagaren kan öppna.",
    );
    const seen: [string, boolean][] = JSON.parse(
      (await page.evaluate(() => sessionStorage.getItem("seen"))) ?? "[]",
    );
    // The English page may never finish parsing; if it did, it was hidden.
    expect(seen.filter(([path, hidden]) => path === "/" && !hidden)).toEqual([]);
  });

  test("a stored choice of English keeps the English page", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("lang", "en"));
    await page.goto("/about");
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator("main h1")).toHaveText("About Fidant");
  });
});

test("switching language while sharing keeps the share, and the recipient still gets it", async ({
  actor,
  leaks,
  canary,
}) => {
  const name = makeName(leaks, canary, "Anna");
  const text = `language-switch-${makeName(leaks, canary, "text")}`;
  leaks.watchContent("text", text);
  const { page: sender } = await actor("sender");
  await sender.goto("/secret");
  await sender.getByLabel("Your secret").fill(text);
  await sender.locator("#secret-recipient-name").fill(name);
  await sender.getByRole("button", { name: "Create link", exact: true }).click();
  const link = (await sender.getByLabel(`Link for ${name}`, { exact: true }).textContent()) ?? "";
  leaks.watchKey("link secret", new URL(link).hash.slice(1));

  await sender.evaluate(() => Object.assign(window, { notReloaded: true }));
  await choose(sender, "Language", "Svenska");
  await expect(sender).toHaveURL(/\/sv\/secret$/);
  await expect(sender.locator("html")).toHaveAttribute("lang", "sv");
  expect(await sender.evaluate(() => "notReloaded" in window)).toBe(true);
  await expect(sender.getByLabel(`Länk till ${name}`, { exact: true })).toHaveText(link);

  const { page: recipient } = await actor("recipient");
  await recipient.goto(link);
  await recipient.getByRole("button", { name: "Show", exact: true }).click();
  await expect(recipient.getByRole("region", { name: "The secret", exact: true })).toHaveText(text);
});

test("back after a language switch shows the earlier page in the new language", async ({
  page,
}) => {
  await page.goto("/privacy");
  await page.locator("header nav").getByRole("link", { name: "How it works" }).click();
  await expect(page).toHaveURL(/\/how$/);
  await choose(page, "Language", "Svenska");
  await expect(page).toHaveURL(/\/sv\/how$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/sv\/privacy$/);
  await expect(page.locator("main h1")).toHaveText("Integritet");
  await page.locator("header nav").getByRole("link", { name: "Skicka en fil" }).click();
  await expect(page).toHaveURL(/\/sv\/send$/);
});
