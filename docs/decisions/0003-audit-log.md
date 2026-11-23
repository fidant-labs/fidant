# 0003: Audit log design

- Status: Accepted
- Date: 2026-11-23
- Linear: SIG-9

## Context

### The question

The audit log must make tampering visible, including tampering by us. SIG-9 asks for four decisions:

- **Chain shape.** One hash chain per transfer, or one global chain.
- **Append-only.** How the store refuses updates and deletes.
- **Trusted timestamps.** Which RFC 3161 timestamp authority (TSA) the POC uses, and how often we anchor.
- **Offline checks.** What a verifier needs to check the log without access to our systems.

SIG-12 builds what this record decides.

### What 0001 and 0002 already settle

These are inputs, not decisions of this record:

- **Events and fields.** 0002's table "Personal data per audit event" lists every event type and its fields. Every event has `eventId`, `transferId`, `at` and its chain hash.
- **No direct identity in the chain.** Parties appear as `partyRef = HMAC-SHA256(serverPepper, personnummer)`. Names and personnummer live in a separate, deletable `parties` table. The pepper is a server secret kept outside the database. No IP address and no user agent.
- **No file name.** The audit log and the TSA hold hashes of the BankID signature or the signed receipt text, never the signature itself (0001, exception (e)). The signature lives in one database column.
- **Time.** Every event has the server's UTC time. The TSA anchors the chain in batches.
- **Evidence package.** SIG-19 and SIG-20 assemble it in the browser. It carries a transfer's `download.confirmed` event and its chain proof once the event's batch is anchored.
- **Offline.** The project must run fully local for tests and demos. 0001 lists a local timestamp authority in the local stack.

### What SIG-58 settles

- The POC host is one Lightsail Micro instance in eu-north-1. It runs the app server and the TURN relay.
- The database must not run on that box, because the relay is the most exposed machine.
- SIG-58 left the store to this issue: Postgres (managed, about $14 a month, always on) or DynamoDB on demand ($0 when idle, the first 25 GB free).

### Who we defend against

- **Us, or someone with our credentials.** The account owner can do anything to any AWS store: overwrite items, delete tables, restore backups. No store setting stops that. What must hold is that a change after the fact is **visible** to anyone holding an earlier piece of evidence.
- **A compromised app server.** It holds the app's database credentials. It should not be able to update or delete log entries through normal API calls, and anything it does manage to change must be visible as above.
- **A bug.** Code that updates or deletes log entries by mistake must fail.

What a hash chain cannot show: events that were never written. If the server skips logging an event, no chain detects it. The parties' own evidence (receipts, returned event hashes) is the check there.

## Options considered

### Chain shape

| Option                                                                     | For                                                                                       | Against                                                                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| One global chain                                                           | One head to anchor; deleting anything anywhere breaks it                                  | Every write serialises on one head. An evidence package needs every event of every transfer, or none can check. |
| One chain per transfer, each head timestamped on its own                   | Small, self-contained evidence                                                            | One TSA request per transfer per anchor; many requests to free TSAs                                             |
| One chain per transfer, heads batched into a Merkle tree, root timestamped | Small evidence (the transfer's events plus a short audit path); one TSA request per batch | A Merkle proof to build and store per anchored head                                                             |

### Store and append-only

| Option                               | How it refuses updates and deletes                                                                                                                                                                                    | Against                                                                                                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres on its own managed instance | The app role gets only `INSERT` and `SELECT`. A trigger raises on `UPDATE` and `DELETE`, a statement trigger on `TRUNCATE`. The table owner is a separate role.                                                       | About $14–15 a month, always on. A superuser still bypasses both.                                                                                                                                                                                          |
| Postgres on the Lightsail app box    | As above                                                                                                                                                                                                              | $0 extra, but reverses SIG-58: the database sits on the most exposed machine.                                                                                                                                                                              |
| DynamoDB on demand                   | Writes use `PutItem` with `attribute_not_exists`, so an existing item is never overwritten. The app's IAM policy denies `UpdateItem`, `DeleteItem`, `BatchWriteItem`, PartiQL updates and deletes, and table changes. | IAM cannot force the condition on `PutItem`: stolen app credentials can still overwrite an item with an unconditional put. DynamoDB Local ignores IAM, so the refusal is only testable as a policy document locally. The local stack needs Java or Docker. |

In every option, the store's refusal stops bugs and casual misuse. Against us, only the chain and the external anchors make changes visible.

### Timestamp authority

| Option                                     | For                                               | Against                                                                                                 |
| ------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| FreeTSA (`https://freetsa.org/tsr`)        | Free, RFC 3161                                    | A hobby project; little weight in a dispute; no published availability                                  |
| DigiCert (`http://timestamp.digicert.com`) | Free, widely trusted, used for code signing       | A single provider                                                                                       |
| Both, one token from each per batch        | Survives one TSA disappearing or being distrusted | Two HTTP calls per batch                                                                                |
| A qualified TSA under eIDAS                | Legal presumption of accuracy (eIDAS Art. 41)     | Paid, needs a contract; not needed for the POC. SIG-28 already says the POC is not a qualified service. |
| Local `openssl ts` authority               | Runs offline                                      | Proves nothing outside our own systems; tests and demos only                                            |

### How often to anchor

| Option                                           | For                                                             | Against                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| On every event                                   | No window at all                                                | One TSA call per event, and a TSA outage blocks transfers                 |
| On a fixed schedule, only when something changed | Bounded cost; idle costs nothing; transfers never wait on a TSA | Until the next anchor, we could rewrite a transfer's recent events unseen |
| Daily                                            | Cheapest                                                        | A day-long window, and evidence packages wait up to a day                 |

The window between an event and its anchor can be closed another way: the server returns each new event's hash to the browser that caused the event, and the browser keeps it in its evidence. A later rewrite then contradicts evidence a party already holds.

### Offline checks

A verifier without access to our systems needs to recompute everything from the evidence package. The options are how much the package carries:

- **Events only.** The verifier must ask us for anchors and proofs. Fails the requirement.
- **Events, audit path, root and TSA tokens.** Enough to check the chain and its timestamp with standard tools.
- **Also publish every batch root** somewhere public and append-only. Shows that no batch was withdrawn, at the cost of running a public log. Not needed while each package carries its own TSA tokens.

## Decision

### Chain shape: one chain per transfer, heads batched into a Merkle tree

- Each transfer has its own chain. Events are numbered `seq = 0, 1, 2, …` within the transfer.
- An event is a flat JSON object: `v` (1), `eventId`, `transferId`, `seq`, `type`, `at`, and the fields 0002 lists for its type. Values are strings, safe integers or booleans only. `at` is the server's UTC time as ISO 8601 with milliseconds, for example `2026-11-23T13:02:00.000Z`. Hashes inside fields are lowercase hex.
- **Canonical form.** `canon(event)` is `JSON.stringify` with keys sorted by code point. With only strings, safe integers and booleans, this equals RFC 8785 (JCS), so other languages can reproduce it without our code.
- **Chain hash.** `hash = SHA-256(prevHash ‖ UTF-8(canon(event)))`, where `prevHash` is the previous event's `hash` and, for `seq` 0, 32 zero bytes. `event` already contains `transferId` and `seq`, so a hash cannot be replayed in another chain or position.
- **Batches.** The leaves of a batch are, in this order:
  1. the previous batch's root (omitted in the first batch), so batches form a chain of their own and withdrawing a batch is visible;
  2. the current head `hash` of every transfer that has new events since its last anchor, sorted by `transferId`.
- **Merkle tree.** RFC 6962, section 2.1: leaf hash `SHA-256(0x00 ‖ leaf)`, node hash `SHA-256(0x01 ‖ left ‖ right)`, the same split for counts that are not a power of two, and the same audit paths.

### Store: DynamoDB on demand

The audit log lives in DynamoDB in eu-north-1. Locally and in tests it runs against DynamoDB Local.

| Table           | Key                          | Holds                                                                | Writes by the app                              |
| --------------- | ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| `audit_events`  | `transferId`, `seq`          | The event's fields, `prevHash`, `hash`                               | Conditional `PutItem` only                     |
| `audit_anchors` | `batchId` (a number, from 0) | `root`, `leafCount`, `prevRoot`, `anchoredAt`, one TSA token per TSA | Conditional `PutItem` only                     |
| `audit_proofs`  | `transferId`, `seq`          | `batchId`, `leafIndex`, the audit path, for each anchored head       | Conditional `PutItem` only                     |
| `audit_pending` | `transferId`                 | A random `token`; marks a transfer with events not yet anchored      | `PutItem`, conditional `DeleteItem`            |
| `parties`       | `partyRef`                   | Name and personnummer (0002). Not part of the chain.                 | `PutItem`, `UpdateItem`, `DeleteItem` (SIG-29) |

- **Appending.** One function appends events; every other module calls it. It reads the transfer's head with a strongly consistent `Query` (descending, limit 1), computes `seq` and `hash`, and writes with `ConditionExpression: attribute_not_exists(seq)`. If two writers race, one condition fails, and that writer reads the head again and retries. After the event is written, it puts the transfer's `audit_pending` item with a fresh `token`.
- **Refusing updates and deletes.** The app's IAM policy allows only `PutItem`, `GetItem` and `Query` on `audit_events`, `audit_anchors` and `audit_proofs`, and explicitly denies `UpdateItem`, `DeleteItem`, `BatchWriteItem`, `PartiQLUpdate`, `PartiQLDelete`, `DeleteTable`, `UpdateTable` and `UpdateTimeToLive`. TTL stays off on these tables. Deletion protection and point-in-time recovery are on.
- **What this does not stop.** IAM cannot require the condition on `PutItem`, so stolen app credentials could overwrite an item with an unconditional put. Lightsail has no instance roles, so those credentials are an access key on the box. We accept this for the POC: the chain and the anchors make such an overwrite visible. DynamoDB Streams with an alarm on `MODIFY` and `REMOVE` would also report it as it happens; that waits for production.
- **Cost.** About $0 at POC volume: storage is in the free 25 GB, and each event costs one write and one read.

### Trusted timestamps: FreeTSA and DigiCert, every 10 minutes when something changed

- **Production and demos on the host:** every batch root is timestamped by both `https://freetsa.org/tsr` and `http://timestamp.digicert.com`. The request is an RFC 3161 `TimeStampReq` with SHA-256 of the root as its message imprint, a random nonce and `certReq = true`, so the token carries the TSA's certificate.
- **Locally, in tests and offline demos:** a local TSA built on `openssl ts`, as 0001 lists. It plays both roles. Its tokens prove nothing outside our systems.
- A batch counts as anchored when at least one TSA returned a valid token: correct imprint and nonce, a signature that checks, and a time within a few minutes of the server's clock. A missing second token is not retried; the next batch covers the same heads again only if they changed.
- **Schedule.** The app server runs the anchoring job every 10 minutes, and only when `audit_pending` has items. No events, no TSA calls.
- **The job.** It scans `audit_pending`, reads each transfer's head with a strongly consistent `Query`, builds the tree, gets the tokens, and writes `audit_anchors` and then one `audit_proofs` item per head. If a run stops halfway, the next run anchors the same heads again in a new batch; a proof that already exists for a head is kept, and the refused write is not an error. Then it deletes each `audit_pending` item on the condition that its `token` is still the one it read, so a transfer that got a new event in the meantime stays pending for the next batch.
- **The window before an anchor.** Every API response that appends an event returns the event's `seq` and `hash`. The browser keeps them for the evidence package. A rewrite before the anchor then contradicts a hash the party already holds.
- **Ceiling.** If the server stops between writing an event and writing its `audit_pending` item, that event is anchored with the transfer's next event. Every transfer ends with `transfer.expired` or `transfer.revoked`, so it is anchored at the latest then. That holds only if expiry is logged when it happens; SIG-12 makes sure it is.

### Offline checks: the evidence package carries everything

For one transfer, the evidence package (SIG-19, SIG-20) carries:

1. the transfer's events from `seq` 0 to the anchored head, with their `hash` values;
2. the `audit_proofs` item for that head: `batchId`, `leafIndex`, audit path;
3. the `audit_anchors` item: `root`, `leafCount`, `prevRoot` and every TSA token;
4. each TSA's certificate chain, and the event hashes the browser received when the events were written.

The verifier then, with no access to our systems:

1. Recomputes every `hash` from `canon(event)` and `prevHash`, and checks it against the stored value and against the hashes the browser received.
2. Recomputes the root from the head `hash` and the audit path (RFC 6962), and checks it against `root`.
3. Checks each TSA token: its message imprint is SHA-256 of `root`, and its signature checks against the TSA certificate chain. With OpenSSL: `openssl ts -verify -digest <sha256(root)> -in <token> -CAfile <tsa-ca.pem> -untrusted <tsa-cert.pem>`. The token's `genTime` is the latest time the events up to the head can have been written.
4. Reads the events as 0002 defines them.

The verifier needs neither the pepper nor the `parties` table. Names come from the BankID signatures in the package. A transfer's chain holds the `partyRef` of every party to the transfer, so a package shows other recipients' references, but not who they are.

Which TSA roots a verifier trusts is the verifier's choice. SIG-20's verifier ships FreeTSA's and DigiCert's roots. Tokens stay checkable after a TSA certificate expires, because `genTime` falls inside its validity. Keeping them checkable for decades, for example by timestamping old tokens again (RFC 4998), is left to production.

We do not publish batch roots. Each package carries its own tokens, and the chain of batch roots makes a withdrawn batch visible to anyone holding a later one.

## Consequences

- **Leak model (0001).**
  - Events carry only the fields 0002 lists: references, hashes, counts, flags, times. `commitment` is exception (c); the signature and OCSP hashes are exception (e); `ciphertextSha256` is a hash of ciphertext, which is not secret.
  - The TSA receives SHA-256 of a root, a hash of hashes of the above. No class M or K value reaches it.
  - DynamoDB is reached over HTTP, so the recording proxy 0001 describes for server→HTTP dependencies covers it, both DynamoDB Local and the TSAs.
- **0001's stack table.** The audit log moves from Postgres to DynamoDB, and DynamoDB Local joins the local stack. Key halves, receipts and the stored signature are not decided here. A follow-up issue decides whether they move too, so the stack keeps one store, and it updates the places 0001 names a Postgres column. Until then, 0001 stands as written for them.
- **Prerequisites.** DynamoDB Local needs Docker or Java. SIG-12 picks one and adds it to `AGENTS.md`.
- **SIG-12** builds:
  - the five tables, the single append function, the canonical form and the chain hash;
  - the anchoring job and the local `openssl ts` TSA;
  - a test that changing any stored event breaks the chain;
  - a test against DynamoDB Local that a second write to an existing `seq` is refused;
  - a unit test over the IAM policy document that it denies the actions listed above. DynamoDB Local ignores IAM, so "the database refuses updates and deletes" is checked on the policy, not by a live call. SIG-12's "Done when" must say so.
- **SIG-54** creates the tables in CDK with deletion protection and point-in-time recovery, the IAM user and policy for the app, and passes the TSA URLs to the server.
- **SIG-19 and SIG-20:** the package contents and verifier steps above, including the event hashes the browser kept. SIG-20's verifier ships the TSA roots it trusts.
- **SIG-15 and SIG-23:** API responses that append an event return its `seq` and `hash`.
- **SIG-29:** deleting a transfer's events at the end of retention runs under its own role, not the app's. Proofs are stored per transfer, so deleting one transfer's items leaves every other transfer's evidence checkable.
- **SIG-28:** the TSAs are not qualified under eIDAS. A qualified TSA is a production decision.
