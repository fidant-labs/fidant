# 0015: Switching the app to the relay box

- Status: Accepted
- Date: 2026-11-25
- Linear: SIG-153

## Context

In this record, 0013 is `docs/decisions/0013-relay-service.md`.

- 0013 built the Stockholm relay box, `fidant-relay-sto-<hash>`, from `apps/infra/relay/install.sh`. It asks `https://fidant.se/relay-secret/sto` for its secret every minute. Until SIG-153 nothing serves that path, so the relay box has no secret, answers STUN and refuses every TURN allocation. Every relayed transfer goes through the app box's coturn at `turn.fidant.se` (0007).
- 0013 fixed the hand-out's contract: the body is the relay's secret, sealed to the relay's public key with RSA-OAEP. It left the app's side to SIG-153: where the trusted public keys live, where each relay's secret comes from, when the app offers a relay, and moving 0011's cap to the relay box.
- The app box's user data sets the app's environment once, through the drop-in `turn.conf` (0007). A change to the user data replaces the box (0007, 0013). SIG-153 must replace neither box.
- The `sensitive-paths` ruleset asks for a `maintainers` approval on `apps/infra/**`, but not on `apps/server/`. The infra deploy checks out only `apps/infra/` and a few root files, so the CDK app can't read a file in `apps/server/`.
- Lightsail adds up the data transfer allowance of instances of the same bundle in a Region, and counts traffic in and out ([Data transfer in Lightsail](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-data-transfer-allowance.html)). Both boxes are `micro_3_0` in eu-north-1, so they draw on one pool. The guide's example gives the pool for instances that run "for a full month", and doesn't say what a box created during the month adds.

## Options considered

### How the app box's server finds the relay list

| Option                                                                                                    | For                                                     | Against                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| The release's `apps/server/relays.json` when `RELAYS_FILE` is unset and `/var/lib/sigill` exists (chosen) | No user-data change, so the merge replaces neither box. | An implicit rule: any machine with that directory uses the committed list, the networks suite's box too. |
| `RELAYS_FILE` in the app box's user data                                                                  | Explicit.                                               | Replaces the app box.                                                                                    |
| The committed list wherever `TURN_SECRET_FILE` is set                                                     | Already set on the box.                                 | Ties two unrelated settings together.                                                                    |
| The committed list everywhere                                                                             | The simplest.                                           | `pnpm start` and both e2e suites would check and offer `sto`.                                            |

### Where the relay list lives

| Option                                                         | For                                                                              | Against                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/server/relays.json`, added to `sensitive-paths` (chosen) | Next to the code that reads it. `apps/server` imports nothing from `apps/infra`. | A maintainer extends the ruleset by hand.                                              |
| `apps/infra/relays.json`                                       | Already in `sensitive-paths`.                                                    | The server reads a file of the infra app, and every key change starts an infra deploy. |

### Fields of a relay in the list

| Option                                | For                                   | Against                                     |
| ------------------------------------- | ------------------------------------- | ------------------------------------------- |
| `id`, `urls` and `publicKey` (chosen) | Only what the app reads today.        | A name and a location need a later change.  |
| Also a name and a location            | Ready for a choice of relay by place. | Fields nothing reads, which nothing checks. |

### The master that every relay's secret comes from

| Option                                             | For                                                                           | Against                                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A file kept until the app box is replaced (chosen) | Secrets survive deploys and reboots, so the relays keep working through them. | On disk, readable by anything that runs as `sigill`.                                                  |
| A new master at every start                        | Nothing on disk.                                                              | Every deploy changes every relay's secret, and pairings get no relay for about 2.5 minutes each time. |

### What `joined` carries when no relay is up

| Option                                                         | For                                                                     | Against                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| The first listed relay's `stun:` URLs, no credentials (chosen) | Browsers still learn their public address while the relay answers STUN. | Nothing works when the relay box is down altogether. |
| No ICE servers                                                 | Nothing to explain.                                                     | Drops STUN too, as 0009 notes.                       |

### What the cap counts and closes

| Option                                                  | For                                                                       | Against                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Both boxes, summed, and each box's relay ports (chosen) | Counts the pool both boxes draw on, and also closes the app box's coturn. | Two port lists to keep right.                                |
| The relay box only                                      | One box.                                                                  | The app box's coturn and its traffic still draw on the pool. |

### The cap's limit

| Option                                  | For                                                                                   | Against                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1.8 TB, summed over both boxes (chosen) | Stays under one box's 2 TB, whatever a box created during the month adds to the pool. | Leaves most of the relay box's allowance unused until SIG-154.              |
| 3.8 TB                                  | Uses both boxes' allowance.                                                           | The guide doesn't say that a box created during the month adds a full 2 TB. |

### The app box's `TURN_URLS`

| Option                      | For                                                                    | Against                                                                                 |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Kept until SIG-154 (chosen) | Committing `[]` returns to the app box's coturn, with no infra deploy. | Two relays to keep running.                                                             |
| Removed now                 | One relay.                                                             | Changes the user data, which replaces the app box, and leaves no relay to roll back to. |

## Decision

The app offers the relays in a committed relay list, `apps/server/relays.json`, today the Stockholm relay box. It derives each relay's secret from one master on the app box, hands it out sealed to the relay's public key, and offers a relay only while a TURN allocation on it succeeds. The app box's coturn stays, and the app uses it only without a relay list, until SIG-154.

### The relay list

- `apps/server/relays.json` is a JSON array. Each entry has exactly `id`, `urls` and `publicKey`:
  - `id` is the relay's `RELAY_ID` (0013), matches `^[a-z][a-z0-9]{1,15}$` and is unique in the list.
  - `urls` are 1 to 4 `stun:`, `turn:` or `turns:` URLs that pass `parseIceServers` (0006). At least one is `turn:<host>:<port>?transport=udp`. The first such URL is what the check targets, and its host is a name or an IPv4 address.
  - `publicKey` is the relay's `/etc/fidant-relay/relay.pub`, an RSA key of at least 2048 bits in SPKI PEM.
- `[]` means no relay list.
- The server reads the list at startup. A list that doesn't parse stops the server, with a message that names the entry only by its position. `sigill-deploy` then keeps the old release and writes `/opt/sigill/failed-<sha>`. A unit test parses the committed list, so `pnpm check` keeps a bad one from merging.
- The committed list holds `sto`, with `stun:sto.relay.fidant.se:3478`, `turn:sto.relay.fidant.se:3478?transport=udp` and `turns:sto.relay.fidant.se:443?transport=tcp`, and the relay box's 3072-bit key. A test pins the key's SPKI SHA-256.
- A name and a location are left out until something reads them.
- In SIG-153's pull request the list stays `[]` until the commit that adds `sto`, so every commit before it leaves production unchanged.
- `apps/server/relays.json` is in the `sensitive-paths` ruleset, so a change to it needs an approval from the `maintainers` team, as 0013 asked before the first key. Agents never change rulesets, so a maintainer added the path.

### How the server finds the relay list

In this order:

1. `RELAYS_FILE` is set and not empty: the list in that file.
2. `RELAYS_FILE` is unset and `/var/lib/sigill` exists: the release's own `apps/server/relays.json`. `/var/lib/sigill` is the `sigill` user's home, which the app box and the networks suite's box have.
3. Otherwise, or when the list is `[]`, or when `RELAYS_FILE` is set but empty: no relay list. The server uses `TURN_URLS` and `TURN_SECRET_FILE` as before (0006, 0007), or hands out no ICE servers without them.

- In 1 and 2 the master file is `RELAY_MASTER_FILE`, or `/var/lib/sigill/relay-master` when that is unset or empty.
- A relay list that isn't empty replaces `TURN_URLS` and `TURN_SECRET_FILE`. The server doesn't read them, and says nothing about it, because its stderr reaches the journal.
- On the app box `RELAYS_FILE` is unset, so the merge needs no user-data change.

### The master and each relay's secret

- The master is 32 random bytes, kept in the master file as 64 lowercase hex characters and a newline.
- At startup the server creates the master file when it is missing, mode 0600, with an exclusive create, and otherwise reads it. A master file that doesn't hold 64 lowercase hex characters stops the server. No message quotes the file.
- The master file is in `sigill`'s home, so it survives deploys and reboots. A replaced app box makes a new master.
- A relay's secret is HMAC-SHA256 with the master's 32 bytes as the key and the relay's `id` as the message, as 64 lowercase hex characters. A unit test checks it against openssl.
- The server mints TURN credentials for a relay from that secret, as in 0006: per pairing, valid for 5 minutes, only in `joined`.

### The hand-out

- At startup the server seals each relay's secret to its `publicKey` with `sealRelaySecret` (0013), once, and keeps the result.
- `GET` or `HEAD /relay-secret/<id>` answers 200 `text/plain; charset=utf-8` with the sealed secret and one newline, `cache-control: no-store` and the site's security headers.
- An `id` that isn't in the list, any other path under `/relay-secret/`, and every `id` when there is no relay list get 404. Methods other than `GET` and `HEAD` get 405.
- It needs no authentication. Only the relay's private key opens the body.

### The check

`apps/server/src/turn-check.ts` checks a relay with a real allocation, from the app box, over UDP and IPv4:

1. An Allocate without credentials must get 401 with REALM and NONCE.
2. An Allocate with credentials minted from the relay's secret, with the username `<expiry>:probe` and that realm and nonce, must succeed. Its XOR-RELAYED-ADDRESS must be the IPv4 address the relay's name resolves to, which catches a wrong `external-ip` (0013).
3. A Refresh with LIFETIME 0 releases the allocation. Its answer is ignored.

- A check takes at most 5 seconds. It doesn't retransmit, doesn't retry on a stale nonce, and doesn't verify the answers' MESSAGE-INTEGRITY, because the random 96-bit transaction ID matches them.
- It never throws and never logs.

### Up and down

- A relay starts down. A check that passes makes it up. Two failed checks in a row make it down. A check that throws counts as failed.
- The server checks every relay at startup and then every 60 seconds.

### Choosing a relay

- `joined` carries the first relay in list order that is up:
  - when the sender allows the relay, its URLs with fresh credentials;
  - when the sender refuses it, its `stun:` URLs only (0008).
- When no relay is up, `joined` carries the first listed relay's `stun:` URLs, without credentials. The server never falls back to `TURN_URLS` while it has a relay list.
- The signaling protocol doesn't change.

### `/relay-status`

`GET` or `HEAD /relay-status` answers 200 `application/json` with `cache-control: no-store` and the site's security headers. The body lists the relays in list order, such as `[{"id":"sto","up":true}]`, or is `[]` without a relay list. It needs no authentication.

### Logs

- There are no new log events. `LogEvent`, the server's log allowlist and /privacy stay as they are.
- The master, the relay secrets and the sealed hand-outs never reach a log line, a command line, CloudFormation or the Lambda's environment.

### The cap

- 0011's Lambda counts both boxes. `BOXES` replaces `BOX`, `OPEN_PORTS` and `CAPPED_PORTS`, with each box's name, its open ports and the ports it keeps when capped:
  - the app box: the 6 ports of 0011, capped to TCP 80, 443 and 22;
  - the relay box: its 6 ports (0013), capped to TCP 22 from `lightsail-connect` and TCP 80, so certbot can still renew. That closes 443, 3478 and the UDP range.
- `/fidant/relay-cap` keeps each box's count, as in 0011. The total is their sum. At or above the limit, every box gets its capped ports. On the first run below the limit after a capped run, every box gets its open ports again.
- The limit stays at 1.8 TB (`relayCapBytes`), now for both boxes together, and the warning at 1.44 TB. SIG-154 replaces the byte limit with a cost cap.
- The Lambda may call `lightsail:PutInstancePublicPorts` only on the two boxes' instance ARNs. The action takes the Instance resource type ([Actions, resources, and condition keys for Amazon Lightsail](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonlightsail.html)).

### Status metrics and alarms

- Each run of the Lambda also fetches `https://fidant.se/relay-status`, with a 10-second limit. It counts as read only when the answer is 200, `application/json` and an array of exactly `{id: string, up: boolean}`. The site's page, which a release without the route serves, fails that.
- The run logs two metrics, namespace `Fidant`:
  - `RelayStatusOk` (`Service=relay`): 1 when the status was read, else 0;
  - `RelayUp` (`Relay=<id>`): 1 or 0 for each relay in `RELAYS`, only when the status was read.
- `RELAYS` is `["sto"]`, from `relays` in `apps/infra/src/config.ts`, because the CDK app can't read `apps/server/relays.json`.
- A failed fetch doesn't fail the run. The cap runs after it either way.
- Two more alarms email the topic of 0011's alarms, also when they return to OK:
  - "Fidant relay sto unavailable", when `RelayUp` for `sto` is below 1;
  - "Fidant relay status unreachable", when `RelayStatusOk` is below 1.
- Each needs 2 of 2 five-minute periods and ignores missing data. Two periods ride out a deploy's restart.
- Nothing secret goes to CloudFormation, so there is no custom resource.

### Tests

- `pnpm e2e` gives the server a relay list of two relays on the one local coturn: first `bad`, whose secret coturn doesn't have, then `loc`. `/relay-status` must be exactly `[{"id":"bad","up":false},{"id":"loc","up":true}]`, so `bad` is never offered, and forced relay transfers go through `loc`.
- `pnpm e2e:networks` gives its server the list `[net, sto]`. `net` is the coturn container. `sto` is the relay box container (0013), which takes its secret from that server through the real `fidant-relay-secret`. The box container sets `RELAYS_FILE` empty, so it stays on its own coturn.

### Rollback

- Committing `[]` to `apps/server/relays.json` returns the app to the app box's coturn through `TURN_URLS`, once the app box deploys it, with no infra deploy. A unit test covers that `[]` means no relay list.
- Without a pull request, a drop-in on the app box turns the relay list off at once (see Runbook).

### Replacements to 0006, 0007, 0011 and 0013

This record amends 0006, 0007, 0011 and 0013. They are not superseded. Read them with these replacements.

| Where it says                                                                                                                                                   | Read                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0006: "The TURN secret stays in the server process. `main.ts` reads it from `TURN_SECRET_FILE`, and only minted credentials leave the process."                 | The same without a relay list. With one, each relay's secret comes from the master in the master file, and leaves the process only as minted credentials and sealed to that relay's key in `/relay-secret/<id>`. |
| 0006: "`main.ts` checks `TURN_URLS` at startup with the protocol's `parseIceServers`"                                                                           | The same, and each relay's `urls` in the relay list get the same check.                                                                                                                                          |
| 0007: "coturn from Ubuntu 24.04's package (4.6.1) runs on the app box, next to the app." and "The relay can move to its own box later by changing that record." | The app box's coturn is used only without a relay list. Relayed transfers go through the relays in `apps/server/relays.json`, today the Stockholm relay box. `turn.fidant.se` stays on the app box.              |
| 0007: "`TURN_URLS` is `stun:turn.fidant.se:3478`, … plus `stun:[<IPv6>]:3478` when the box has a global IPv6 address at first boot."                            | The same for the app box's coturn. `sto` has three URLs and no IPv6 one (see Consequences).                                                                                                                      |
| 0007: "A coturn failure after first boot doesn't change the app: it keeps handing out the URLs."                                                                | Still true of the app box's coturn without a relay list. A relay in the list is down after two failed checks, about 2 minutes, and the app then hands out only the first listed relay's `stun:` URLs.            |
| 0007, Emergency stop: "The app still hands out the TURN URLs."                                                                                                  | While the app has a relay list, it hands out no `turn.fidant.se` URLs, so stopping the app box's coturn ends only the relayed transfers that run through it.                                                     |
| 0011: "It sums `NetworkIn` and `NetworkOut` for the box"                                                                                                        | It sums them for every box in `BOXES`: the app box and the relay box.                                                                                                                                            |
| 0011: "At or above the limit it calls `put-instance-public-ports` with TCP 80, 443 and 22 only." and "it puts the full list back"                               | Each box gets its own capped ports, and then its own open ports (see "The cap").                                                                                                                                 |
| 0011: "Another Lightsail instance of the same bundle in the region uses the pooled allowance too. The Lambda does not count it."                                | The Lambda counts the relay box too. An instance outside `BOXES` still isn't counted.                                                                                                                            |
| 0011: "About 0.30 USD a month for the three alarms."                                                                                                            | Plus the two alarms and two metrics of this record (see Consequences).                                                                                                                                           |
| 0011, Pause the cap: "restore all six ports by hand with `put-instance-public-ports`"                                                                           | Restore each box's open ports by hand: the app box's 6 ports in 0011 and the relay box's 6 ports in 0013.                                                                                                        |
| 0013: "The app box doesn't change, and 0011's cap still watches only the app box."                                                                              | The cap counts both boxes and closes both boxes' relay ports.                                                                                                                                                    |
| 0013: "The app therefore keeps one secret per relay that survives app restarts and changes only when the app box is replaced (SIG-153)."                        | The app derives each relay's secret from the master, which survives deploys and reboots. The secret changes when the app box is replaced, or when the master file is deleted and the app restarted.              |
| 0013: "The relay box carries no relayed transfers until SIG-153, which moves the cap to it."                                                                    | The relay box carries relayed transfers, and the cap counts it together with the app box.                                                                                                                        |
| 0013, A leaked secret: "step 0 is to replace the app box, which makes new secrets" and "later than when the new app box came up"                                | Step 0 is "New secrets for every relay" below, and the time to compare with is when its restart ran.                                                                                                             |

## Consequences

- Neither box is replaced: nothing that `renderUserData()` or `renderRelayUserData()` reads changes, and `apps/infra/src/stacks.test.ts` pins both instance names.
- Right after the merge, `sto` is down until the app box runs the new release, the relay box fetches its new secret (within about 80 seconds, 0013) and the next check passes (within 60 seconds). For about 2.5 minutes, new pairings get only `sto`'s `stun:` URL, so a transfer that needs a relay fails.
- "Fidant relay status unreachable" may fire right after the merge. The infra deploy can put the new Lambda in place while the app box still runs the old release, which answers `/relay-status` with the site's page. It returns to OK once the new release runs.
- Anything that runs as `sigill` on the app box can read the master: the server, and also the code that `sigill-deploy` runs at build time, because `pnpm install` and `pnpm build` run as `sigill` with `HOME=/var/lib/sigill`. A dependency's install script or build step can therefore read it. With the master, someone can derive every relay's secret and mint TURN credentials for every relay. That gives them use of the relays, not file content: a relay carries only DTLS and AES-GCM traffic (0007). The TURN secret of 0007 reaches the app only through `LoadCredential=`, so build-time code can't read that one.
- A relay's secret changes only with the master. After a leak, "New secrets for every relay" below makes new ones, and 0013's runbook then removes the old one from the relay.
- With a relay list, there is no fallback while the relays are down. A relay box that is off or refuses its check leaves pairings with its `stun:` URL only, which doesn't answer when coturn is stopped, so browsers then get no STUN either. The drop-in under Runbook brings back the app box's coturn.
- A replaced relay box has a new key pair (0013). The app's hand-out is sealed to the old key, so the new box can't open it, fails its check and stays down until a pull request with its new key merges.
- The check's username carries the label `probe`, as `<expiry>:probe`. Credentials for browsers carry no label (0006). In a temporary relay log (0007's runbook), the check's allocations show as `user <…:probe>`, so they are told apart from transfers. The label names no pairing, person or browser.
- Each check holds one allocation on the relay until its Refresh releases it, and counts toward the relay's `total-quota=200` while it does. The relay box sees the app box's address every minute, from the check and from its own fetch of the hand-out.
- The app box's `TURN_URLS` holds a fourth URL, `stun:[<IPv6>]:3478`, when the box has a global IPv6 address (0007). `sto` has no IPv6 URL, because the list is committed and a box's IPv6 address changes with the box. So browsers learn no public IPv6 address from our STUN service, and a pair whose only direct route was over IPv6 through that address may now need the relay. The relay is reached over IPv4 only, as before: `sto.relay.fidant.se` has only an A record.
- `/relay-status` is public, so anyone can see which relays exist and whether they are up.
- Committing `[]` leaves the relay box running with its last secret. The app then mints no credentials for it, and answers its fetch with 404, which changes nothing on the relay (0013).
- Two more standard alarms cost 0.10 USD per alarm metric a month, and `RelayStatusOk` and `RelayUp` for `sto` 0.30 USD per custom metric a month, at list price ([Amazon CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)). That is about 0.80 USD a month at most. Each further relay adds one alarm and one `RelayUp` metric.
- The pool both boxes draw on is now counted whole, and 1.8 TB stays under one box's allowance. Until SIG-154, a month can stop the relays with most of the relay box's allowance unused.

## Runbook

`aws` commands need `aws sso login --sso-session fidant` first. Commands on a box use browser SSH from the Lightsail console, as root (`sudo -i`). Never print the master file, as 0013 says of the relay's secrets.

### Relay status

From any machine:

```sh
curl -s https://fidant.se/relay-status; echo
```

- `[{"id":"sto","up":true}]`: the app offers `sto`.
- `[{"id":"sto","up":false}]`: the app has a relay list, but `sto`'s last two checks failed, or none has passed since the app started. Pairings get only `sto`'s `stun:` URL. 0013's Status shows the relay box's side.
- `[]`: the app has no relay list. It uses `TURN_URLS` if the app box has them.

### Turn the relay list off at once

For when the app must stop offering the relays before a pull request can merge. On the app box:

```sh
mkdir -p /etc/systemd/system/sigill.service.d
printf '[Service]\nEnvironment=RELAYS_FILE=\n' >/etc/systemd/system/sigill.service.d/relays-off.conf
grep -qx 'Environment=RELAYS_FILE=' /etc/systemd/system/sigill.service.d/relays-off.conf && systemctl daemon-reload && systemctl restart sigill
```

- The reload and restart run only once the drop-in holds the line.
- From any machine, a few seconds later, `curl -s https://fidant.se/relay-status; echo` must print exactly `[]`. That proves the relay list is off.
- Pairings then get the `turn.fidant.se` URLs only if `turn.conf` exists (0007). On the app box, `test -s /etc/systemd/system/sigill.service.d/turn.conf && echo turn` must print `turn`. In Chrome, `chrome://webrtc-internals` on a page that has paired lists the ICE server URLs: they name `turn.fidant.se` and not `sto.relay.fidant.se`. Without `turn.conf` the app hands out no ICE servers.
- Relayed transfers in progress through `sto` keep running, because coturn keeps live allocations (0013).
- The drop-in stays through deploys and reboots.
- While the list is off, `/relay-status` lists no `sto`, which the Lambda counts as down. So "Fidant relay sto unavailable" goes to ALARM within about 10 minutes, and back to OK once the list is on and `sto` is up. That alarm is expected.

To turn the relay list on again:

```sh
rm /etc/systemd/system/sigill.service.d/relays-off.conf && systemctl daemon-reload && systemctl restart sigill
```

- The master is unchanged, so `sto` still has its secret. `/relay-status` must print `[{"id":"sto","up":true}]` within about a minute.

### Roll back by a commit

- Commit `[]` to `apps/server/relays.json` in a pull request. It needs an approval from the `maintainers` team.
- The app box deploys it within a few minutes of the merge. Then `curl -s https://fidant.se/relay-status; echo` must print exactly `[]`.
- "Fidant relay sto unavailable" then goes to ALARM and stays there, as under "Turn the relay list off at once", until the list holds `sto` again and `sto` is up.

### New secrets for every relay

This replaces step 0 of 0013's "A leaked secret". On the app box:

```sh
test -s /var/lib/sigill/relay-master && rm /var/lib/sigill/relay-master && systemctl restart sigill
```

- The server makes a new master at start, and with it a new secret for every relay. The restart is the same as a deploy's.
- From any machine, watch the status:

```sh
for i in $(seq 20); do date +%T; curl -s https://fidant.se/relay-status; echo; sleep 10; done
```

- `sto` must read `"up":false` right after the restart and `"up":true` within about 150 seconds: the relay box fetches the new hand-out within about 80 seconds, and the next check follows within 60.
- Relayed transfers in progress keep running: the relay keeps the old secret as `previous`, and coturn keeps live allocations (0013).
- Then go on with 0013's "A leaked secret" on the relay box, comparing `current`'s time with this restart.

### A leaked relay key

- A relay's secret is HMAC-SHA256 of its `id` under the master, so it doesn't depend on the relay's key, and its sealed hand-out is public. Whoever holds a leaked `relay.key` can open the hand-out and read the secret. A new key under the same `id` and master gets the same secret.
- So when a relay's private key may have leaked, its secret changes with its key, in one of two ways:
  - The relay gets a new `id`, which makes it a new relay under a new name (0013, "Removing a relay"). The other relays keep their secrets.
  - Or, once the app box runs the release with the new key, run the command below. It makes new secrets for every relay, and pairings get no relay for about 150 seconds, as under "New secrets for every relay". Run before that release, it would seal the new secret to the leaked key. Put the third line of the new `relay.pub` between the quotes, so the command restarts nothing until the running release holds the new key:

```sh
grep -qF '<third line of the new relay.pub>' /opt/sigill/current/apps/server/relays.json && test -s /var/lib/sigill/relay-master && rm /var/lib/sigill/relay-master && systemctl restart sigill
```

- Then check the status as under "New secrets for every relay".
- The relay box keeps the old secret as `previous` for 24 hours, and whoever holds the leaked key has read it from the hand-out. So go on with 0013's "A leaked secret" on the relay box, as under "New secrets for every relay".
- A plain rebuild, where the old box and its key are destroyed, needs neither.

### Live cap check

Run it once after the first deploy of the cap for both boxes. It proves that the Lambda's role may call `PutInstancePublicPorts` on both boxes, without closing a port. The SSM parameter is `/fidant/relay-cap`. Its value is `{"month":"YYYY-MM","boxes":{"<box name>":<bytes>},"capped":<true or false>}`.

1. Mark the state capped, keeping `month` and `boxes`:

```sh
v=$(aws ssm get-parameter --name /fidant/relay-cap --query Parameter.Value --output text --profile fidant-poc --region eu-north-1) &&
  new=$(printf '%s' "$v" | jq -c 'select(.capped == false) | .capped = true') &&
  [ -n "$new" ] &&
  aws ssm put-parameter --name /fidant/relay-cap --type String --overwrite --value "$new" --profile fidant-poc --region eu-north-1
```

- It prints the parameter's new `Version` and `"Tier": "Standard"`.
- It prints nothing, and writes nothing, when the state already says `"capped":true`. Then the cap is active, and this check can't run.

2. A run that started before step 1 can still write over it. The Lambda's timeout is 30 seconds, and no run lasts longer ([Configure Lambda function timeout](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html)). So 35 seconds after step 1:

```sh
aws ssm get-parameter --name /fidant/relay-cap --query Parameter.Value --output text --profile fidant-poc --region eu-north-1 | jq .capped
```

- It must print `true`. `false` means a run wrote over step 1: run step 1 again.

3. Six minutes after step 1, when the next run has ended, run step 2's command again.

- It must print `false`. A run writes the state only after it has put the open ports on every box, so `false` means both calls succeeded, and the total was under the limit.
- `true` means a call failed. Read the Lambda's log, in the log group named like `FidantApp-RelayCapLogs<hash>`:

```sh
aws logs describe-log-groups --log-group-name-prefix FidantApp-RelayCapLogs --query 'logGroups[].logGroupName' --output text --profile fidant-poc --region eu-north-1
aws logs tail <name> --since 15m --profile fidant-poc --region eu-north-1
```

4. 15 minutes after step 1:

```sh
aws cloudwatch describe-alarms --alarm-names "Fidant relay cap failing" --query 'MetricAlarms[].StateValue' --output text --profile fidant-poc --region eu-north-1
```

- It must print `OK`. The alarm needs 3 failed runs in a row (0011), so before 15 minutes `OK` proves nothing.
