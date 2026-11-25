# Infra

Facts for the scripts that run on a box and for what CDK deploys. The deploy steps and the box test conventions are in the root `AGENTS.md`, runbooks are there and in the decision records, and what a runbook check or command must do is in `docs/decisions/README.md`.

## Box scripts

- A box runs its user data once, at first boot, and the scripts that user data writes stay as written. Its instance name carries a hash of the user data: a change to `box/` replaces the app box, a change to `relay/install.sh` replaces every relay box, and so do the other inputs the root `AGENTS.md` and record 0013 list. A fix found after merge costs a box replacement, and a new relay box has a new key pair.
- Lightsail runs user data through `/bin/sh`, which is dash on Ubuntu. The scripts it writes name their shell on the `#!` line.
- `set -e` stops a script at the first failing command, and `grep` fails with exit 1 when nothing matches. A failing command doesn't stop it in an `if`, `while` or `until` condition, before `&&` or `||`, after `!`, or as any but the last command of a pipeline. dash has no `set -o pipefail`; bash has it, and `sigill-deploy` uses it.
- dash's `$(( ))` reads a leading zero as octal (`010` is 8, `08` is an error) and clamps a literal past 9223372036854775807 to that number, while a computed result past it wraps to a negative number (`$((9223372036854775807+1))` is -9223372036854775808). `[ "$n" -gt 1 ]` reads base 10, but fails with exit 2 on an empty value, a non-number or a number past that limit, and in an `if` condition the failure takes the `else` branch. A value that matches `0` or `[1-9][0-9]*` with at most 18 digits is safe in both.
- A daemon reads its config when it starts or reloads, which a crash restart or another script can cause at any moment. A file truncated and rewritten in place can be read half written. coturn with no authentication option in its config allows anonymous relaying, so a `turnserver.conf` cut off before `use-auth-secret` is an open relay.
- `mv` within one file system replaces a file atomically, so a file written in full under another name and then moved over the target is never read half written. `mktemp` creates its file 0600 root:root, so the mode and group the daemon needs are set before the `mv`.
- Two runs of one script can overlap: a timer and a manual run, or two installs. A fixed temp name such as `x.new` is shared between them, and one run can move the other's half-written file into place. A name from `mktemp` in the target's directory (`mktemp /etc/turnserver.conf.XXXXXX`) is unique to its run.

## systemd

- `systemctl is-active` succeeds only for an active, reloading or refreshing unit. While a unit is `activating` it prints `activating` and exits 3, and a oneshot service is `activating` for its whole run.
- `try-restart` restarts a unit that is active, activating, reloading or refreshing, and does nothing to one that is inactive, failed or deactivating.
- The default start limit is 5 starts in 10 s, and every start counts: manual, `Restart=` and `try-restart`. Past it, every start fails until the 10 s have passed or `systemctl reset-failed` clears the count, and the unit stays failed until something starts it again, which `try-restart` never does. The relay's coturn has a drop-in with `StartLimitIntervalSec=0`; the app box's coturn keeps the default.
- A timer fires up to its `AccuracySec=` late, 1 minute by default.
- `systemctl start` on a service whose start is still running joins that run. Nothing serializes two direct runs of the same script.
- `systemd-run --pipe` connects the unit's stdin, stdout and stderr to the caller, so its output never reaches the journal.

## Names and certificates

- `getent` follows `/etc/nsswitch.conf`, which on Ubuntu is `hosts: files dns`. A name in `/etc/hosts` is answered from there and never reaches DNS, and some installers add `127.0.1.1 <hostname>`.
- Let's Encrypt counts failed validations per DNS name per account: at most 5 an hour, and after 1,152 in a row it pauses that name for the account until someone unpauses it through the link in the error. A validation fails while the name doesn't resolve to the box, so every certificate request made before DNS points there spends both.

## Secrets

- Every local user can read a command's arguments in `ps` and `/proc/<pid>/cmdline`. `set -x` prints each command with its expansions, and in user data that output goes to `/var/log/cloud-init-output.log`. A unit's stdout and stderr go to the journal. A secret appears in none of these only if it never passes through a shell variable or a command argument: the program that needs it reads it from a file or stdin itself, because under `set -x` `s=$(cat file)` traces as `+ s=<secret>`. `sudo` logs each full command line, arguments included, to the journal, which the box keeps 29 days, and an interactive shell saves command lines to its history.
- A filter removes a secret only inside the command that prints it. Once printed, the secret is in the terminal's scrollback or the journal.

## AWS

- The tests in `src/` synthesize templates or run code against fakes; none calls AWS. A claim about what AWS accepts (which IAM actions take a resource ARN, what SES needs before it accepts a setting, what the SES sandbox allows, how Lambda loads a module) rests on an AWS doc or an observed run. The pull request body cites it for the maintainers. The CI reviewer sees only `main` and the diff, so it sees the citation only where the diff adds it, for example in the record or `AGENTS.md` text the claim goes into.
