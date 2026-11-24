# 0011: Monthly traffic cap on the relay

- Status: Accepted
- Date: 2026-11-24
- Linear: SIG-130

## Context

- 0007 puts coturn on the app box and leaves a bandwidth cap for later, "until transfers through the relay have been measured". The budget alert it decided on only sends an email.
- The box is a Lightsail `micro_3_0`. The bundle includes 2 TB of traffic a month. Inbound and outbound both count toward it, and only outbound beyond it is billed, at 0.09 USD/GB in eu-north-1.
- The allowance is pooled across instances of the same bundle in a region. Replacing the box does not reset it.
- Lightsail keeps hourly metrics (`NetworkIn`, `NetworkOut`) for 455 days.
- One relayed transfer of a large file can use the whole allowance. At 1 Gbit/s the box moves about 450 GB an hour.
- CloudFormation's handler for `AWS::Lightsail::Instance` applies the template's ports on every update of the instance.
- Live test, 2026-11-24, box `fidant-app-2a0df4b0`: a 2 GB transfer on fidant.se was forced through the relay over UDP at about 4 MB/s. At 13:29:35 UTC `put-instance-public-ports` left only 80, 443 and 22 open. The recipient's byte count stopped within about 2–4 seconds. The connection showed `disconnected` about 6 s after the close and `closed` about 16 s after it, and it never recovered. All six ports were restored at 13:30:37.

## Options considered

| Option                                                   | For                                                                        | Against                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| On the box: vnstat and a systemd timer that stops coturn | The fewest parts.                                                          | Its count restarts at zero on a replaced box, while AWS's allowance does not. Any change to user data replaces the box. |
| A Lambda reading Lightsail's own hourly metrics (chosen) | Counts the traffic AWS counts. Survives box replacement through the state. | A scheduled function, a parameter and three alarms to keep.                                                             |
| coturn's `bps-capacity`                                  | Nothing outside the box.                                                   | Caps the bill only by throttling everyone to a few Mbit/s, which breaks transfers of one large file.                    |
| Cost Explorer's `EUN1-TotalDataXfer-*` usage types       | Reads the bill's own numbers.                                              | About a day late, and 0.01 USD per call.                                                                                |

## Decision

### The cap

- The limit is 1.8 TB (`relayCapBytes` in `apps/infra/src/config.ts`), 200 GB under the 2 TB allowance. The warning is at 1.44 TB, 80 % of the limit (`relayWarnBytes`).
- A Lambda in FidantApp runs every 5 minutes, from the EventBridge rule `RelayCapSchedule`.
- It sums `NetworkIn` and `NetworkOut` for the box from the first of the month (UTC) to now, from Lightsail's hourly metrics.
- At or above the limit it calls `put-instance-public-ports` with TCP 80, 443 and 22 only. That closes TCP and UDP 3478 and UDP 49152–65535 for IPv4 and IPv6, so the relay is off and the site stays up.
- On the first run below the limit after a capped run, it puts the full list back: 80, 443, 22, 3478 (TCP and UDP) and UDP 49152–65535.
- It does not reboot the box and does not touch coturn.

### State

- SSM parameter `/fidant/relay-cap` holds JSON: the month (`YYYY-MM`), the bytes counted per box name, and whether the ports are closed.
- The total is the sum over every box name of the month, and each box's count only goes up. A replaced box starts at zero in Lightsail's metrics, but the old box's bytes stay in the total, as they do in the pooled allowance.
- A new month starts a fresh state and reopens the ports on the first run.
- A malformed parameter makes the run fail. It does not guess.

### Alerts

- The Lambda logs the total each run as the CloudWatch metric `RelayMonthBytes` (namespace `Fidant`, dimension `Service=relay`).
- Three alarms send email through an SNS topic to budget-alert@fidant.se:
  - "Fidant relay traffic past 80 % of the monthly cap", at 1.44 TB.
  - "Fidant relay stopped: monthly traffic cap reached", at 1.8 TB.
  - "Fidant relay cap failing", when the Lambda errors in 3 runs in a row.
- Missing data does not set off the first two. The third treats missing data as fine.

### Result of the live test

- Closing the ports cuts relayed transfers in progress, within seconds, and they do not recover. The cap needs no reboot or coturn stop.
- Reopening the ports restores the relay for new transfers.

## Consequences

- This supersedes 0007's line "A bandwidth cap waits until transfers through the relay have been measured", for the bill only. Fairness per sender stays with SIG-124. 0007 stays as written.
- A deploy that touches the instance reopens the ports, because CloudFormation applies the template's ports. While the cap is active they stay open until the next run, up to 5 minutes.
- Lightsail's metrics lag by a few minutes, so the cap acts 10–15 minutes late at worst. That is about 110 GB at 1 Gbit/s, inside the 200 GB margin.
- Relayed transfers are cut when the cap closes the ports. Direct transfers and the site are not affected.
- Users get no message in the app. That stays with SIG-124.
- Another Lightsail instance of the same bundle in the region uses the pooled allowance too. The Lambda does not count it.
- About 0.30 USD a month for the three alarms. The rest is in the free tier.

## Runbook

Use the `fidant-poc` profile, in eu-north-1. Sign in first with `aws sso login --sso-session fidant`.

### Read the month's totals

```sh
aws ssm get-parameter --name /fidant/relay-cap --profile fidant-poc --region eu-north-1
```

- `month` is the UTC month. `boxes` holds bytes per box name. `capped` is true while the ports are closed.

### Lift the cap

- Raise `relayCapBytes` in `apps/infra/src/config.ts` (and `relayWarnBytes` with it) and deploy `FidantApp`. The next run reopens the ports.
- Keep the limit under the bundle's allowance, or traffic past it is billed at 0.09 USD/GB.

### Pause the cap

- Disable the EventBridge rule `RelayCapSchedule` in the console. Enabling it again resumes the cap.
- While it is paused, nothing closes or reopens the ports.

### Confirm the email subscription

- After the first deploy, SNS sends a confirmation email to budget-alert@fidant.se. Confirm it once, or the alarms reach no one.
