import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.ts";
import type { Logger } from "./signaling.ts";
import type { IceConfig } from "./turn.ts";

const root = fileURLToPath(new URL("../../web/dist/", import.meta.url));
if (!existsSync(join(root, "index.html"))) {
  console.error("The web client is not built. Run `pnpm start` from the repository root.");
  process.exit(1);
}

// TURN is optional. Both variables or neither: half a configuration is a
// mistake, not a choice. The secret is read from a file so it never shows in
// the process environment, and it is never printed.
const turnUrls = process.env.TURN_URLS;
const turnSecretFile = process.env.TURN_SECRET_FILE;
let ice: IceConfig | undefined;
if (turnUrls || turnSecretFile) {
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
  ice = { urls, secret };
}

const lanAddresses = Object.values(networkInterfaces())
  .flat()
  .flatMap((address) => (address?.family === "IPv4" && !address.internal ? [address.address] : []));

// stdout carries only log events, one JSON object per line, so tests can parse
// it strictly. Fields are limited to LogFields, which never carry file content,
// names, metadata, keys or relay payloads. Messages for humans go to stderr.
const log: Logger = (event, fields) => console.log(JSON.stringify({ event, ...fields }));

const server = await startServer({
  port: Number(process.env.PORT ?? 8443),
  root,
  certDir: process.env.CERT_DIR ?? fileURLToPath(new URL("../../../.certs/", import.meta.url)),
  hosts: ["localhost", "127.0.0.1", ...lanAddresses],
  ice,
  log,
});

const { port } = server.address() as AddressInfo;
log("listening", { port });
console.error("Sigill is running. Open one of these and accept the certificate warning once:");
for (const host of ["localhost", ...lanAddresses]) {
  console.error(`  https://${host}:${port}`);
}
console.error(
  "On another Mac, if the page can't be reached, allow the browser under System Settings → Privacy & Security → Local Network, then restart it.",
);
