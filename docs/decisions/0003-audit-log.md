# 0003: Audit log design

- Status: Proposed
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
