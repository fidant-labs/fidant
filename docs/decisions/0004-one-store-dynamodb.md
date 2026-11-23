# 0004: DynamoDB is the one store

- Status: Accepted
- Date: 2026-11-23
- Linear: SIG-63

## Context

- 0003 moved the audit log and the `parties` table from Postgres to DynamoDB on demand, and added DynamoDB Local to the local stack.
- 0001 still puts the other stored data in Postgres: transfers, server key halves, receipts and the stored BankID signature. 0001's leak model names "the one Postgres column" and "that INSERT in the Postgres statement log" as allowed places for the server key half (S) and for the signature, which carries the file name. 0002 refers to the same "signature column".
- SIG-58 rules out a database on the Lightsail box, because the relay is the most exposed machine. Postgres therefore means a managed instance at about $14 a month, always on, reached through Lightsail VPC peering. DynamoDB on demand costs $0 when idle and needs no peering.
- Nothing of this is built yet, so the choice costs no migration.

## Options considered

| Option                                 | For                                                                                                                                          | Against                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything in DynamoDB                 | One store, one local service, one leak observation point. $0 idle. Conditional writes and IAM per table, as 0003 already uses for the audit. | Key-value access only: every query must follow a key. No foreign keys or `CHECK` constraints; the app enforces them. Leaving AWS (SIG-26) means a store with conditional writes.      |
| Postgres for these, DynamoDB for audit | SQL, constraints in the schema                                                                                                               | Two stores, two local services and two leak observation points. About $14 a month always on, plus VPC peering. A transfer's state and its audit events can never share a transaction. |
| Everything back in Postgres            | One store with SQL                                                                                                                           | Reverses 0003 and loses the $0 idle cost.                                                                                                                                             |

Every access path the POC needs starts from a `transferId`, a `slotId` or a `partyRef`, so key-value access is enough.

## Decision

All stored server data lives in DynamoDB on demand in eu-north-1. Locally and in tests it runs against DynamoDB Local. Postgres leaves the stack.

### Tables

These join the five tables 0003 defines.

| Table        | Key                   | Holds                                                                                                      | Writes by the app                                          |
| ------------ | --------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `transfers`  | `transferId`          | Transfer and slot state, such as status and expiry. Nothing of class C, M, K or S (0001).                  | `PutItem`, conditional `UpdateItem`                        |
| `key_halves` | `transferId`          | `serverHalf`, a binary attribute: S. Nothing else but the key and an expiry time.                          | Conditional `PutItem` (`attribute_not_exists(transferId)`) |
| `receipts`   | `transferId`,`slotId` | `signature` (the BankID `completionData.signature`), `ocspResponse`, `signedAt`. One item per signed slot. | Conditional `PutItem` (`attribute_not_exists(slotId)`)     |

- **S is in a table of its own.** The leak detector can then allow it in one attribute of one table, and IAM can limit who reads it. The app reads it with `GetItem` only when it releases the half after a signed receipt.
- **The signature is in one attribute of one table.** It carries the file name, the signer's name and personnummer, and the sender's name (0002). The audit log keeps only its hash, as 0001 exception (e) and 0003 say.
- **No updates and no deletes by the app** on `key_halves` and `receipts`. The app's IAM policy denies `UpdateItem`, `DeleteItem`, `BatchWriteItem`, `PartiQLUpdate` and `PartiQLDelete` on them, as 0003 does for the audit tables. Deleting at expiry or end of retention runs under its own role (SIG-29).
- **Constraints the schema cannot hold** (a receipt only for an existing slot, one release per signed slot) are checked by the app with conditional writes, not by a prior read.
- **Encryption at rest** uses DynamoDB's default AWS-owned key. A customer-managed KMS key is a production decision.

### Leak model: the DynamoDB equivalents of 0001's Postgres places

This record amends 0001 and 0002 the way 0003 did. They are not superseded. Read them with these replacements.

| Where 0001 or 0002 says                                                                                               | Read                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack table row "Postgres: transfers, server key halves, receipts, audit"                                             | "DynamoDB Local: transfers, server key halves, receipts, audit log, parties"                                                                       |
| S may appear in "its Postgres column (and that INSERT in the Postgres statement log)"                                 | S may appear in the `serverHalf` attribute of its `key_halves` item: in the server↔DynamoDB request and response bodies, and in the table snapshot |
| The file name may appear in "the one Postgres column that stores the signature, and that INSERT in the statement log" | The same, for the `signature` attribute of its `receipts` item                                                                                     |
| "the signature column" (0002)                                                                                         | the `signature` attribute of `receipts`                                                                                                            |
| Observation point "Postgres: `log_statement=all` … plus `pg_dumpall`"                                                 | Observation point "DynamoDB", below                                                                                                                |
| Byte needles include "Postgres bytea hex"                                                                             | No extra encoding. DynamoDB JSON carries binary attributes as base64, which the base64 needles already cover.                                      |

### Observation point: DynamoDB

- **Every request and response.** The server reaches DynamoDB Local over plain HTTP through the recording proxy that 0001 already places between the server and its HTTP dependencies. The proxy forwards each request unchanged. This sees every item written, including items later deleted, and every item read back. It replaces `log_statement=all`.
- **Snapshot.** After each test and at the end of the run, the harness scans every table and records every item. This replaces `pg_dumpall`.
- **Masking per table and attribute.** The detector parses DynamoDB JSON. It takes the table from `TableName` and the operation from the `X-Amz-Target` header, and masks a carrier value only inside the allowed attribute of the allowed table. A carrier value anywhere else fails the test, as 0001 says for Postgres.
- **Self-test.** The deliberate-leak self-test writes S through the real client into an attribute that is not allowed, and asserts that both the proxy capture and the snapshot catch it.

## Consequences

- **0001 and 0002** stand, read with the replacements above. The e2e README's table of observation points lists DynamoDB instead of Postgres.
- **SIG-12** builds the DynamoDB client setup and DynamoDB Local in the stack (Docker or Java, as 0003 says), so the issues below reuse them.
- **SIG-42** wires the DynamoDB observation point and the self-test instead of the Postgres statement log and dumps.
- **SIG-43** runs against DynamoDB Local, not Postgres.
- **SIG-54** creates `transfers`, `key_halves` and `receipts` in CDK with deletion protection and point-in-time recovery, and adds them to the app's IAM policy as above.
- **SIG-29** sets retention for `key_halves` and `receipts` and runs those deletes under its own role.
- **SIG-26** compares production hosts on a key-value store with conditional writes, not on managed Postgres.
- **Reviewer agents** in `.claude/agents/` review DynamoDB access, not SQL.
