import type { Page } from "@playwright/test";
import { canaryFile, chooseFile, expect, makeName, recipientRow, test } from "../src/fixtures.ts";

const nav = (page: Page) => page.locator("header nav");

const footer = (page: Page) => page.locator("footer");

async function choose(page: Page, menu: string, option: string) {
  await footer(page).getByRole("button", { name: menu }).click();
  await page.getByRole("menuitemradio", { name: option }).click();
  await expect(page.getByRole("menu")).toBeHidden();
}

for (const path of ["/privacy", "/privacy/"]) {
  test(`${path} shows the Privacy page`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator("main h1")).toHaveText("Privacy");
    await expect(nav(page).getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
}

test("the Privacy page opens without a secure connection", async ({ page }) => {
  // The stack always serves HTTPS, so pretend the context is insecure.
  await page.addInitScript(() =>
    Object.defineProperty(window, "isSecureContext", { value: false }),
  );
  await page.goto("/send");
  await expect(page.locator("main h1")).toHaveText("This page needs a secure connection");
  await page.goto("/privacy");
  await expect(page.locator("main h1")).toHaveText("Privacy");
});

test("leaving /send for Privacy and going back keeps the file and recipient", async ({
  page,
  leaks,
  canary,
}) => {
  const file = leaks.watch(canaryFile(canary.fork("file")));
  const name = makeName(leaks, canary, "Anna");
  await page.goto("/send");
  await chooseFile(page, {
    name: file.name,
    mimeType: file.mime,
    buffer: file.bytes,
  });
  await page.getByLabel("Who is it for?").fill(name);
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  const link = await page.getByLabel(`Link for ${name}`, { exact: true }).textContent();
  leaks.watchKey("link secret", new URL(link ?? "").hash.slice(1));
  const pages = page.context().pages().length;

  // A reload would drop the transfer, so the in-app navigation must not reload.
  await page.evaluate(() => Object.assign(window, { notReloaded: true }));
  await nav(page).getByRole("link", { name: "Privacy" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.locator("main:visible h1")).toHaveText("Privacy");
  expect(page.context().pages()).toHaveLength(pages);

  await page.goBack();
  await expect(page).toHaveURL(/\/send$/);
  expect(await page.evaluate(() => "notReloaded" in window)).toBe(true);
  await expect(page.getByText(file.name, { exact: true })).toBeVisible();
  await expect(recipientRow(page, name)).toBeVisible();
  await expect(page.getByLabel(`Link for ${name}`, { exact: true })).toHaveText(link ?? "");
});

test("the menu's Send a file and the landing page's button open /send", async ({ page }) => {
  await page.goto("/privacy");
  await nav(page).getByRole("link", { name: "Send a file" }).click();
  await expect(page).toHaveURL(/\/send$/);
  await expect(page.getByLabel("Choose a file")).toBeAttached();

  await page.goto("/");
  await page.getByRole("main").getByRole("link", { name: "Send a file", exact: true }).click();
  await expect(page).toHaveURL(/\/send$/);
  await expect(page.getByLabel("Choose a file")).toBeAttached();
});

test("the language menu switches language and the choice survives a reload", async ({ page }) => {
  await page.goto("/privacy");
  await choose(page, "Language", "Svenska");
  await expect(page.locator("main h1")).toHaveText("Integritet");
  await expect(page.locator("html")).toHaveAttribute("lang", "sv");
  await page.reload();
  await expect(page.locator("main h1")).toHaveText("Integritet");

  await choose(page, "Språk", "English");
  await expect(page.locator("main h1")).toHaveText("Privacy");
  await page.reload();
  await expect(page.locator("main h1")).toHaveText("Privacy");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("the theme menu sets System, Light and Dark, and the choice survives a reload", async ({
  page,
}) => {
  const html = page.locator("html");
  await page.goto("/privacy");
  await expect(html).not.toHaveAttribute("data-theme");
  for (const [option, value] of [
    ["Light", "light"],
    ["Dark", "dark"],
    ["System", undefined],
  ] as const) {
    await choose(page, "Theme", option);
    for (const step of ["chosen", "reloaded"]) {
      if (value) {
        await expect(html).toHaveAttribute("data-theme", value);
      } else {
        await expect(html).not.toHaveAttribute("data-theme");
      }
      await footer(page).getByRole("button", { name: "Theme" }).click();
      await expect(page.getByRole("menuitemradio", { name: option })).toBeChecked();
      // Radix moves focus into the menu just after it opens; Escape before that does nothing.
      await expect(page.getByRole("menu")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toBeHidden();
      if (step === "chosen") {
        await page.reload();
      }
    }
  }
});
