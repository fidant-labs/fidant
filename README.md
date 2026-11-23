# Sigill

Secure file transfer. Files are encrypted in the sender's browser, and no infrastructure (our servers, hosts, relays, email) can read file content. Verified transfers add BankID identity, a signed receipt, and a tamper-evident audit log.

This repository is at the first demo: send one file from a browser to named recipients on the same network. BankID, receipts and the audit log come later.

## Run the first demo

Prerequisites:

- Node 24 (see `.node-version`).
- pnpm, at the version pinned in `package.json` (`packageManager`).
- gitleaks (`brew install gitleaks`), only if you commit. The pre-commit hook fails without it.
- openssl, for the local certificate. macOS and Linux ship with it.

Start the server:

```sh
pnpm install
pnpm start
```

`pnpm start` builds the web client and serves it over HTTPS on port 8443 (set `PORT` to change it), on all network interfaces. The first start creates a self-signed certificate in `.certs/`. The addresses to open are printed on stderr.

Send a file:

1. On the sending device, open the LAN address the server printed (like `https://192.168.1.20:8443`), not `localhost`. Links made on `localhost` won't work on other devices, and the page warns about it.
2. Accept the certificate warning. Do this once on each device.
3. Choose a file. The page computes its SHA-256 first.
4. Add each recipient by name. Each one gets their own link. Names stay in the sender's browser.
5. Copy each link and send it to that person yourself, for example in a chat.
6. The recipient opens the link, sees the file name and size, and clicks Accept. Browsers with a save picker (desktop Chrome and Edge) ask where to save the file; others offer a "Save file" link when the transfer is done.
7. The sender's row for that recipient changes to "Delivered, checksum verified" when the recipient's checksum matches.

Keep the sender's tab open until every recipient has the file. The file goes directly from the sender's browser to each recipient's browser, so it is only available while that tab is open.

A link works once: after a confirmed delivery, opening it again shows "This link has already been used". There is no resume. If a transfer drops before delivery, the recipient starts over from the beginning with the same link.

## Network tips

- Sender and recipients must be on the same network. The demo uses no STUN or TURN servers, so browsers connect only over local addresses.
- A phone hotspot is a reliable network for a demo.
- Guest Wi-Fi with client isolation does not work: devices on it can't reach each other.
- On macOS, a browser on another Mac needs Local Network access (System Settings → Privacy & Security → Local Network), or the page "can't be reached" even though `curl` works. Restart the browser after allowing it.

## What the server sees

- Random link IDs, and encrypted signaling messages it passes between browsers to set up the connection. It cannot read them, so it cannot see or change the connection details (SDP, ICE candidates, DTLS fingerprints).
- The IP addresses of the browsers that connect to it, as any web server does.

It never sees keys, file content, file names, sizes or types:

- Each link's secret is in the URL fragment (the part after `#`). Browsers don't send the fragment to the server.
- The file, its name, size and type travel only over the encrypted connection between the two browsers.
- On that connection, file sizes are padded, so the network sees only a rounded size.

Server stdout is one JSON object per line, with allowlisted fields only: the event name, the first six characters of a link ID, a count of links, a message length in bytes, a reason or error code, and the port. Messages for humans go to stderr.

## Known limits of the demo

- A link is a bearer token. Anyone who opens an unused link first gets the file, so a forwarded link can be taken by someone else.
- Tested in Chrome. Safari and Firefox results go in [docs/demo-results.md](docs/demo-results.md).
- Browsers without a save picker (Safari, Firefox) hold the whole received file in memory until it is saved, so very large files may fail there.
- One file per session. To send a different file, remove all recipients first.

## Development

- `pnpm check`: lint, typecheck, unit tests and build. Run it before every commit.
- `pnpm format`: fixes formatting and safe lint issues.
- `pnpm build`: builds the web client into `apps/web/dist`.
- `pnpm --filter @sigill/web e2e`: runs the end-to-end test of the first demo in headless Chromium against the real server. Run `pnpm build` first. Once per machine, install the browser with `pnpm --filter @sigill/web exec playwright install chromium`. `pnpm check` does not run it.

See [AGENTS.md](AGENTS.md) for the layout and conventions.
