# 0002: Evidence model for verified transfers

- Status: Proposed
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
- **The receipt names the file.** This is the one deliberate exception in AGENTS.md: Sigill's server and BankID see the file name when the recipient signs.
- **Language.** Swedish or English, following the recipient's language. The evidence records which wording was signed.

The issue also has a draft receipt text and a proposal for the checksums:

> Kvittens från Sigill
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
7. **Draft wording.** The draft time has no time zone, and the organisation line states something Sigill has not checked.
8. **Recipient labels.** In P2P, the labels a sender types for recipients are class M, so the audit log cannot name recipients by those labels.
9. **Size formatting.** `formatBytes` is English only, while the receipt is Swedish or English.
10. **Who confirms a download.** The confirmation comes from the recipient's browser. The server can only compare it with what it knows.
