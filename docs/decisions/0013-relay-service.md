# 0013: The relay as its own service, starting with a Stockholm relay box

- Status: Accepted
- Date: 2026-11-25
- Linear: SIG-152 (parent SIG-151)

## Context

- 0007 put coturn on the app box. 0010 added TURN over TLS on 443 through HAProxy on the same box, and named moving coturn to its own box, listening on 443 directly, as the way out. It left the secret hand-out to a second box open.
- The app box is a Lightsail `micro_3_0`. Its 2 TB monthly allowance counts inbound and outbound traffic, and outbound traffic beyond it costs 0.09 USD/GB (0011). A relayed byte counts twice, once in and once out. One box in one place carries every relayed transfer.
- SIG-151 makes the relay its own service: one install script that turns any Ubuntu server into a relay, relays in more than one place, each with its own secret and cap. This record covers SIG-152, the script and a first relay box in Stockholm. SIG-153 switches the app over to it. SIG-154 takes coturn, HAProxy and the relay ports off the app box.
- A relay needs the secret that the app mints TURN credentials with (0006). Lightsail has no instance role, so a box can't fetch a secret from AWS by itself (0007).
- SIG-151 chose a key pair for the hand-out over a secret pasted by hand after each app box replacement, and over handing the secret to requests from the relay's IP address. The relay makes a key pair at install, its public key is committed in a reviewed pull request, and the app hands out the secret sealed to that key. Holding a retired relay's IP address is then not enough to get its secret, and every change to which relays are trusted goes through review. SIG-153 keeps the trusted keys in `apps/server/relays.json`, which a maintainer adds to the `sensitive-paths` ruleset, so a key change needs a maintainer's approval. The cost: a rebuilt relay has a new key and stays without a secret until a pull request with that key merges.
- Lightsail runs user data once, through `/bin/sh`. The instance name carries a hash of the user data, so any change to it replaces the box (0007).
- `.github/workflows/deploy-infra.yml` checks out only `apps/infra/` and a few root files.
- A Lightsail static IP names its instance in `attachedTo`, so the instance's user data can't contain that IP.
- Ubuntu 24.04 ships coturn 4.6.1 (`4.6.1-1build4`). We measured how it reads secrets from its database in a container before writing this record (see "How secrets reach coturn").

## Options considered

### Where the script lives

| Option                       | For                                                                                                                          | Against                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/relay/`                | Reads as a service of its own, as SIG-151 first planned.                                                                     | The infra deploy checks out only `apps/infra/`, so CDK in CI couldn't read the script. |
| `apps/infra/relay/` (chosen) | Next to `apps/infra/box/user-data.sh`. A change deploys through the same workflow and needs the same `maintainers` approval. | A script meant for any server lives in the AWS app, though it needs nothing from AWS.  |

### How coturn learns its public address (`external-ip`)

| Option                                                                  | For                                                                                                                                     | Against                                                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| An input to the script, the static IP                                   | The simplest.                                                                                                                           | On Lightsail the static IP attaches to the instance, so the instance's user data can't hold it.                               |
| A custom resource that attaches the static IP and passes the address on | Keeps the input.                                                                                                                        | A Lambda-backed resource to build and keep for one value, and specific to AWS.                                                |
| The box resolves the relay's own DNS name (chosen)                      | Works on any provider. Where the provider puts the public address on the interface, the name resolves to the box and no line is needed. | Right only once the DNS record exists (SIG-157). A spoofed answer points relay candidates at another host (see Consequences). |

### How secrets reach coturn

| Option                                                                                                 | For                                                                                                                          | Against                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: rows in coturn's SQLite user database (`userdb`), changed with `sqlite3` while coturn runs (chosen) | A new secret works, and a deleted one stops working, on the next allocation, with no restart. Live allocations survive both. | A write briefly blocks new allocations. A writer that dies mid-write blocks them until root opens the database. The file must exist before coturn starts. |
| B: `static-auth-secret` lines in `/etc/turnserver.conf`, and a restart on each change                  | A plain config file, as on the app box.                                                                                      | Each rotation restarts coturn, which drops every relayed transfer in progress.                                                                            |

### How long the previous secret stays valid

| Option                           | For                                                                                      | Against                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1 hour, as SIG-151 first planned | An old secret stops being accepted sooner.                                               | None found.                                                 |
| 24 hours (chosen)                | Margin for anything that allocates on credentials minted before a change. Costs nothing. | An old secret is accepted for new allocations a day longer. |

24 hours was chosen to keep a relayed transfer that started before an app box replacement refreshing against the old secret. The measurements below then showed that coturn checks a live allocation against a key it cached at the first request, so deleting the secret doesn't end the allocation at all. The window now only covers new allocations on credentials minted before the change, and those credentials can't start an allocation more than 5 minutes after they were minted (0006). Either length covers that, and the longer one costs nothing.

## Decision

The relay is `apps/infra/relay/install.sh`, a POSIX `sh` script that depends on nothing AWS-specific. Its first box is the Stockholm relay box in `FidantApp`, built from it. Secrets reach coturn through its SQLite database (mechanism A).

### What the script installs

- It runs as root with three inputs in the environment. A bad input stops it with `fidant-relay: <name> must match ^<pattern>$`:
  - `RELAY_ID`: `^[a-z][a-z0-9]{1,15}$`, for example `sto`.
  - `RELAY_NAME`: a lowercase host name, the relay's DNS name and coturn's realm, for example `sto.relay.fidant.se`.
  - `APP_URL`: `^https://[a-z0-9.-]+$`, the app it fetches its secret from.
- It runs with `set -eux`, because it handles no secret. Running it again keeps the key pair, the secrets, the database, the certificate and the `external-ip` line, and rewrites everything else.
- It writes the same journald drop-in as the app box, then installs `coturn`, `certbot`, `sqlite3`, `ufw`, `curl` and `logrotate` from Ubuntu if any is missing. While it installs them, coturn stays masked until its config is written, so it never runs with the package's default config, which has no authentication.
- Files:

| Path                                                          | Owner and mode        | Holds                                                                                                 |
| ------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| `/etc/fidant-relay/`                                          | root, 0755            |                                                                                                       |
| `/etc/fidant-relay/relay.key`                                 | root, 0600            | The relay's RSA 3072 private key, PKCS#8 PEM. Made once, and never leaves the box.                    |
| `/etc/fidant-relay/relay.pub`                                 | root, 0644            | Its public key, SPKI PEM, written from `relay.key` on every run.                                      |
| `/etc/fidant-relay/relay.env`                                 | root, 0644            | The three inputs.                                                                                     |
| `/etc/fidant-relay/tls/`                                      | root:turnserver, 0750 | `turn.crt` (0644) and `turn.key` (0640 root:turnserver), coturn's certificate and key.                |
| `/var/lib/fidant-relay/`                                      | root:turnserver, 0750 |                                                                                                       |
| `/var/lib/fidant-relay/turndb`                                | root:turnserver, 0640 | coturn's SQLite database, from `/usr/share/coturn/schema.sql`. Made once, before coturn first starts. |
| `/var/lib/fidant-relay/current`, `previous`, `previous-since` | root, 0600            | The current secret, the previous one, and when it became the previous one (Unix seconds).             |
| `/etc/turnserver.conf`                                        | root:turnserver, 0640 | coturn's config, below.                                                                               |
| `/usr/local/bin/fidant-relay-*`                               | root, 0700            | The five scripts below.                                                                               |

- `/etc/turnserver.conf` holds `listening-port=3478`, `tls-listening-port=443`, `min-port=49152`, `max-port=65535`, `realm=<RELAY_NAME>`, `use-auth-secret`, `userdb=/var/lib/fidant-relay/turndb`, the certificate and key paths, and `relay-ip=<the box's private IPv4 address>`. It copies 0007's hardening exactly: `total-quota=200`, `no-dtls`, `no-cli`, `no-multicast-peers`, `no-tcp-relay`, `no-stdout-log`, `simple-log`, `log-file=/dev/null` and the 13 `denied-peer-ip` lines of `apps/infra/box/turnserver.conf`. A test in `apps/infra/src/stacks.test.ts` checks that each of these lines appears verbatim, the denials in the same order. There is no `static-auth-secret`.
- Two coturn drop-ins: `online.conf` starts it after `network-online.target`, as on the app box. `bind443.conf` gives it `CAP_NET_BIND_SERVICE`, because Ubuntu's unit runs coturn as `turnserver` with no capabilities, and it couldn't bind 443 otherwise.
- Timers:

| Timer                        | First run        | Then                      | Runs                                               |
| ---------------------------- | ---------------- | ------------------------- | -------------------------------------------------- |
| `fidant-relay-secret.timer`  | 10 s after start | 60 s after each run ends  | `fidant-relay-secret`: fetch the secret            |
| `fidant-relay-cert.timer`    | 30 s after start | 15 minutes after each run | `fidant-relay-cert`: get the first certificate     |
| `fidant-relay-address.timer` | 5 s after start  | 5 minutes after each run  | `fidant-relay-address`: keep `external-ip` in step |
| `certbot.timer` (Ubuntu's)   | twice a day      | twice a day               | `certbot renew`                                    |

- At the end it enables the timers, prints the public key between the lines `fidant-relay: public key for <RELAY_ID>` and `fidant-relay: end of public key`, and only then restarts coturn, so a coturn that won't start still leaves the timers running and the key printed. On Lightsail that output is in `/var/log/cloud-init-output.log`.

### How secrets reach coturn

Measured on Ubuntu 24.04's coturn `4.6.1-1build4`, with coturn running as `turnserver` and root writing the database:

- A new secret is honoured, and a deleted one refused, on the next allocation, about 5 ms after `sqlite3` returns, with no restart. coturn reads the realm's secrets for every new allocation.
- Live allocations survive both. A session made with one secret kept refreshing for 2.5 minutes after a second secret was added and for 2.5 minutes after its own was deleted, past several allocation lifetimes. coturn caches a session's key at its first request. So deleting a secret refuses new allocations and doesn't end live ones.
- An empty table is safe: coturn runs, answers STUN and refuses every allocation with 401.
- Rows match by realm, exactly. A row under another realm, or under the schema's default empty realm, never matches.
- Each write briefly blocks new allocations. coturn sets no busy timeout, so while root holds the write lock it refuses allocations with 401 and logs `database is locked`. Live allocations are unaffected.
- A writer killed mid-transaction leaves a hot journal, and coturn then refuses every new allocation until root opens the database, which rolls the journal back. coturn opens the file read-only, so it can't roll it back itself.
- coturn keeps the file open for its lifetime and never sees a file renamed over it. If the database is missing when coturn starts, coturn ignores it until a restart, even once it exists.

So the install makes the database only if it is missing, before coturn first starts, and nothing ever replaces or renames it. `fidant-relay-apply-secret` edits it in place:

- Every run first opens it once as root, with a read, so a hot journal is rolled back.
- It writes only when the realm's rows differ from the secrets it wants, in one short transaction fed to `sqlite3` on stdin. The transaction deletes the realm's rows and inserts `current`, and `previous` if it is still there.

Mechanism B was rejected because each rotation would restart coturn and drop every relayed transfer.

### The hand-out

The contract between the app (SIG-153) and the relay:

- `GET <APP_URL>/relay-secret/<RELAY_ID>` returns 200 `text/plain`.
- The body is the base64 (RFC 4648, padded) of an RSA-OAEP ciphertext, with SHA-256 for OAEP and MGF1 and an empty label, sealed to the relay's `relay.pub`.
- The plaintext is the secret as 64 lowercase hex characters in ASCII, and nothing else.
- One trailing newline after the base64 is allowed. The plaintext has none.
- Any other response means no change.
- `sealRelaySecret` in `apps/server/src/relay-secret.ts` produces the body, without the newline. Nothing serves the endpoint until SIG-153.

On the relay:

- `fidant-relay-secret` fetches the body with `curl` over HTTPS only, with a 10-second limit. It runs 10 s after boot and then 60 s after each run ends, to within a second (`AccuracySec=1s`; systemd's default of a minute would stretch the wait to up to two), so a new hand-out takes effect within about 80 s. Until SIG-153, `https://fidant.se` answers unknown paths with `200 text/html`, the app's page. So the script passes a body on only if it is one line of base64 (`[A-Za-z0-9+/]+={0,2}`) of at most 2048 bytes, the trailing newline included. Anything else, a failed request included, exits 0 with no change and no output. It doesn't check the content type.
- `fidant-relay-apply-secret` reads the body on stdin, decodes it and opens it with `relay.key` (`openssl pkeyutl`, OAEP with SHA-256 for OAEP and MGF1). When the secret is new, `previous-since` gets the time, then the current one moves to `previous`, and the new one becomes `current`. Only the current secret and one previous are kept, so a second change within 24 hours ends the older one at once. Once `previous-since` is more than 24 hours old, `previous` and `previous-since` are deleted. A `previous-since` that is missing, empty or not a number, as a crash can leave it, gets the current time, so `previous` stays a full 24 hours from then. That check runs only after a hand-out opens, so while no hand-out arrives, the previous secret stays. Then it updates the database as above.
- It exits 0 when the secret was applied or unchanged. Otherwise it exits 1 with one of these on stderr, and keeps its secrets:
  - `fidant-relay: cannot open the secret`: not base64, or sealed to another key.
  - `fidant-relay: not a secret`: it opened, but the plaintext isn't exactly 64 lowercase hex characters.
  - `fidant-relay: cannot write the secrets`: the transaction failed, for example because the database stayed locked for 2 seconds.
- A body of the right shape that apply refuses makes `fidant-relay-secret` exit 1 too, so `fidant-relay-secret.service` shows as failed. That is a real error, for example a hand-out sealed to an old key.
- No secret reaches a command line, a log line or a trace. Both scripts run with `set -eu` and no `-x`, and the SQL reaches `sqlite3` on stdin, built with the shell's `printf` builtin.

### Certificates

- coturn's TLS on 443 uses its own Let's Encrypt certificate for `RELAY_NAME`.
- The first one comes from `fidant-relay-cert`, which runs `certbot certonly --standalone` with the HTTP challenge unless `/etc/letsencrypt/live/<RELAY_NAME>/` exists. certbot holds port 80 only while it runs. Its timer runs every 15 minutes, but the script asks Let's Encrypt only once `RELAY_NAME` resolves (`getent ahostsv4`, as `fidant-relay-address` does), because every validation of an unresolvable name fails and Let's Encrypt pauses a name after 1,152 consecutive failures (refilling at 1 a day) until someone unpauses it by hand. Until the DNS name exists (SIG-157) the script exits 0 without running certbot. Four tries an hour stays within the limit of 5 failed validations per host name per hour. The account has no email address.
- If that lineage exists but `/etc/fidant-relay/tls/turn.crt` doesn't, certbot got the certificate but its deploy hook never put it in place, for example because the box rebooted while the hook ran, or the hook failed. `fidant-relay-cert` then runs the deploy hook on the lineage and exits with its status, so coturn doesn't wait for the renewal, about 60 days later, to get the certificate.
- Renewal goes through Ubuntu's `certbot.timer`, which runs `certbot renew` with the challenge and the deploy hook that certbot stored in the renewal config.
- The deploy hook `fidant-relay-cert-installed` copies the new `fullchain.pem` and `privkey.pem` to new files and checks that the certificate's public key matches the key, because 0010 found that a renewal between two reads can pair them wrongly. On a mismatch it stops with `fidant-relay: the certificate and key in <lineage> don't match` and changes nothing. Otherwise it moves both into place one right after the other.
- Then, if coturn is active, the hook sends it `SIGUSR2` when `/etc/fidant-relay/tls/turn.crt` existed before the hook ran, which reloads the certificate without dropping relayed transfers. Otherwise it restarts coturn, because a coturn that started without a certificate opens TLS only on a restart (0010).
- coturn 4.6.1 serves TLS 1.2 only, as 0010 records.

### `external-ip`

- `fidant-relay-address` resolves `RELAY_NAME` every 5 minutes (`getent ahostsv4`, first address).
- A failed lookup changes nothing, so a DNS fault can't restart a live relay.
- When the name resolves to an address on the box itself, there is no `external-ip` line.
- Otherwise the line is `external-ip=<resolved address>/<relay-ip>`, which maps the private address coturn relays from to the public one, as Lightsail's NAT needs.
- It rewrites the config and restarts coturn only when the line changes.

### Firewall

- ufw denies incoming and allows outgoing, and opens TCP 22, 80, 443 and 3478, UDP 3478 and UDP 49152–65535, to everyone.
- `ufw logging off`, because each blocked packet would put its source address in the journal.
- On Lightsail, the instance firewall opens the same ports and limits 22 to browser SSH (`lightsail-connect`). Elsewhere, ufw alone leaves 22 open to everyone.

### Logs

- coturn logs to `/dev/null`, as in 0007.
- The journal is kept 29 days, with the app box's drop-in (`MaxRetentionSec=29day`, `MaxFileSec=1day`, `ForwardToSyslog=no`).
- certbot's own log, in `/var/log/letsencrypt/`, records the address of whatever reaches port 80 while certbot holds it to get or renew a certificate: a few seconds on each attempt, every 15 minutes until the first certificate, then roughly every 60 days. That means Let's Encrypt's validators and scanners. Browsers never use port 80 on the relay.
- Ubuntu's certbot appends to one log (`max-log-backups = 0` in `/etc/letsencrypt/cli.ini`), and logrotate rotates it weekly. A tmpfiles rule (`e /var/log/letsencrypt - - - m:29d`) removes any file there 29 days after its last write. It goes by modification time, because rotating a log renames it, which renews its change time. So such an address is kept for at most about five weeks.
- That rests on logrotate, which the script installs. Without it, `certbot.timer` writes to the one log twice a day, and the rule never removes it.
- So the relay box keeps no log of relayed transfers, but it does keep certbot's log.

### The Stockholm relay box

- `RelayBox` in `apps/infra/src/relay.ts`, one per entry of `relays` in `apps/infra/src/config.ts`, in `FidantApp`. Today the list holds `sto`.
- A Lightsail `micro_3_0` on `ubuntu_24_04` in eu-north-1a, named `fidant-relay-sto-<the first 8 hex characters of the SHA-256 of its user data>`.
- Its user data (`renderRelayUserData` in `apps/infra/src/user-data.ts`) is `#!/bin/sh`, then `RELAY_ID=sto`, `RELAY_NAME=sto.relay.fidant.se` and `APP_URL=https://fidant.se`, exported, then `install.sh` without its first line.
- Its own static IP, `fidant-relay-sto-ip`, kept when the stack deletes it. The output `RelayStoIp` gives its address, which SIG-157 copies into the DNS config by hand, as with `boxAddress`.
- Lightsail ports: TCP 22 from `lightsail-connect` only; TCP 80, 443 and 3478, UDP 3478 and UDP 49152–65535 from everyone, over IPv4 and IPv6.
- The app box doesn't change, and 0011's cap still watches only the app box.

## Consequences

- Any change to `apps/infra/relay/install.sh` replaces every Lightsail relay built from it, and so does a change to its inputs. The new box has a new key, so from SIG-153 on it stays without a secret until a reviewed pull request commits the new key.
- Until SIG-153 nothing serves the hand-out. The relay fetches the app's page every minute and drops it, holds only its key pair and an empty secret table, answers STUN and refuses every TURN allocation. Users still go through the app box's relay at `turn.fidant.se`.
- Until the relay's DNS name exists (SIG-157), it has no certificate, so no TLS listener, and no `external-ip` line. These are checked on the box then, before SIG-153 commits the key, so a fix costs a rebuild rather than a second key pull request:
  - certificate issuance;
  - `external-ip` behind Lightsail's NAT;
  - `systemctl status fidant-relay-secret.service` shows a clean run against fidant.se's page, which exercises curl, WebPKI trust and the shape filter;
  - the `relay-ip=` value in `/etc/turnserver.conf` equals the private address that `ip -4 -o addr show scope global` shows.
- Four things restart coturn and drop the relayed transfers in progress: a change in the address the relay's name resolves to, the first certificate, running the install again, and package updates (unattended-upgrades and needrestart).
- A spoofed DNS answer for the relay's own name sets `external-ip`, so relay candidates name the attacker's host. Peers then send ICE checks there, which shows the attacker their public addresses, ICE ufrags and when transfers happen. File content, names, metadata and keys stay protected by DTLS and the link's fragment, and ICE transport data isn't secret (0001). An answer that keeps changing also restarts coturn every 5 minutes, which drops relayed transfers.
- There is no HAProxy in front of coturn, so it sees real client addresses on TLS too, unlike the app box's relay (0010).
- coturn also opens TLS on 444 and listens on 3479. Both firewalls keep them closed. It accepts TLS on 3478 too, which is open, as on the app box.
- The previous secret stays valid for 24 hours after a change while hand-outs keep arriving, and longer while they don't. Only the current secret and one previous are kept, so a second change within 24 hours ends the older one at once. The app therefore keeps one secret per relay that survives app restarts and changes only when the app box is replaced (SIG-153).
- certbot's log keeps the addresses that reach port 80 during a challenge for up to about five weeks. Once the name resolves and until the first certificate, certbot holds port 80 for a few seconds every 15 minutes.
- Lightsail pools the transfer allowance across the region's `micro_3_0` boxes, and 0011's cap counts only the app box's traffic. The relay box carries no relayed transfers until SIG-153, which moves the cap to it.
- `pnpm e2e:networks` runs the script at boot in an Ubuntu container (`apps/e2e/networks/relay`), with the run's certificate in place of Let's Encrypt's, and relays over UDP, TCP and TLS on 443 through it. It can't run certbot or Lightsail's NAT. It runs the deploy hook on the run's certificate instead, both the reload and the first certificate's restart.

## Runbook

Use browser SSH from the Lightsail console, as root (`sudo -i`).

### Never print the secrets

Never print `/var/lib/fidant-relay/current`, `previous` or the database (`turndb`), or the keys `/etc/fidant-relay/relay.key` and `/etc/fidant-relay/tls/turn.key`. Check them only for whether they exist:

```sh
test -s /var/lib/fidant-relay/current && echo current
test -s /var/lib/fidant-relay/previous && echo previous
sqlite3 /var/lib/fidant-relay/turndb 'SELECT count(*) FROM turn_secret'
```

The last line prints only how many secrets coturn has: 0 before SIG-153, then 1 or 2.

### Public key

```sh
cat /etc/fidant-relay/relay.pub
```

### Status

```sh
systemctl status coturn fidant-relay-secret.timer fidant-relay-cert.timer fidant-relay-address.timer
ufw status
```

- coturn is active, and ufw lists the six rules above.
- `fidant-relay-cert.service` shows `success` without certbot having run until the relay's DNS name exists. Once it resolves, a `failed` state means Let's Encrypt refused; read `/var/log/letsencrypt/`. Once `/etc/letsencrypt/live/<RELAY_NAME>/` exists, it no longer runs certbot, only the deploy hook, and only while `/etc/fidant-relay/tls/turn.crt` is missing. A `failed` state then means the hook failed; `journalctl -u fidant-relay-cert` says why.
- `grep '^external-ip=' /etc/turnserver.conf` shows the static IP once the DNS name exists.
- `openssl x509 -noout -enddate -in /etc/fidant-relay/tls/turn.crt` shows a date well ahead once there is a certificate.
- `journalctl -u coturn` holds no client IP addresses.
- `systemctl is-enabled logrotate.timer` says `enabled`. Without logrotate, certbot's log is never removed (see Logs).

### Emergency stop

```sh
systemctl stop coturn && systemctl disable coturn
```

- `disable` keeps it off across reboots. `systemctl enable --now coturn` starts it again.

### A leaked secret

Once the app hands out a new secret, the leaked one is `previous` and stays valid for 24 hours. To end it at once:

```sh
rm -f /var/lib/fidant-relay/previous /var/lib/fidant-relay/previous-since
systemctl start fidant-relay-secret.service
sqlite3 /var/lib/fidant-relay/turndb 'SELECT count(*) FROM turn_secret'
systemctl restart coturn
```

- The second line rewrites the database without the old secret once a hand-out opens. The third must then print 1.
- The restart ends the allocations made with it, and drops every relayed transfer in progress.
- Never print the secret files (see above).

### Removing or moving a relay

- Removing `sto` from `relays` in `apps/infra/src/config.ts` deletes the instance but keeps its static IP `fidant-relay-sto-ip`. Release it by hand (`aws lightsail release-static-ip --static-ip-name fidant-relay-sto-ip --profile fidant-poc --region eu-north-1`), or adding `sto` back fails on the name.

### Run the install again

From a copy of `apps/infra/relay/install.sh` on the box:

```sh
set -a; . /etc/fidant-relay/relay.env; set +a; sh install.sh
```

- It keeps the key pair, the secrets, the database, the certificate and the `external-ip` line.
- It restarts coturn, which drops relayed transfers in progress.
