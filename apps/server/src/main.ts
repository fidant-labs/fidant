import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.ts";

const root = fileURLToPath(new URL("../../web/dist/", import.meta.url));
if (!existsSync(join(root, "index.html"))) {
  console.error("The web client is not built. Run `pnpm start` from the repository root.");
  process.exit(1);
}

const lanAddresses = Object.values(networkInterfaces())
  .flat()
  .flatMap((address) => (address?.family === "IPv4" && !address.internal ? [address.address] : []));

const server = await startServer({
  port: Number(process.env.PORT ?? 8443),
  root,
  certDir: fileURLToPath(new URL("../../../.certs/", import.meta.url)),
  hosts: ["localhost", "127.0.0.1", ...lanAddresses],
  // One JSON line per event. Fields are limited to LogFields, which never
  // carry file content, names, metadata, keys or relay payloads.
  log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
});

const { port } = server.address() as AddressInfo;
console.log("Sigill is running. Open one of these and accept the certificate warning once:");
for (const host of ["localhost", ...lanAddresses]) console.log(`  https://${host}:${port}`);
console.log(
  "On another Mac, if the page can't be reached, allow the browser under System Settings → Privacy & Security → Local Network, then restart it.",
);
