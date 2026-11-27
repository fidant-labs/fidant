import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIceServers } from "@fidant/protocol";
import { type Mailer, smtpMailer } from "./mail.ts";
import { loadRelays, type Relays, readOrCreateMaster, startRelays } from "./relays.ts";
import { startServer } from "./server.ts";
import { type SiteSettings, siteSettings } from "./settings.ts";
import type { Logger } from "./signaling.ts";
import { chooseIce, type IceConfig } from "./turn.ts";

let site: SiteSettings;
try {
  site = siteSettings(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

let root: string | undefined;
if (site.pages) {
  root = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (!existsSync(join(root, "index.html"))) {
    console.error("The web client is not built. Run `pnpm start` from the repository root.");
    process.exit(1);
  }
}

// A relay list that isn't empty replaces TURN_URLS. The messages name no secret.
let relays: Relays | undefined;
try {
  const list = loadRelays(process.env, existsSync("/var/lib/sigill"));
  relays = list && startRelays(list.relays, readOrCreateMaster(list.masterFile));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

// TURN is optional. Both variables or neither: half a configuration is a
// mistake, not a choice. The secret is read from a file so it never shows in
// the process environment, and it is never printed.
const turnUrls = process.env.TURN_URLS;
const turnSecretFile = process.env.TURN_SECRET_FILE;
let turn: IceConfig | undefined;
if (!relays && (turnUrls || turnSecretFile)) {
  if (!turnUrls || !turnSecretFile) {
    console.error("Set both TURN_URLS and TURN_SECRET_FILE, or neither.");
    process.exit(1);
  }
  let secret: string;
  try {
    secret = readFileSync(turnSecretFile, "utf8").trim();
  } catch {
    console.error("Could not read the file named by TURN_SECRET_FILE.");
    process.exit(1);
  }
  const urls = turnUrls
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (!secret || urls.length === 0) {
    console.error("TURN_URLS and the file named by TURN_SECRET_FILE must not be empty.");
    process.exit(1);
  }
  // The same check browsers apply to `joined`, so a bad URL fails here, not in every pairing.
  if (!parseIceServers([{ urls, username: "", credential: "" }])) {
    console.error("TURN_URLS must be 1 to 4 turn:, turns: or stun: URLs.");
    process.exit(1);
  }
  turn = { urls, secret };
}
const ice = chooseIce(relays, turn, site.stun);

// Mail is optional too, and the SMTP password comes from a file for the same reason.
// Emailed links point at PUBLIC_ORIGIN, never at whatever Host a request names.
// Without MAIL_ENABLED=1 the mail settings are ignored, so a box that has them sends nothing.
const mailUrl = process.env.MAIL_SMTP_URL;
const mailFrom = process.env.MAIL_FROM;
const mailPasswordFile = process.env.MAIL_PASSWORD_FILE;
const publicOrigin = site.origin;
let mail: { send: Mailer; origin: string } | undefined;
if (site.mail) {
  if (!mailUrl || !mailFrom || !publicOrigin) {
    console.error("MAIL_ENABLED=1 needs MAIL_SMTP_URL and MAIL_FROM together with PUBLIC_ORIGIN.");
    process.exit(1);
  }
  let password: string | undefined;
  if (mailPasswordFile) {
    try {
      password = readFileSync(mailPasswordFile, "utf8").trim();
    } catch {
      console.error("Could not read the file named by MAIL_PASSWORD_FILE.");
      process.exit(1);
    }
    if (!password) {
      console.error("The file named by MAIL_PASSWORD_FILE must not be empty.");
      process.exit(1);
    }
  }
  try {
    mail = { send: smtpMailer({ url: mailUrl, from: mailFrom, password }), origin: publicOrigin };
  } catch (error) {
    // smtpMailer's own messages, which echo nothing from the configuration.
    console.error((error as Error).message);
    process.exit(1);
  }
}

// For tests only: how long after start a join for a link nobody hosts is refused as `starting`
// (default STARTING_MS in @fidant/protocol, docs/decisions/0018-restart-warm-up-window.md).
const startingEnv = process.env.STARTING_MS;
if (startingEnv !== undefined && !/^\d+$/.test(startingEnv)) {
  console.error("STARTING_MS must be a whole number of milliseconds.");
  process.exit(1);
}

const lanAddresses = Object.values(networkInterfaces())
  .flat()
  .flatMap((address) => (address?.family === "IPv4" && !address.internal ? [address.address] : []));

// stdout carries only log events, one JSON object per line, so tests can parse
// it strictly. Fields are limited to LogFields, which never carry file content,
// names, metadata, keys or relay payloads. Messages for humans go to stderr.
const log: Logger = (event, fields) => console.log(JSON.stringify({ event, ...fields }));

const { server, signaling } = await startServer({
  port: Number(process.env.PORT ?? 8443),
  root,
  siteOrigin: site.origin,
  proxies: site.proxies,
  certDir: process.env.CERT_DIR ?? fileURLToPath(new URL("../../../.certs/", import.meta.url)),
  hosts: ["localhost", "127.0.0.1", ...lanAddresses],
  ice,
  relays,
  log,
  mail,
  startingMs: startingEnv === undefined ? undefined : Number(startingEnv),
  keepAliveMs: site.keepAliveMs,
});

const { port } = server.address() as AddressInfo;
log("listening", { port });

// On a restart, close every socket with SERVICE_RESTART so browsers reconnect at once instead of
// counting a failure. Exit within a second even if a socket never answers its close frame.
process.once("SIGTERM", () => {
  signaling.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
// Only for a person at a terminal. Under systemd stderr goes to the journal, which should hold
// nothing but the allowlisted log lines, not the box's addresses.
if (process.stderr.isTTY && site.pages) {
  console.error("Fidant is running. Open one of these and accept the certificate warning once:");
  for (const host of ["localhost", ...lanAddresses]) {
    console.error(`  https://${host}:${port}`);
  }
  console.error(
    "On another Mac, if the page can't be reached, allow the browser under System Settings → Privacy & Security → Local Network, then restart it.",
  );
}
