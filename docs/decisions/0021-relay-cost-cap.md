# 0021: Capping the relay by its estimated overage cost

- Status: Accepted
- Date: 2026-11-25
- Linear: SIG-154 (part of SIG-151; answers SIG-148 question 3)

## Context

In this record, 0011 is `docs/decisions/0011-relay-monthly-cap.md`, 0013 is `docs/decisions/0013-relay-service.md` and 0015 is `docs/decisions/0015-relay-switch.md`.

- 0011 closes the relay ports when the month's traffic reaches 1.8 TB, counting bytes in and bytes out. 0015 counts the app box and the relay box together against the same 1.8 TB, and leaves a cap by cost to SIG-154. SIG-148 question 3 asked whether the cap should count cost instead of bytes, and the answer was yes, with a budget of about 20 USD a month.
- Lightsail counts traffic in and out toward an instance's allowance, and bills only outbound traffic past it, at 0.09 USD/GB in eu-north-1. Inbound traffic past the allowance is free. Traffic over private IP addresses counts toward the allowance but is free too ([Data transfer in Lightsail](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-data-transfer-allowance.html)).
- The allowance is pooled across instances of the same bundle in a Region. A `micro_3_0` box has 2 TB, so the app box and the relay box share 4 TB when both run for a full month. Of the guide's examples, only Example 2 says "for a full month". Example 3 gives a pool with no such condition. In Example 5, deleting every instance and creating new ones in the same month keeps the pool and what the month has used. No example says how much a box created during the month adds to a pool that isn't used up yet. In Example 6, an instance created after the pool is used up doesn't stop further outbound traffic from being billed.
- The bill depends on the order of the traffic: outbound bytes are billed only once the pool is used up. In the guide's Example 1, a 1 TB pool, 500 GB goes out and 400 GB comes in, then 200 GB goes out: the bill is 100 GB. Another 200 GB that comes in after that costs nothing.
- The cap's Lambda reads only sums: `NetworkIn` and `NetworkOut` per box, "the number of bytes received on all network interfaces" and sent ([GetInstanceMetricData](https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_GetInstanceMetricData.html)). Every 5 minutes it reads the hourly sums from the 1st (UTC) to now and adds them up, so it doesn't keep the order the bytes came in.
- A byte cap counts inbound traffic. A flood sent to either box at 1 Gbit/s, about 450 GB an hour (0011), reaches 1.8 TB in about 4 hours and switches the relay off until the 1st, without costing anything (SIG-148). The 1.8 TB limit also stops the relay with most of the 4 TB pool unused (0015).

## Options considered

| Option                                                                           | For                                                                                                                                                                    | Against                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The byte cap of 0011 and 0015, 1.8 TB in and out (today)                         | No new logic. Stays under one box's allowance, whatever a box created during the month adds.                                                                           | Inbound traffic, which is free, can switch the relay off. Uses less than half the pool.                                                                                                                         |
| A cap on outbound bytes only                                                     | Inbound traffic alone can't close the relay.                                                                                                                           | Inbound traffic uses up the pool too. A limit that bounds the bill whatever came in, about 222 GB, stops the relay with the pool unused. A limit past the pool doesn't bound the bill once inbound has used it. |
| The estimated overage, an upper bound on the bill from the month's sums (chosen) | Bounds the bill under the conditions below. Inbound traffic alone can't close the relay, apart from a box's count carried over from the byte cap. Uses the whole pool. | Loose when outbound came first: once about 222 GB has gone out in a month, enough inbound traffic can close the relay. Rests on the pool being 4 TB.                                                            |
| Cost Explorer or the bill                                                        | Reads the bill's own numbers.                                                                                                                                          | About a day late, and 0.01 USD per call (0011). Once the pool is used up, a day of outbound traffic at 1 Gbit/s costs about 970 USD.                                                                            |

## Decision

The cap closes the relay ports when the month's estimated overage reaches 20 USD. It opens them again once the estimate is below the budget, for example on the 1st (UTC), or sooner after a deploy that raises the budget.

### The estimate

- Every 5 minutes the Lambda reads each box's `NetworkIn` and `NetworkOut` from the 1st (UTC), as in 0011, and keeps the two apart.
- `in` and `out` are the month's bytes in and bytes out, summed over every box in the state. `A` is the pool, `ALLOWANCE_BYTES`: 2 TB (`boxAllowanceBytes` in `apps/infra/src/config.ts`) for each box in `BOXES`, so 4 TB with the app box and the relay box.
- The estimated overage in USD is `min(out, max(0, in + out - A)) / 1e9 * 0.09`. The price is `overageUsdPerGb`.
- When the estimate is at or above the budget, 20 USD (`relayOverageBudgetUsd`), every box gets its capped ports (0015). On the first run with the estimate below the budget after a capped run, every box gets its open ports again. For example, that happens on the first run of a new month (UTC), which starts from zero, and on the first run after a deploy that raises the budget above the estimate. A deploy that adds a box to `BOXES` raises the pool, which lowers the estimate and can reopen the ports too.
- Each run logs the estimate as `RelayMonthOverageUsd` (namespace `Fidant`, dimension `Service=relay`), next to `RelayMonthBytes`, which keeps its name and meaning: bytes in plus bytes out.

### Why the estimate is an upper bound

- The bill charges the outbound bytes sent after the month's traffic, in and out, passed the pool. So it is at most `out`, and at most `in + out - A`. It equals the smaller of the two when all inbound traffic came first. The estimate assumes that order, the most expensive one.
- So the estimate is at or above the bill when three things hold:
  - (a) `A` is no larger than the real pool;
  - (b) the counted bytes are at least the metered bytes;
  - (c) no other `micro_3_0` instance in eu-north-1 draws on the pool.
- (a) is unproven for a box created during the month. The relay box started in late November 2026, so November's pool may be smaller than 4 TB, and November's estimate may be below the bill. We accept that. From December both boxes run whole months, until SIG-264 (see Consequences).
- (b): the metrics count every network interface, so private traffic counts too, which errs high. That their sums equal AWS's meter is unverified: compare them with the month's bill. Whether AWS's GB is 10^9 or 2^30 bytes is unverified too. Dividing by 10^9 errs high if it is 2^30.
- (c): the Lambda counts only the boxes in `BOXES` (0015).
- Against AWS's examples:
  - The guide's Example 1 (a 1 TB pool, 600 GB in and 700 GB out in all) bills 100 GB. The estimate is 300 GB, above the bill.
  - Example 2 on [Amazon Lightsail pricing](https://aws.amazon.com/lightsail/pricing/) has a 4 TB pool. Its traffic came in the order the estimate assumes: "You first consumed 2.2TB of ingress data transfer and then had 2.1TB of outgoing DT out in the month." The estimate is 300 GB, the outbound traffic past the pool. The page bills "100 GB * $0.09 USD / GB", which doesn't follow from its own numbers. The estimate is at or above either.
- Inbound traffic alone can't close the relay, apart from a box's count carried over from the byte cap: the estimate is at most the month's outbound at 0.09 USD/GB, and the first run keeps a carried-over count as outbound (see "State"). So, apart from such a count, the relay closes only once at least about 222 GB (20 / 0.09) has gone out in the month. With no inbound traffic, it closes after about 4.22 TB of outbound.

### Accepted limits

- **Inbound counted first.** The estimate is loose when outbound traffic came first. Once about 222 GB has gone out in a month, an inbound flood can close the relay. Tracking the order hour by hour would tighten it, at about 20 more lines.
- **November's pool.** See (a).
- **The site's own overage past the budget is still billed.** The cap closes only the relay ports. The site's traffic on the app box, and any other traffic on the ports each box keeps, still counts and is still billed once the pool is used up.
- **Lag.** Lightsail's metrics lag, so the cap acts 10–15 minutes late at worst (0011). That is about 110 GB at 1 Gbit/s, so the bill can end about 10 USD past the budget.
- **The app box's ports stay as in 0015.** The cap still closes the app box's coturn ports on 3478 and the UDP relay range. It doesn't close TURN over TLS there: the app box keeps 443 for the site, and HAProxy passes `turn.fidant.se` to coturn (0010, SIG-162). If the relay list is turned off while the cap is active, the server mints credentials for that coturn again (0015), so relayed traffic may still pass through the app box over TLS.

### Alarms

- "Fidant relay traffic past 80 % of the allowance": `RelayMonthBytes` at or above 3.2 TB, 80 % of the pool.
- "Fidant relay stopped: overage budget reached": `RelayMonthOverageUsd` at or above 20.
- Both email the topic of 0011's alarms, also when they return to OK, and ignore missing data. Their construct IDs stay `RelayWarn` and `RelayCapped`.
- CloudFormation can't rename an alarm in place: its `AlarmName` says "Update requires: Replacement" ([AWS::CloudWatch::Alarm](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cloudwatch-alarm.html)). So the deploy deletes both alarms under their old names and creates them under the new ones. A new alarm starts in `INSUFFICIENT_DATA`, and its OK actions run when it moves to OK. So expect two OK emails after the deploy, one for each renamed alarm.

### State

- `/fidant/relay-cap` holds `{"month":"YYYY-MM","boxes":{"<box name>":{"in":<bytes>,"out":<bytes>}},"capped":<true or false>}`.
- Within a month, each box's `in` and `out` only go up. A box that is no longer in `BOXES`, such as a replaced one, stays in the state until the month ends, as in 0011.
- The first run after the deploy reads 0011's shape too, where a box holds one number, its bytes in plus bytes out:
  - A box in `BOXES` gets its fresh read. Every run reads both directions from the 1st, so nothing is lost.
  - A box not in `BOXES` keeps its number as `{"in":0,"out":<number>}`, all of it outbound, which keeps the upper bound.
  - A state from an earlier month is dropped, as before.
  - A state that the 1.8 TB limit capped opens both boxes again when the estimate is under the budget, and the run writes `"capped":false`.
- After one run, the parameter holds only the new shape. Anything else malformed fails the run, as in 0011.

### What closes

- Each box gets its capped ports from 0015. The app box keeps TCP 80, 443 and 22. The relay box keeps TCP 22 from `lightsail-connect` and TCP 80. That closes STUN and TURN on 3478 and the UDP relay range on both boxes, and the relay box's TURN over TLS on 443.
- Relayed transfers in progress stop within seconds (0011's live test).
- STUN closes with the relay. The server's check of `sto` fails, so after two failed checks `sto` is down (0015), and pairings get only its `stun:` URL, which doesn't answer. Until the ports open again, new pairings get no public address from our STUN service. A new transfer then connects only where it can without STUN, for example on the same local network. Direct transfers already running keep running, and the site stays up.
- The app box keeps 443, so its coturn's TLS listener stays reachable through HAProxy while the cap is active (0010, SIG-162). While the server has a relay list, it mints no credentials for that coturn (0015).

### Replacements to 0011, 0013 and 0015

This record amends 0011, 0013 and 0015. They are not superseded. Read them with these replacements. Some rows quote words of 0011 that 0015 also replaced. There, only the words this table quotes change to this table's text, and 0015's replacements of the rest still apply.

| Where it says                                                                                                                                                                                                           | Read                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0011: "The limit is 1.8 TB (`relayCapBytes` in `apps/infra/src/config.ts`), 200 GB under the 2 TB allowance. The warning is at 1.44 TB, 80 % of the limit (`relayWarnBytes`)."                                          | The cap closes the relay ports when the month's estimated overage reaches 20 USD (`relayOverageBudgetUsd` in `apps/infra/src/config.ts`), see "The estimate" in 0021. The warning is at 3.2 TB of traffic in and out, 80 % of the 4 TB pool.                     |
| 0011: "It sums `NetworkIn` and `NetworkOut` for the box from the first of the month (UTC) to now, from Lightsail's hourly metrics."                                                                                     | For every box in `BOXES`, it sums `NetworkIn` and `NetworkOut` separately from the first of the month (UTC) to now, from Lightsail's hourly metrics, so each box has its bytes in and its bytes out.                                                             |
| 0011: "At or above the limit" and "On the first run below the limit after a capped run"                                                                                                                                 | "When the estimated overage is at or above the budget" and "On the first run with the estimate below the budget after a capped run"                                                                                                                              |
| 0011: "the bytes counted per box name"                                                                                                                                                                                  | the bytes in and the bytes out counted per box name, as `{"in":<bytes>,"out":<bytes>}`                                                                                                                                                                           |
| 0011: "each box's count only goes up"                                                                                                                                                                                   | each box's bytes in and bytes out only go up                                                                                                                                                                                                                     |
| 0011: "The Lambda logs the total each run as the CloudWatch metric `RelayMonthBytes` (namespace `Fidant`, dimension `Service=relay`)."                                                                                  | The same, and each run also logs the estimated overage in USD as `RelayMonthOverageUsd`, with the same namespace and dimension.                                                                                                                                  |
| 0011: '"Fidant relay traffic past 80 % of the monthly cap", at 1.44 TB.'                                                                                                                                                | "Fidant relay traffic past 80 % of the allowance", when `RelayMonthBytes` is at or above 3.2 TB, 80 % of the pool.                                                                                                                                               |
| 0011: '"Fidant relay stopped: monthly traffic cap reached", at 1.8 TB.'                                                                                                                                                 | "Fidant relay stopped: overage budget reached", when `RelayMonthOverageUsd` is at or above 20.                                                                                                                                                                   |
| 0011: "That is about 110 GB at 1 Gbit/s, inside the 200 GB margin."                                                                                                                                                     | That is about 110 GB at 1 Gbit/s, so the bill can end about 10 USD past the budget.                                                                                                                                                                              |
| 0011: "Direct transfers and the site are not affected."                                                                                                                                                                 | Direct transfers already running and the site are not affected. STUN closes with the relay, so until the ports open again, new pairings get no public address from our STUN service (see "What closes" in 0021).                                                 |
| 0011: "About 0.30 USD a month for the three alarms."                                                                                                                                                                    | About 0.30 USD a month for the three alarms, plus the two alarms and two metrics of 0015 and the metric `RelayMonthOverageUsd` of 0021 (see their Consequences).                                                                                                 |
| 0011, Read the month's totals: "`boxes` holds bytes per box name."                                                                                                                                                      | `boxes` holds `{"in":<bytes>,"out":<bytes>}` per box name. "Read the month's totals" in 0021 reads the estimate and adds them up.                                                                                                                                |
| 0011, Lift the cap: "Raise `relayCapBytes` in `apps/infra/src/config.ts` (and `relayWarnBytes` with it) and deploy `FidantApp`."                                                                                        | Raise `relayOverageBudgetUsd` in `apps/infra/src/config.ts` and deploy `FidantApp`.                                                                                                                                                                              |
| 0011, Lift the cap: "Keep the limit under the bundle's allowance, or traffic past it is billed at 0.09 USD/GB."                                                                                                         | The budget is what the month's overage may cost by the estimate. Each USD more lets about 11 GB more go out past the pool.                                                                                                                                       |
| 0011, Pause the cap: "To reopen them, raise the cap instead"                                                                                                                                                            | To reopen them, raise the budget instead                                                                                                                                                                                                                         |
| 0013: "each with its own secret and cap"                                                                                                                                                                                | each with its own secret, and the boxes in `BOXES`, which share Lightsail's pooled allowance, under one cap (0015 and 0021)                                                                                                                                      |
| 0013: "SIG-154 takes coturn, HAProxy and the relay ports off the app box."                                                                                                                                              | SIG-264, part of the hosting move SIG-259, takes coturn, HAProxy and the relay ports off the app box and deletes the app box.                                                                                                                                    |
| 0015: "Kept until SIG-154 (chosen)" and "The app box's coturn stays, and the app uses it only without a relay list, until SIG-154."                                                                                     | "Kept until SIG-264 (chosen)" and "The app box's coturn stays, and the app uses it only without a relay list, until SIG-264."                                                                                                                                    |
| 0015: "It sums them for every box in `BOXES`: the app box and the relay box."                                                                                                                                           | It sums each of them separately for every box in `BOXES`, the app box and the relay box, so each box has its bytes in and its bytes out.                                                                                                                         |
| 0015: "`/fidant/relay-cap` keeps each box's count, as in 0011." and "At or above the limit, every box gets its capped ports. On the first run below the limit after a capped run, every box gets its open ports again." | `/fidant/relay-cap` keeps each box's bytes in and bytes out. When the estimated overage is at or above the budget, every box gets its capped ports. On the first run with the estimate below the budget after a capped run, every box gets its open ports again. |
| 0015: "The limit stays at 1.8 TB (`relayCapBytes`), now for both boxes together, and the warning at 1.44 TB. SIG-154 replaces the byte limit with a cost cap."                                                          | The cap closes the relay ports when the estimated overage of both boxes together reaches 20 USD. The warning is at 3.2 TB, 80 % of their 4 TB pool.                                                                                                              |
| 0015: "The pool both boxes draw on is now counted whole, and 1.8 TB stays under one box's allowance. Until SIG-154, a month can stop the relays with most of the relay box's allowance unused."                         | The pool both boxes draw on is counted whole, and the cap uses all of it: with no inbound traffic, the relays stop after about 4.22 TB of outbound traffic in a month.                                                                                           |
| 0015, Live cap check: "Its value is `{"month":"YYYY-MM","boxes":{"<box name>":<bytes>},"capped":<true or false>}`."                                                                                                     | Its value is `{"month":"YYYY-MM","boxes":{"<box name>":{"in":<bytes>,"out":<bytes>}},"capped":<true or false>}`.                                                                                                                                                 |
| 0015, Live cap check: "and the total was under the limit"                                                                                                                                                               | and the estimated overage was under the budget                                                                                                                                                                                                                   |

## Consequences

- No box is replaced. No user data changes, and `apps/infra/src/stacks.test.ts` pins both instance names.
- The IAM policy and the port lists don't change, and the `jq` in 0015's "Live cap check" touches only `.capped`. So that check doesn't need to run again.
- A flood of inbound traffic alone no longer switches the relay off, apart from a box's count carried over from the byte cap in the month of the deploy (see "State"). Outbound traffic still does, once the estimate reaches the budget.
- The relays can use the whole pool: with no inbound traffic they stop after about 4.22 TB of outbound traffic in a month, where the byte cap stopped them at 1.8 TB in and out.
- A month's overage bill can pass 20 USD. For example: by about 10 USD of lag; by traffic on the ports each box keeps after the relay closes, such as the site's traffic, the relay box's own traffic on TCP 80 and 22, and TURN over TLS through the app box's 443 (0010); in November by a smaller pool, see (a); and whenever (b) or (c) doesn't hold.
- When the cap closes the relay, "Fidant relay sto unavailable" goes to ALARM too, because the server's check fails (0015). It returns to OK once the ports open again and a check passes.
- Users still get no message in the app (0011).
- One more custom metric, `RelayMonthOverageUsd`, costs 0.30 USD a month at list price ([Amazon CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)). The renamed alarms cost what the old ones did.
- SIG-264, part of the hosting move SIG-259, deletes the app box. The app box then leaves `BOXES`, and `A` drops to 2 TB with it. From the next whole month, (a) holds. In the month of the deletion it is unproven, as in November: the guide doesn't say whether deleting a box shrinks that month's pool. The app box's bytes stay in the state until the 1st while `A` halves, so that deploy can raise the estimate by up to about 180 USD and close the relay at once. Read the month's totals before it, or make it early in a month.

## Runbook

Use the `fidant-poc` profile, in eu-north-1. Sign in first with `aws sso login --sso-session fidant`. The commands need `jq`.

### Before the deploy

```sh
names=$(aws lightsail get-instances --query 'instances[].name' --output json --profile fidant-poc --region eu-north-1) &&
  aws ssm get-parameter --name /fidant/relay-cap --query Parameter.Value --output text --profile fidant-poc --region eu-north-1 |
  jq -c --argjson names "$names" '[.boxes | keys[] | select(. as $b | $names | index($b) | not)]'
```

- It prints the box names in the state that match no existing instance. `[]` means none.
- A name it prints is a box replaced this month. After the deploy its count is kept as outbound until the 1st (see "State"), which keeps the upper bound but can close the relay sooner. That only matters once the month's traffic in and out passes the 4 TB pool, so the deploy can go ahead: read the month's totals after it.
- If it prints no list, a command failed, for example because the parameter is missing, and the check failed.

### After the deploy

1. 10 minutes after the deploy finishes, check that a run has written the new shape:

```sh
aws ssm get-parameter --name /fidant/relay-cap --query Parameter.Value --output text --profile fidant-poc --region eu-north-1 | jq '(.boxes | length) > 0 and all(.boxes[]; type == "object" and has("in") and has("out"))'
```

- It must print `true`. `false` means a box still holds the old shape, so no run has finished since the deploy. Read the Lambda's log as in step 3 of 0015's "Live cap check".

2. 15 minutes after the deploy finishes:

```sh
aws cloudwatch describe-alarms --alarm-names "Fidant relay cap failing" --query 'MetricAlarms[].StateValue' --output text --profile fidant-poc --region eu-north-1
```

- It must print `OK`. The alarm needs 3 failed runs in a row (0011), so before 15 minutes `OK` proves nothing.

3. The renamed alarms, also 15 minutes after the deploy finishes:

```sh
aws cloudwatch describe-alarms --alarm-names "Fidant relay traffic past 80 % of the allowance" "Fidant relay stopped: overage budget reached" "Fidant relay traffic past 80 % of the monthly cap" "Fidant relay stopped: monthly traffic cap reached" --query 'MetricAlarms[].[AlarmName,StateValue]' --output text --profile fidant-poc --region eu-north-1
```

- It must print exactly two lines: the two new names, each with `OK`.
- A line with an old name means the deploy didn't replace that alarm. `INSUFFICIENT_DATA` means no run has logged its metric yet: check step 2.
- `ALARM` on "Fidant relay traffic past 80 % of the allowance" means the month's traffic in and out has reached 3.2 TB. That is traffic, not a fault of the deploy.
- `ALARM` on "Fidant relay stopped: overage budget reached" means the estimate has reached the budget and the cap has closed the relay ports. A replaced box's carried-over count can cause that in the month of the deploy. Read the month's totals, and see "Lift the cap".
- The two OK emails arrive when the alarms move to OK.

### If the deploy rolls back

- CloudFormation can roll back a `FidantApp` deploy after the new Lambda has already run. The state then holds the new shape, which the restored code can't read, so every run fails and the cap changes no ports.
- So if the deploy rolled back, or "Fidant relay cap failing" isn't `OK` 15 minutes after a failed deploy (step 2 of "After the deploy"), run steps 2 to 4 of "Roll back to the byte cap" once the rollback has finished. It has finished when this prints `UPDATE_ROLLBACK_COMPLETE`. A status ending in `_IN_PROGRESS` means wait. `UPDATE_ROLLBACK_FAILED` means the rollback needs `aws cloudformation continue-update-rollback --stack-name FidantApp --profile fidant-poc --region eu-north-1` first:

```sh
aws cloudformation describe-stacks --stack-name FidantApp --query 'Stacks[].StackStatus' --output text --profile fidant-poc --region eu-north-1
```

### Read the month's totals

```sh
aws cloudwatch get-metric-statistics --namespace Fidant --metric-name RelayMonthOverageUsd --dimensions Name=Service,Value=relay --statistics Maximum --start-time "$(date -u +%Y-%m-01T00:00:00Z)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --period 2678400 --query 'Datapoints[].Maximum' --output text --profile fidant-poc --region eu-north-1
```

- It prints the highest estimate in USD that a run has logged since the 1st (UTC), for example `3.15`. If CloudWatch splits the month into two periods it prints two numbers, and the larger one counts. No output means no run has logged it this month.
- The highest is the current estimate unless the estimate went down this month, for example after a deploy that added a box to `BOXES`.

```sh
aws ssm get-parameter --name /fidant/relay-cap --query Parameter.Value --output text --profile fidant-poc --region eu-north-1 | jq -c '{month, in: ([.boxes[].in] | add), out: ([.boxes[].out] | add), capped}'
```

- It prints one line like `{"month":"2026-12","in":<bytes>,"out":<bytes>,"capped":false}`. `in` and `out` are the month's bytes over every box in the state. `capped` is `true` while the ports are closed.
- It reads only the new shape, so it fails before the first run after the deploy.

### Lift the cap

- Raise `relayOverageBudgetUsd` in `apps/infra/src/config.ts` and deploy `FidantApp`. A merge to main that touches `apps/infra/**` deploys it through `deploy-infra.yml`, and needs a `maintainers` approval. Or deploy by hand with `pnpm --filter @sigill/infra cdk deploy FidantApp --profile fidant-poc`. The stop alarm's threshold moves with the budget.
- Six minutes after the deploy:

```sh
aws ssm get-parameter --name /fidant/relay-cap --query Parameter.Value --output text --profile fidant-poc --region eu-north-1 | jq .capped
```

- It must print `false`. `true` means the estimate is still at or above the new budget (see "Read the month's totals"), or a call failed (read the Lambda's log as in step 3 of 0015's "Live cap check").
- Without a deploy, the ports open again on the first run of the next month (UTC).

### Roll back to the byte cap

1. Revert SIG-154's changes to `apps/infra/src/` in a pull request, and deploy `FidantApp`. The old code throws on the new shape, so every run fails and changes no ports until step 2. The deploy replaces both alarms again, so expect two OK emails.

2. Once the deploy has finished, rewrite the state in 0011's shape:

```sh
v=$(aws ssm get-parameter --name /fidant/relay-cap --query Parameter.Value --output text --profile fidant-poc --region eu-north-1) &&
  new=$(printf '%s' "$v" | jq -c '.boxes |= map_values(if type == "object" then .in + .out else . end)') &&
  [ -n "$new" ] &&
  aws ssm put-parameter --name /fidant/relay-cap --type String --overwrite --value "$new" --profile fidant-poc --region eu-north-1
```

- It prints the parameter's new `Version` and `"Tier": "Standard"`.
- Run before the deploy has finished, it is undone: the next run of the new code writes its own shape again. Step 3 shows that.

3. Six minutes after step 2:

```sh
aws ssm get-parameter --name /fidant/relay-cap --query Parameter.Value --output text --profile fidant-poc --region eu-north-1 | jq '(.boxes | length) > 0 and all(.boxes[]; type == "number")'
```

- It must print `true`. `false` means the new code wrote over step 2: check that the deploy has finished, then run step 2 again.

4. 15 minutes after step 2, the command in step 2 of "After the deploy" must print `OK`. That proves the byte cap's runs succeed.

- If the month's traffic in and out is already at or above 1.8 TB, the byte cap's first run closes the relay ports (0011).
