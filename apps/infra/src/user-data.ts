import { readFileSync } from "node:fs";
import { boxAddress, mailFrom, primaryDomain, siteNames } from "./config.ts";

const root = new URL("../../../", import.meta.url);

export function renderUserData(): string {
  const nodeMajor = readFileSync(new URL(".node-version", root), "utf8").trim();
  const pnpmVersion = JSON.parse(
    readFileSync(new URL("package.json", root), "utf8"),
  ).packageManager.replace(/^pnpm@/, "");
  const turnserverConf = readFileSync(new URL("../box/turnserver.conf", import.meta.url), "utf8");
  return readFileSync(new URL("../box/user-data.sh", import.meta.url), "utf8")
    .replaceAll("@TURNSERVER_CONF@", turnserverConf.trimEnd())
    .replaceAll("@NODE_MAJOR@", nodeMajor)
    .replaceAll("@PNPM_VERSION@", pnpmVersion)
    .replaceAll("@REDIRECT_NAMES@", siteNames.filter((name) => name !== primaryDomain).join(", "))
    .replaceAll("@MAIL_FROM@", mailFrom)
    .replaceAll("@DOMAIN@", primaryDomain)
    .replaceAll("@BOX_ADDRESS@", boxAddress);
}
