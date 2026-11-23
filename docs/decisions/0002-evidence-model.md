# 0002: Evidence model for verified transfers

- Status: Accepted
- Date: 2026-11-23
- Linear: SIG-6

## Context

### The question

Years later, the evidence of a verified transfer must show who sent which file, who received it, and when. SIG-6 settled the shape of that evidence and left three points open:

- the final wording of the receipt in Swedish and English;
- which checksums the receipt covers;
- which personal data each audit event stores.

This record decides those three points. It must not contradict 0001.

### What SIG-6 already decided

These are inputs, not decisions of this record:

- **Signed receipt before access.** Each recipient signs a receipt with BankID before they can open the file.
- **One receipt per recipient.** A transfer can have several recipients, and each signs their own receipt.
- **Repeat downloads.** The sender chooses per transfer whether recipients may download again until expiry. Every download is logged.
- **What counts as a download.** Only a download whose checksum the recipient's browser confirms against the original file. Until then the recipient can retry, even when repeat downloads are off. Every attempt is logged.
- **No sender signature in the POC.** It is planned for production. The POC records the logged-in sender.
- **The receipt names the file.** This is the one deliberate exception in AGENTS.md: Fidant's server and BankID see the file name when the recipient signs.
- **Language.** Swedish or English, following the recipient's language. The evidence records which wording was signed.

The issue also has a draft receipt text and a proposal for the checksums:

> Kvittens från Fidant
> Jag bekräftar att jag har tagit emot filen rapport-Q3.pdf (2,4 MB) från Anna Andersson.
> Skickad 23 november 2026 kl. 14.02.
> Kontrollsumma: 3f9a…c21e

- When the sender acts for an organisation, the sender line reads "från Anna Andersson för Exempel AB (556677-8899)".
- The visible text shows a shortened checksum. The full checksums go in the hidden, signed part of the BankID request.
- Proposed checksums: the checksum of the encrypted file, which the browser can check before decryption, plus the sender's declared checksum of the original file. After decrypting, the browser checks the original checksum and logs the result. A mismatch then points at the sender, not the recipient.

### What 0001 already settles

0001 is accepted. This record follows it:

- **File name.** It may appear only in the six places 0001 lists: the `receiptText` field of the sign-start request, BankID `userVisibleData`, `completionData.signature`, the one Postgres column that stores the signature, the receipt download response, and the BankID simulator's own logs. Never in the audit log, the TSA, mail, storage, signaling, URLs, headers or server output.
- **Exact size.** The exact byte size is class M. It travels only inside the encrypted META. "The receipt text names the file but not its exact size."
- **Checksum.** The receipt signs the salted commitment `C = SHA-256(salt ‖ plaintext)`, exception (c). The salt is 32 random bytes that only the sender and recipients hold, and it travels inside the encrypted META. No plain SHA-256 of the plaintext leaves the browser.
- **Evidence copies.** A verifier needs the file and the salt, so the sender's and recipient's evidence copies carry the salt. They are assembled in the browser from the decrypted META. The receipt download response never contains the salt, and its Content-Disposition filename is generic.
- **Audit log and TSA.** They hold hashes of the signed receipt text or of the BankID signature, exception (e). The signature itself lives in one Postgres column.
- **Inside the encrypted channel.** AEAD ciphertext under a key no infrastructure holds is not secret, exception (a). That covers today's plain SHA-256 in the END and RECEIPT frames.
- **Split key.** The server half is released to a recipient only after their receipt is signed.

### The code today

In `apps/web/src/lib`:

- `keys.ts`: every transfer attempt gets a fresh 16-byte random `transferId`, sent in clear in the INIT frame. The file key is `HKDF-SHA256(fragmentSecret, salt = transferId, info "sigill/v1/file")`. The code's `transferId` names one attempt, not the server-side transfer that 0001 calls a transfer ID.
- `send-file.ts`: `chunkSize = min(48 KiB, maxMessageSize − 64)`. It depends on the data channel of that connection.
- `frames.ts`:
  - META is `{name, size, type, chunkSize}`, padded to exactly 1024 bytes. It has no salt and no commitment. `parseMeta` rejects any other set of keys.
  - Names and types with control characters or direction controls are refused.
  - The sender sends META before the recipient's ACCEPT. Every frame after INIT is encrypted under the one file key.
  - END carries a plain SHA-256 of the file and the exact size. RECEIPT carries the SHA-256 the recipient computed. Both travel only inside the encrypted channel.
- `format.ts`: `formatBytes` prints sizes in English only ("2.4 MB").
- There is no split key yet. The only key is the fragment secret.

### Two transfer modes

| Mode   | Issue                | What carries the ciphertext                                                                  |
| ------ | -------------------- | -------------------------------------------------------------------------------------------- |
| P2P    | SIG-23               | The sender's browser, live, per attempt. The recipient signs, then the key half is released. |
| Hosted | Milestone 3, on hold | One stored ciphertext object in object storage                                               |

In P2P there is no single encrypted file. Each attempt has its own key and may have its own chunk size, so the same file gives different ciphertext each time.

### The BankID sign API

From the BankID Relying Party API v6.0, written from memory. Items marked unverified must be checked against the current RP guidelines before SIG-15, and the local BankID simulator must enforce the same limits.

| Fact                                                                                                                                                                                | Status     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `POST /rp/v6.0/sign` requires `endUserIp` and `userVisibleData`                                                                                                                     | Known      |
| `userVisibleData` is base64 of UTF-8 text, shown to the user                                                                                                                        | Known      |
| `userVisibleData` is at most 40,000 characters                                                                                                                                      | Unverified |
| `userNonVisibleData` is optional, base64, signed but not shown                                                                                                                      | Known      |
| `userNonVisibleData` is at most 200,000 characters                                                                                                                                  | Unverified |
| `userVisibleDataFormat: "simpleMarkdownV1"` formats the visible text; without it the text is plain                                                                                  | Known      |
| A later simple-markdown version exists                                                                                                                                              | Unverified |
| `requirement.personalNumber` restricts who may sign                                                                                                                                 | Known      |
| `collect` returns `completionData` with `user` (`personalNumber`, `name`, `givenName`, `surname`), `device` (`ipAddress`, `uhi`), `bankIdIssueDate`, `signature` and `ocspResponse` | Known      |
| `completionData.signature` is base64 XML that embeds the visible and hidden data                                                                                                    | Known      |
| The signature XML also embeds device data or the end user's IP                                                                                                                      | Unverified |
| `completionData.risk` is returned only when requested                                                                                                                               | Unverified |

If the signature XML embeds the IP, every evidence package carries it, whatever the audit log stores.

### Inconsistencies this record must settle

1. **Size.** The issue's draft shows "(2,4 MB)". 0001 forbids the exact size outside the browsers, and a rounded size would need a new exception to 0001.
2. **Where the signature lives.** The issue says the file name is "stored inside the signature in the audit log". 0001 keeps the signature in one Postgres column, and the audit log stores only its hash.
3. **"The encrypted file" in P2P.** There is no single ciphertext in P2P: the key and the chunk size change per attempt. A checksum of the encrypted file needs a definition per mode.
4. **Naming the file before signing.** The recipient signs before the server half is released. Under today's keys everything after INIT, META included, is under one file key. Once that key needs the server half, the recipient's browser cannot read the file name it must put in the receipt.
5. **The declared checksum.** The issue's "sender's declared checksum of the original file" must be the salted commitment of exception (c), not a plain hash. META carries neither the salt nor the commitment today.
6. **Plain checksums in END and RECEIPT.** They are allowed inside the encrypted channel, but the verified flow needs one value compared everywhere.
7. **Draft wording.** The draft time has no time zone, and the organisation line states something Fidant has not checked.
8. **Recipient labels.** In P2P, the labels a sender types for recipients are class M, so the audit log cannot name recipients by those labels.
9. **Size formatting.** `formatBytes` is English only, while the receipt is Swedish or English.
10. **Who confirms a download.** The confirmation comes from the recipient's browser. The server can only compare it with what it knows.

## Options considered

### Checksums the receipt signs

`C` is the salted commitment of 0001 exception (c). A ciphertext hash is a hash of the encrypted file. In P2P it covers one attempt only.

| Option                     | For                                                                      | Against                                                         |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `C` only                   | One value; already allowed by 0001                                       | Checkable only after decryption, so only after signing          |
| `C` plus a ciphertext hash | Ciphertext checked before signing; a later mismatch points at the sender | Two values; in P2P the ciphertext hash changes per attempt      |
| Ciphertext hash only       | Checkable before decryption                                              | Says nothing about the plaintext; a verifier also needs the key |

### Checksum in the visible text

| Option                    | For                                                 | Against                                                    |
| ------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| Shortened `C`             | Same value a verifier recomputes from file and salt | Shows what the sender declared; checked only after signing |
| Shortened ciphertext hash | Checked before signing                              | Changes per attempt in P2P; means nothing without the key  |
| None                      | Shorter text                                        | Visible text does not tie to a file                        |

### File size in the visible text

| Option             | For                                    | Against                                                      |
| ------------------ | -------------------------------------- | ------------------------------------------------------------ |
| Drop it            | No change to 0001                      | Less for the recipient to recognise the file by              |
| Rounded ("2,4 MB") | Helps the recipient recognise the file | Needs a new exception to 0001; `formatBytes` is English only |
| Padded size        | Not secret (0001 exception (b))        | Misleading: not the file's size                              |

### Who renders the receipt text

| Option                                                               | For                                                                              | Against                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Browser sends the full `receiptText`; server re-renders and compares | The single `receiptText` field of 0001; the browser shows exactly what is signed | Server needs the templates and a byte-exact comparison |
| Browser sends the name only; server renders                          | Server alone controls the wording                                                | The name travels in a field 0001 does not allow        |

### Reading the file name before signing

| Option                                                              | For                                                                     | Against                                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| META under the full key                                             | No change to the keys                                                   | The recipient's browser cannot name the file before signing                      |
| META under a key from the fragment half, content under the full key | The browser can render the receipt; content still needs the server half | Name, type and size readable with the link alone; key change in SIG-7 and SIG-13 |

### Identity in the audit log

| Option                                                             | For                                                                    | Against                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| Plain personnummer                                                 | Simple                                                                 | Personal data in an append-only chain that cannot be erased |
| Plain SHA-256 of the personnummer                                  | No personnummer in clear                                               | Brute-forced from about 10^7 to 10^8 possible values        |
| HMAC under a server pepper, identity in a separate deletable table | Chain holds nothing directly identifying; identity rows can be deleted | A pepper to keep secret; a second table to manage           |

### IP address and user agent

| Option                         | For                        | Against                                        |
| ------------------------------ | -------------------------- | ---------------------------------------------- |
| Store them                     | Helps investigate disputes | Personal data in a chain that cannot be erased |
| Store them truncated           | Less identifying           | Still personal data; little evidential value   |
| Keep them out of the audit log | Least personal data        | Not available for investigations               |

BankID receives `endUserIp` with every request whichever option is chosen.

### Time in the visible text

| Option                       | For                          | Against                                |
| ---------------------------- | ---------------------------- | -------------------------------------- |
| Swedish local time, no zone  | Reads naturally              | Ambiguous to later and foreign readers |
| Swedish local time, labelled | Reads naturally; unambiguous | A label in both languages              |
| UTC                          | Unambiguous                  | Unfamiliar to most recipients          |

### Organisation line in the POC

| Option                                    | For                                    | Against                                            |
| ----------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| Show it as the sender states it           | Matches the issue's draft              | The recipient signs a claim Fidant has not checked |
| Omit it until checked                     | The text states only what Fidant knows | The recipient does not see the organisation        |
| Show it labelled "uppgiven av avsändaren" | Informative and honest                 | Longer text; unchecked data in the evidence        |

## Decision

### Receipt text

The recipient signs one of these two texts. The file name, sender, time and checksum are examples.

Swedish, template `receipt-sv-1`:

```text
Kvittens från Fidant

Jag bekräftar att jag har tagit emot filen ”rapport-Q3.pdf” från Anna Andersson.
Filen skickades 23 november 2026 kl. 14.02 svensk tid.
Kontrollsumma: 3f9a…c21e
```

English, template `receipt-en-1`:

```text
Receipt from Fidant

I confirm that I have received the file "rapport-Q3.pdf" from Anna Andersson.
The file was sent on 23 November 2026 at 14:02 Swedish time.
Checksum: 3f9a…c21e
```

Rules:

- **Plain text.** The sign request omits `userVisibleDataFormat`. A file name may contain `*`, `#` or `_`, and in simple markdown those would change how the text looks. META refuses control characters today. These include LF, CR and U+0085. It also refuses the direction controls U+200E, U+200F, U+202A to U+202E and U+2066 to U+2069. It still accepts U+2028, U+2029 and U+061C, so verified transfers add rules (see Name rules).
- **Lines.** Lines end with a single LF. There is no trailing line break.
- **No size.** 0001 keeps the exact size inside the browsers, and a rounded size would need a new exception to 0001. This takes the option "Drop it". It also makes the English-only `formatBytes` irrelevant to the receipt.
- **File name in quotation marks.** Swedish uses ” on both sides (U+201D). English uses straight double quotes (U+0022). Because names cannot contain these marks (see Name rules), they show where the name starts and ends.
- **Name rules.** A file name in a verified transfer must not contain U+2028, U+2029 or U+061C, so it cannot start a new line or reorder the signed text. It must not contain ” (U+201D), “ (U+201C) or " (U+0022), so it cannot close the quotation marks. The browser refuses such a file when the sender chooses it. The server's re-render check enforces the same rules.
- **Date.** Day without a leading zero, then the month name, then the year. Swedish month names are lowercase.
- **Time.** Swedish local time (Europe/Stockholm), 24-hour clock, two-digit hour and minute: "14.02" in Swedish, "14:02" in English. The minute is truncated, not rounded. The text says "svensk tid" or "Swedish time". This takes the option "Swedish local time, labelled". The hidden data holds the exact UTC time, which also settles the repeated hour when summer time ends.
- **"Sent".** The server's time of the `transfer.created` event, in both modes. It is the moment the sender created the transfer, not when the recipient's copy arrived.
- **Sender.** The name of the logged-in sender, as BankID returned it when they logged in. There is no sender signature in the POC.
- **No organisation line.** The POC omits it until SIG-36 adds the sender signature or Fidant can check the organisation. This takes the option "Omit it until checked": the recipient signs only what Fidant knows.
- **Visible checksum.** The first 4 and the last 4 lowercase hex characters of `C`, joined by … (U+2026). This takes the option "Shortened `C`": it is the same value a verifier recomputes from the file and the salt.
- **Template IDs.** `receipt-sv-1` and `receipt-en-1`. Any change to the wording, the date or time format, or the rules above gets a new ID. Old templates stay, so old receipts can still be checked.

### Hidden signed data

The sign request carries `userNonVisibleData`: base64 of canonical JSON (UTF-8, keys sorted, no whitespace). BankID signs it but does not show it. Shown here with line breaks for reading:

```json
{
  "ciphertext": {
    "attempt": "<attempt ID>",
    "scope": "p2p-attempt",
    "sha256": "<hex>"
  },
  "file": {
    "alg": "sha256-salted-32",
    "commitment": "<base64url of C>"
  },
  "lang": "sv",
  "recipient": "<slot ID>",
  "sender": { "name": "Anna Andersson" },
  "sentAt": "2026-11-23T13:02:41Z",
  "template": "receipt-sv-1",
  "transfer": "<transfer ID>",
  "type": "fidant-receipt",
  "v": 1
}
```

Fields:

- `v`, `type`: format version and kind, so a verifier knows how to read the rest.
- `template`, `lang`: which visible template the recipient signed, and in which language.
- `transfer`: the server-side transfer ID, the one 0001 calls a transfer ID. It is not the code's per-attempt `transferId`.
- `recipient`: the recipient slot ID within the transfer. Never the label the sender typed, which is class M.
- `sentAt`: the server's UTC time of `transfer.created`, to the second. The visible time is derived from it.
- `sender.name`: the same name as in the visible text.
- `file.commitment`: the full `C = SHA-256(salt ‖ plaintext)`, exception (c) of 0001. `alg` names that construction with a 32-byte salt.
- `ciphertext.sha256`: the ciphertext hash checked before signing (see Checksums).
- `ciphertext.scope`: `p2p-attempt` or `hosted-object`, the mode the hash was taken in.
- `ciphertext.attempt`: in P2P, the ID of the attempt the hash covers. Today's code calls this `transferId`; it is the only place the per-attempt ID appears in the receipt. Hosted mode omits `attempt`, because one stored object serves every download.

The hidden data never contains the file name, the salt, the exact size or the MIME type. The name is already in the visible text, and a second copy would add a carrier outside 0001's six places. The salt, size and type are K and M, allowed nowhere outside the browsers.

### Checksums

This takes the option "`C` plus a ciphertext hash".

- **`C` is the lasting binding.** The sender's browser computes `C` when the file is chosen, with a fresh 32-byte salt, and puts the salt and `C` in META. After decrypting, the recipient's browser recomputes `C` and reports the value it got. The server compares it with the registered `C`, the same value the receipt signs.
- **The sender registers `C`.** The sender's browser sends `C` to the server when it creates a verified transfer. `C` is not secret, exception (c). The server stores it in the `transfer.created` event and refuses a sign-start whose `C` differs. So the server holds the sender's own reference for the blame rule below, independent of anything the recipient reports.
- **The ciphertext hash is the check before signing.** Its definition depends on the mode:
  - Hosted: SHA-256 of the one stored ciphertext object. The server can check it too.
  - P2P: SHA-256 of the CHUNK frames as received in that attempt, in order. The sender declares it in a frame the recipient can read with the fragment half (see Key layering). It covers one attempt only. Retries after signing are bound by `C` alone.
- **Sign only after the ciphertext is on the device**, in both modes. The recipient's browser checks the ciphertext hash first, so "har tagit emot" is true when they sign. This follows SIG-23's order.
- **Who is to blame.**
  - The ciphertext hash does not match: transport or storage failed. The recipient retries and does not sign.
  - The ciphertext hash matches but `C` does not: the sender's file or declaration is at fault, not the recipient.
- **END and RECEIPT.** Unverified transfers may keep today's plain SHA-256 in those frames, inside the encrypted channel (exception (a)). Verified transfers compare `C` there instead, so one value is compared everywhere.

This stays within 0001. The ciphertext hash is computed from ciphertext, which is not secret, so it is not a leak. No plain hash of the plaintext leaves the browser.

### Key layering

This takes the option "META under a key from the fragment half, content under the full key". SIG-7, SIG-13, SIG-15 and SIG-23 implement it.

- META (name, type, exact size, salt and `C`) and the frame declaring the P2P ciphertext hash are encrypted under a key derived from the fragment half alone.
- CHUNK frames, the file content, are encrypted under the full key, which needs the server half.
- So the recipient's browser can read the name and render the receipt before signing, but cannot decrypt the content until the server releases its half.

The trade-off: anyone holding the link can read the file name, type and size without signing. This is accepted because the link is already the capability to receive, the content still needs the signature, and the recipient must see what they sign. The fragment half never reaches infrastructure, so META stays AEAD ciphertext under a key no infrastructure holds, exception (a).

### Rendering and checking

This takes the option "Browser sends the full `receiptText`; server re-renders and compares".

- The templates live in a workspace package shared by the server and the web client.
- The recipient picks the language on the pickup page. It defaults to the browser's language.
- The recipient's browser renders the text from the template and META, shows it, and sends it as `receiptText` in the sign-start request, the one field 0001 allows. The request also carries the language, `C`, and the ciphertext hash with its attempt ID.
- The server re-renders the text from what it knows: the template for that language, the sender's name, `sentAt` and the short form of `C`. It takes the file name from the template's one variable slot in the received text and applies META's name rules to it.
- The server rejects any `receiptText` that is not byte for byte identical to its own rendering. It builds the hidden data itself, so the visible checksum and the hidden `C` always agree.
- The evidence records the choice as `lang` and `template`, in the hidden data and in the audit event.

### What counts as a download

- A download counts once the recipient's browser reports a `C` that matches and the server's comparison with the registered `C`, which the receipt also signs, agrees.
- Until then the recipient may retry without limit, even when repeat downloads are off. Every attempt is logged.
- The confirmation is reported by the recipient's browser. The server cannot see the plaintext, so it can back the report only by comparing the reported `C` with the registered one. A modified browser could report a match it never computed.
- In P2P, every download needs the sender's browser online. If the sender allows repeat downloads, they are available only while the sender's browser stays online until expiry. The send page must say so.

### Personal data per audit event

The principle:

- The audit chain holds pseudonymous references and hashes, nothing directly identifying.
- Names and personnummer live in a separate `parties` table, outside the chain. Its rows can be deleted.
- An evidence package carries identity through the BankID signature, which names the signer.

Rules:

- **Party reference.** `partyRef = HMAC-SHA256(serverPepper, personnummer)`. The pepper is a server secret, kept outside the database. A plain SHA-256 would not do: there are only about 10^7 to 10^8 personnummer, so it is easily brute-forced. This takes the option "HMAC under a server pepper, identity in a separate deletable table".
- **`parties` table.** One row per `partyRef`: name and personnummer. A row is created when a sender names a recipient by personnummer, or at the party's first BankID login, whichever comes first. The name is filled in at that first login. Naming a recipient puts the personnummer here, so the sign request can set `requirement.personalNumber`.
- **No IP address and no user agent** in the audit log. This takes the option "Keep them out of the audit log". BankID still receives `endUserIp` with every request, as its API requires. If the BankID signature XML embeds the IP (unverified, see Context), every evidence package carries it regardless.
- **Time.** Every event has the server's UTC time. The TSA anchors the chain in batches, as SIG-9 decides.

Every event also has `eventId`, `transferId`, `at` and its chain hash. The other fields:

| Event                                                    | Fields                                                                                                                                                    | Personal data and why                                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `transfer.created`                                       | `mode` (`p2p` or `hosted`), `senderRef`, `recipientSlots` (a count), `repeatDownloads`, `expiresAt`, `commitment` (`C`), `ciphertextSha256` (hosted only) | `senderRef` only. Name and personnummer are in `parties`, needed to show who sent. P2P recipient labels are class M and never sent. |
| `recipient.slot.added`                                   | `slotId`, `expectedRecipientRef` (if the sender named one)                                                                                                | A reference only                                                                                                                    |
| `party.authenticated`                                    | `slotId` or `sender`, `partyRef`, hash of the BankID `orderRef`                                                                                           | A reference only. The name goes to `parties` once, at the first login.                                                              |
| `ciphertext.checked`                                     | `slotId`, `attemptId`, `result`                                                                                                                           | None                                                                                                                                |
| `receipt.signed`                                         | `slotId`, `partyRef`, `lang`, `template`, SHA-256 of `signature`, of `userNonVisibleData` and of `ocspResponse`                                           | A reference only. The signature lives in its one Postgres column (0001); the chain stores its hash only, exception (e).             |
| `keyhalf.released`                                       | `slotId`                                                                                                                                                  | None                                                                                                                                |
| `download.attempted`                                     | `slotId`, `attemptId`                                                                                                                                     | None. Every attempt is logged.                                                                                                      |
| `download.confirmed`, `download.failed`                  | `slotId`, `attemptId`, `result` (`match`, `mismatch` or `decrypt-failed`)                                                                                 | None                                                                                                                                |
| `transfer.expired`, `transfer.revoked`, `object.deleted` | `reason`                                                                                                                                                  | None                                                                                                                                |
| `sender.signed` (SIG-36, production)                     | SHA-256 of `signature`                                                                                                                                    | As `receipt.signed`                                                                                                                 |

The POC stores no organisation number. The organisation line is omitted (see Receipt text).

Why this much and no more:

- **Data minimisation.** GDPR Art. 5(1)(c) allows only the personal data needed for the purpose. The purpose is to show who sent, who received, and when. A reference that resolves through `parties` does that.
- **Personnummer.** Dataskyddslagen (2018:218) 3 kap. 10 § allows personnummer only where clearly justified, for example for secure identification. BankID identification is that case. The personnummer is stored once, in `parties`, and nowhere else.
- **Erasure.** An append-only chain cannot honour erasure or end of retention. So it holds nothing directly identifying. Deleting a `parties` row leaves only references. Anyone with the pepper can still resolve a reference by trying every personnummer, so the references stay personal data (pseudonymous, not anonymous) until the pepper is destroyed. SIG-29 decides when that happens.
- **Transparency.** This table feeds SIG-31, the public page that lists every piece of data Fidant stores.

## Consequences

- **SIG-7 and SIG-13**:
  - META gains the salt and `C`. That takes about 100 of META's 1024 bytes, so the file-name budget shrinks. `metaFits` must reserve the room, and `parseMeta` accepts the new key set.
  - META and the frame declaring the P2P ciphertext hash move under a key from the fragment half. CHUNK frames stay under the full key.
  - A new frame, or a new END field, carries the ciphertext hash.
  - `parseMeta` and `metaFits` also enforce the Name rules for verified transfers.
- **SIG-15**:
  - The receipt templates, the browser rendering and the server's re-render check.
  - Signing only after the ciphertext check; refusing a sign-start whose `C` differs from the registered one.
  - `requirement.personalNumber` when the sender named the recipient.
  - Check the current BankID RP guidelines first, especially the facts marked unverified in Context.
- **SIG-34**: the BankID simulator enforces the same limits as the real API, including the lengths of `userVisibleData` and `userNonVisibleData`.
- **SIG-9**: the event types and fields above; the `parties` table outside the chain; the pepper.
- **SIG-19 and SIG-20**:
  - The evidence package is assembled in the browser. It holds the signature, `ocspResponse`, the TSA tokens, the salt and the template text for the version signed.
  - A verifier recomputes `C` from the file and the salt, checks the hidden data, and checks the visible text against the template.
- **SIG-23**:
  - The create-transfer request carries `C`.
  - The recipient signs after the ciphertext is on the device, and the key half is released after signing.
  - The send page says that repeat downloads need the sender's browser online.
- **SIG-29**: retention, deleting `parties` rows, and the pepper's lifecycle.
- **SIG-31**: publish the per-event table.
- **SIG-36**: the sender signature and the organisation line.
- **SIG-28**: this model is not qualified electronic registered delivery under eIDAS.

The inconsistencies in Context:

1. **Size**: dropped from the receipt (Receipt text).
2. **Where the signature lives**: 0001's wording; the audit log stores its hash (Personal data per audit event).
3. **"The encrypted file" in P2P**: the ciphertext hash is defined per mode (Checksums).
4. **Naming the file before signing**: META moves under a key from the fragment half (Key layering; SIG-7, SIG-13).
5. **The declared checksum**: it is `C`, carried in META and registered with the server (Checksums; SIG-7, SIG-13, SIG-23).
6. **Plain checksums in END and RECEIPT**: kept for unverified transfers; verified transfers compare `C` (Checksums).
7. **Draft wording**: time labelled "svensk tid", organisation line omitted (Receipt text; SIG-36).
8. **Recipient labels**: never sent; recipients are identified by slot ID and, after BankID, by `partyRef` (Personal data per audit event).
9. **Size formatting**: moot, since the size is dropped (Receipt text).
10. **Who confirms a download**: browser-reported and backed only by comparison with the registered `C` (What counts as a download).
