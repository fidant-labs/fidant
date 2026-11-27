# 0007: TURN relay on the app box

- Status: Accepted
- Date: 2026-11-24
- Linear: FID-77

## Context

- Before FID-77 the hosted site handed out no STUN or TURN servers. Browsers connected only over local addresses, so sender and recipient had to be on the same network.
- FID-58 put the relay on the Lightsail Micro that runs the app, the most exposed machine.
- 0006 mints TURN credentials per pairing, valid for 5 minutes, from `TURN_URLS` and the secret in `TURN_SECRET_FILE`. The server checks `TURN_URLS` at startup: 1 to 4 `turn:`, `turns:` or `stun:` URLs.
- `apps/infra/box/user-data.sh` sets the box up once, at first boot. Lightsail never re-runs user data, so the instance name carries a hash of it and any change replaces the box.
- DNS (FidantDns) and the box (FidantApp) deploy to different AWS accounts. Both take the box's static address from `boxAddress` in `apps/infra/src/config.ts`.
- A relayed file stays encrypted end to end. The relay sees both browsers' IP addresses and the encrypted traffic.

## Options considered

| Option                                                        | For                                                  | Against                                                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A second box for the relay                                    | The relay's load and exposure stay off the app box.  | A second box to pay for. It needs the TURN secret, and Lightsail has no instance role to fetch one.                                                              |
| coturn on the app box, from Ubuntu 24.04's package            | No new machine. Installs with apt, nothing to build. | Relay traffic and the app share one Micro. Ubuntu's coturn (4.6.1) lags upstream.                                                                                |
| An AAAA record for `turn.fidant.se`                           | Browsers on IPv6 reach the relay by name.            | The IPv6 address changes with every box, and DNS deploys from another account, so each new box needs a DNS change.                                               |
| A `stun:` URL with the box's IPv6 address, read at first boot | Always the current address. No DNS change.           | Takes one of the 4 URL slots. The relay itself is reached over IPv4 only.                                                                                        |
| `external-ip` from instance metadata at first boot            | Nothing to keep in step.                             | Can race the static IP attach and record the box's temporary address.                                                                                            |
| `external-ip` public half from `boxAddress`                   | Always the static address.                           | A new static IP needs `config.ts` updated, which replaces the box.                                                                                               |
| A per-user quota (`user-quota`)                               | Caps one user.                                       | The username is the credential's expiry second, shared by every pairing minted in that second. Unrelated pairings would share one cap.                           |
| A total quota (`total-quota`)                                 | Caps the box's allocations.                          | One client can take all of them.                                                                                                                                 |
| Deny the box's own public address as a peer                   | Nothing reaches the box back through the relay.      | Does nothing: coturn maps a peer given as the box's public address to its private address, which it whitelists. Relay-to-relay transfers depend on that mapping. |
| A relay log by default                                        | Faults and abuse are easier to trace.                | Keeps the IP addresses of every relayed pairing.                                                                                                                 |
| TURN over TLS on 443 now (`turns:`)                           | Works on networks that allow only 443.               | Needs an SNI proxy in front of Caddy, which hides client addresses from 0006's per-address caps unless it speaks PROXY protocol, or a second box (see above).    |
| The budget alert inside FidantApp                             | Deploys and changes with the box.                    | CloudFormation has no `AWS::Budgets::Budget` type in eu-north-1.                                                                                                 |

## Decision

### Where it runs

- coturn from Ubuntu 24.04's package (4.6.1) runs on the app box, next to the app.
- `turn.fidant.se` is an A record to `boxAddress`, in the fidant.se zone only. The relay can move to its own box later by changing that record.
- The firewall opens TCP and UDP 3478 and UDP 49152–65535, over IPv4 and IPv6.
- No TLS or DTLS listener (`no-tls`, `no-dtls`), no TCP relay (`no-tcp-relay`), no CLI.

### Config and secret

- Static settings live in `apps/infra/box/turnserver.conf`. CDK puts the file into the user data at synth time, with the domain filled in.
- `user-data.sh` writes `/etc/turnserver.conf` (0640 root:turnserver) from it and adds what only the box knows: `external-ip=<boxAddress>/<private IPv4>` and `static-auth-secret`.
- `use-auth-secret` checks the credentials the app mints (0006).
- The secret is generated on the box at first boot into `/etc/fidant/turn-secret` (0600 root). It never passes through a shell variable or a command argument, so `set -x` can't trace it into the cloud-init log. It is never in CloudFormation or the user data.
- The drop-in `/etc/systemd/system/fidant.service.d/turn.conf` gives the app `TURN_URLS`, and the secret through `LoadCredential=` and `TURN_SECRET_FILE`.
- coturn never runs with the package's default config. It is masked while the package installs, then unmasked and started with ours.
- coturn starts after `network-online.target` (drop-in `coturn.service.d/online.conf`). It binds the addresses it finds when it starts, so after a reboot it could otherwise bind loopback only.
- The app's drop-in is written only if coturn is active. If anything in the coturn part fails at first boot, the app runs without STUN or TURN, as before FID-77.

### URLs

- `TURN_URLS` is `stun:turn.fidant.se:3478`, `turn:turn.fidant.se:3478?transport=udp` and `turn:turn.fidant.se:3478?transport=tcp`, plus `stun:[<IPv6>]:3478` when the box has a global IPv6 address at first boot.
- That makes 4, the most `parseIceServers` accepts. A later `turns:` URL replaces the first `stun:` URL. A TURN server also tells the browser its public address, so STUN by name adds nothing then.

### Peers

- `denied-peer-ip` blocks private, loopback, link-local, CGNAT and other special-use ranges, IPv4 and IPv6, as listed in `turnserver.conf`. The relay can't be used to reach other machines on the box's network or the instance metadata. For the box itself, see Consequences.
- The box's own public address is not denied. coturn 4.6.1 maps a peer given as the box's public address to its private address before checking it, and whitelists the private half of `external-ip`, so a `denied-peer-ip` entry for the public address would do nothing. Relay-to-relay transfers, where each browser's peer is the other's relayed address on the box, work through that mapping. The private-range denies don't block them.

### Logs

- No relay log by default: `no-stdout-log`, `simple-log`, `log-file=/dev/null`.
- A log is turned on only to fix a fault or stop abuse, for at most 7 days, under `/run/coturn`, which lives in memory. Then it is turned off and deleted. The steps are in the runbook.
- coturn 4.6.1 logs sessions only with `verbose`. Each session then logs the client's and the peer's IP addresses and ports, the credential's expiry time, and packet and byte counts.

### Abuse and cost

- `total-quota=200` allocations. Each browser allocates once per `turn:` URL on each network interface, even when the direct path wins, so a pairing takes up to about 8. 200 is about 25 pairings at once.
- No `user-quota`. See the table.
- Quotas don't cap the bill. The decided backstop is an AWS Budgets alert, "Fidant POC monthly cost": 10 USD a month, alerting when actual or forecast cost passes 100 %, by email to budget-alert@fidant.se. CloudFormation can't create it in eu-north-1, so it is not part of FidantApp. FID-90 creates it outside the stack.
- A bandwidth cap waits until transfers through the relay have been measured.

### Deferred

- TURN over TLS on 443 comes before the first pilot with office users. The mechanism is open (see the table).

## Consequences

- On the hosted site, browsers on different networks can connect, through a STUN-found address or the relay.
- Relayed transfers outlive the 5-minute credentials. coturn 4.6.1 checks expiry only on a session's first authenticated request, which matches what 0006 measured.
- Accepted: relay clients can reach UDP services that listen on the box's private address, or on all addresses. coturn whitelists the private half of `external-ip` (it logs `Whitelisting external-ip private part`), despite the 172.16.0.0/12 deny. They can also reach UDP services on the box's global IPv6 address or on all addresses, over an IPv6 relay, when the box has one: the kernel delivers that locally, past the Lightsail firewall. `no-tcp-relay` keeps TCP services out.
- coturn also listens on 3479 (the RFC 5780 alternate port) and on loopback. The firewall keeps 3479 closed.
- A few coturn error paths still write plain messages to stderr, which reach the journal (seen: `udp send: Invalid argument`). `journalctl -u coturn` must hold no client IP addresses.
- If coturn can't read `/etc/turnserver.conf`, it only warns and runs on built-in defaults. Edits must keep the file 0640 root:turnserver.
- A coturn failure after first boot doesn't change the app: it keeps handing out the URLs. Every URL points at coturn, so browsers then get no STUN or TURN answers. Pairs that connect over local addresses still work. Pairs that needed a STUN-found address or the relay fail.
- A new static IP needs `boxAddress` in `config.ts` updated. That changes the user data, so the deploy replaces the box.
- App deploys (`fidant-deploy`) restart only the app, not coturn. Box changes, including any change to `turnserver.conf`, replace the box: about 5–10 minutes down, and new certificates. Let's Encrypt issues about 5 identical certificates a week, which limits how often the box can be replaced.
- The budget alert only sends an email. When it fires, someone runs the emergency stop. Until FID-90 creates it, there is no cost alert.

## Runbook

Use browser SSH from the Lightsail console, and become root first with `sudo -i`.

### Status

```sh
systemctl status coturn fidant
ss -lunpt | grep 3478
journalctl -u coturn
cat /etc/systemd/system/fidant.service.d/turn.conf
```

- coturn listens on UDP and TCP 3478.
- `journalctl -u coturn` holds no client IP addresses.
- No `turn.conf` means coturn wasn't active at first boot, and the app hands out no STUN or TURN.

### Emergency stop

```sh
systemctl stop coturn
systemctl disable coturn
```

- `disable` keeps it off across reboots. `systemctl enable --now coturn` starts it again.
- The app still hands out the TURN URLs. Browsers try the relay, fail to reach it, and connect directly. Where only STUN or the relay would have worked, the connection fails.

### Temporary log

Only to fix a fault or stop abuse, for at most 7 days. Turning it on or off restarts coturn, which drops relayed transfers in progress.

On, then note the date:

```sh
install -d -o turnserver -g turnserver -m 700 /run/coturn
sed -i 's|^log-file=.*|log-file=/run/coturn/turn.log|' /etc/turnserver.conf
echo verbose >>/etc/turnserver.conf
systemctl restart coturn
```

- Keep `no-stdout-log` and `simple-log`.
- Read it with `tail -f /run/coturn/turn.log`.

Off, within 7 days:

```sh
sed -i -e 's|^log-file=.*|log-file=/dev/null|' -e '/^verbose$/d' /etc/turnserver.conf
systemctl restart coturn
rm -rf /run/coturn
```

- `/run` is in memory, so a reboot also deletes the log. The setting survives it, though: coturn then can't open the file and logs to `/var/tmp/turn.log` in its private temporary directory, on disk. Run the off steps anyway. The restart clears that directory.
- After any edit, `stat -c '%a %U:%G' /etc/turnserver.conf` must print `640 root:turnserver`.

### Secret

- It lives in `/etc/fidant/turn-secret` (0600 root). The app reads it through `LoadCredential=` in `/etc/systemd/system/fidant.service.d/turn.conf`. coturn has a copy in `static-auth-secret` in `/etc/turnserver.conf` (0640 root:turnserver).
- Rotate it without printing it:

```sh
openssl rand -hex 32 >/etc/fidant/turn-secret
sed -i '/^static-auth-secret=/d' /etc/turnserver.conf
{ printf 'static-auth-secret='; cat /etc/fidant/turn-secret; } >>/etc/turnserver.conf
systemctl restart coturn fidant
```

- Credentials already handed out stop working, and relayed transfers in progress drop.

### Path shares

How often connections went direct, through a STUN-found address, through the relay, or failed:

```sh
journalctl -u fidant -o cat | grep -o '"event":"path","path":"[a-z]*"' | sort | uniq -c
```
