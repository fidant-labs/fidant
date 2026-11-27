# Split-key spike findings (SIG-7)

- Date: 2026-11-23
- Linear: SIG-7
- Code and how to run it: `README.md` in this directory
- Raw results: `results/2026-11-23-{chromium,firefox,webkit}.json`

These findings recommend. They change no decision record. Where a recommendation would touch 0001 or 0002, the section says so, and Follow-ups lists the issue that would carry it out.

## How it was measured

One laptop: MacBook Pro, Apple M2 Pro (12 cores), 32 GB memory, internal SSD, macOS 26.6. Playwright's headless builds of Chromium 159, Firefox 159 (a Nightly build) and WebKit 27.2, driven by `src/runner/run.ts` over `http://127.0.0.1`. These are not Chrome, Firefox release or Safari, and no phone was tested; those rows are pending (see Pending human runs).

- Each pipeline run pushes seeded data through the format in `src/` (HKDF split key, Padmé padding, chunked AES-GCM, META and SEALED frames, salted commitment `C`) in one dedicated worker: hash pass, encrypt pass into a staged OPFS file, release of `S`, decrypt pass from OPFS into the sink, delete the staged file. Sender and recipient share the worker, so a run's wall time is both sides together.
- The runner checked every download against Node regenerating the same seeded stream, size and SHA-256. "ok" means both matched.
- MB/s is 10^6 bytes per second. Every phase includes one SHA-256 pass: the hash phase computes `C`, the encrypt phase hashes the ciphertext (hosted mode's checksum), the decrypt phase recomputes `C`. The hash and encrypt phases each also generate the seeded data: the encrypt phase opens the source a second time inside its timer.
- The decrypt phase ends when the sink is closed. For `sw` that includes delivering the file, paced by the download. For `opfs`, `fsa-opfs` and `blob` the file is downloaded after the phase, so its decrypt figure excludes delivery and the copy counts only in the wall time. Real `fsa` has no measured rows.
- One run per cell, so the tables show no variance. Differences of a few MB/s mean nothing.
- RSS is the summed resident memory of the browser's processes, sampled every 250 ms, from just before the run to the end of its download. Summed RSS counts shared pages once per process, so compare a run's peak with its own start, not across engines. Every 1 GiB and 5 GiB run at 256 KiB or 48 KiB had a browser of its own. The 64 MiB runs and the 1 MiB-chunk runs shared one browser per invocation, so their starting RSS carries earlier runs' memory and is not comparable with the others. In each 1 MiB-chunk invocation, the first run (`opfs`) started from a fresh browser; only `fsa-opfs`, `blob` and `sw` inherited memory.
- Chunk size is 256 KiB unless stated.
- The 1 GiB Chromium `opfs` row at 256 KiB is slower than every other Chromium run (79 and 95 MB/s against about 120 and 150). It is unexplained: it had a fresh browser like every other 1 GiB and 5 GiB run, and the other runs that came first in their invocation were normal. Treat it as an outlier.
- WebKit runs fail with "`<html>` intercepts pointer events" while the Mac's display sleeps; the WebKit rows were rerun with the display awake (`caffeinate -dimsu`).

## Answers to the issue's questions

### Can a browser encrypt and decrypt 1 GB and 5 GB without running out of memory?

Yes in Chromium and WebKit at both sizes. With a sink that writes to disk (`opfs`, `fsa-opfs`, `sw`), peak growth was bounded at about 270 MiB across 1 and 5 GiB (79 to 271 MiB); five times the file did not mean five times the memory. Encryption and decryption hold a few chunks at a time, so they do not grow with the file.

Firefox handles 1 GiB in `opfs` and `fsa-opfs` with 66 and 132 MiB of growth. At 5 GiB both disk sinks failed on quota (see Disk), and the two sinks that succeeded held the file in memory: `sw` grew by 5.3 GiB and `blob` by 10.3 GiB. So in this Firefox build, 5 GiB worked only on a machine with that much memory to spare. Firefox release is pending.

The `blob` sink grows with the file in every engine, least in Chromium, which appears to page large Blobs to disk: +1.1 GiB at 1 GiB and +2.2 GiB at 5 GiB in Chromium, +1.1 and +5.1 GiB in WebKit, +2.4 and +10.3 GiB in Firefox. It should not be used for large files.

### How does the decrypted file reach the disk in each browser?

All four automatable sinks worked at 1 GiB in all three engines, and the downloads matched byte for byte.

- **Chromium:** a `FileSystemWritableFileStream`. With a real save picker (`fsa`) it writes straight to the file the user picked; the runner can only test the same stream on an OPFS file (`fsa-opfs`), which works at 5 GiB. The real picker is pending.
- **Everywhere:** decrypt into an OPFS file through a sync access handle, then download that disk-backed `File` through a `blob:` URL (`opfs`). Memory grew by at most 179 MiB; it needs twice the file size in OPFS quota during decryption, which Firefox's 10 GiB quota did not allow at 5 GiB.
- **Everywhere, on a secure context:** a service worker that answers a synthetic download URL with the decrypted stream (`sw`). Transferable streams worked in all three engines. Growth of 130 to 271 MiB in Chromium and WebKit; in Firefox memory grew with the file (+1.8 GiB at 1 GiB, +5.3 GiB at 5 GiB). Why is not established; Firefox may buffer the service worker's response body before the download writes it.

### How fast, on a laptop and on a phone?

On the laptop, about 120 to 150 MB/s per phase in Chromium and WebKit and about 40 MB/s in Firefox, at every size from 64 MiB to 5 GiB. The sides are not equal: the sender runs the hash and encrypt phases, the recipient the decrypt phase, about two thirds and one third of the time. At 5 GiB:

| Engine   | Sender (hash + encrypt) | Recipient (decrypt) |
| -------- | ----------------------: | ------------------: |
| Chromium |              about 83 s |          34 to 41 s |
| WebKit   |              about 78 s |          37 to 44 s |
| Firefox  |             about 255 s |        125 to 127 s |

These are approximate figures from the bench, not a transfer's time. The sender column includes the bench's seeded data generation (about 7 s per 5 GiB phase in Chromium, at the generator's 752 MB/s), which a real sender reading a file does not pay. The recipient's ciphertext-hash pass and the network are not modelled, and for `opfs`, `fsa-opfs` and `blob` the download comes after the decrypt phase.

AES-GCM is not the limit: it ran at 1 to 4.8 GB/s alone. The JavaScript SHA-256 is (171 MB/s in Chromium, 153 in WebKit, 44 in Firefox), and every phase makes one SHA-256 pass. See Recommendations, SHA-256.

Phones are pending.

### How does the link half reach the recipient without passing through Fidant?

Fidant sends only a notice. The full link, with `F` in the fragment, goes from the sender's own device through a channel the sender picks: `navigator.share`, a `mailto:` link or Copy. The receive page reads `F` and removes the fragment from the address bar. This holds for both recipient modes. See Link-half delivery. Whether real mail and messaging channels deliver the fragment intact is pending.

## Measurements

### Microbenchmarks

256 MiB through each stage alone, in the bench worker. AES-GCM includes framing and the AAD. SHA-256 is the app's JavaScript implementation, `apps/web/src/lib/sha256.ts`.

| Stage, MB/s              | Chromium | Firefox | WebKit |
| ------------------------ | -------: | ------: | -----: |
| seeded generator         |      752 |    2037 |   2892 |
| SHA-256 (JavaScript)     |      171 |      44 |    153 |
| AES-GCM encrypt, 48 KiB  |     2096 |    1423 |   1013 |
| AES-GCM decrypt, 48 KiB  |     2889 |    1522 |   1918 |
| AES-GCM encrypt, 256 KiB |     2738 |    2568 |   1859 |
| AES-GCM decrypt, 256 KiB |     3932 |    3048 |   4017 |
| AES-GCM encrypt, 1 MiB   |     2013 |    2034 |   1909 |
| AES-GCM decrypt, 1 MiB   |     2510 |    2330 |   4075 |
| AES-GCM encrypt, 4 MiB   |     1982 |    2020 |   1778 |
| AES-GCM decrypt, 4 MiB   |     2548 |    2298 |   4831 |

### Pipeline

256 KiB chunks. MB/s per phase; RSS in MiB from the start of the run to its peak.

#### 64 MiB

These runs shared one browser per engine, after the microbenchmarks, so the RSS columns are not comparable with the larger sizes.

| Engine   | Sink     | Outcome | Hash | Encrypt | Decrypt | Wall s | RSS MiB     |
| -------- | -------- | ------- | ---: | ------: | ------: | -----: | ----------- |
| Chromium | opfs     | ok      |  135 |     110 |     129 |    2.0 | 818 → 859   |
| Chromium | fsa-opfs | ok      |  138 |     121 |     115 |    1.9 | 759 → 761   |
| Chromium | blob     | ok      |  138 |     121 |     157 |    1.7 | 719 → 802   |
| Chromium | sw       | ok      |  137 |     120 |     148 |    1.9 | 937 → 945   |
| Firefox  | opfs     | ok      |   40 |      38 |      34 |    5.8 | 1495 → 1507 |
| Firefox  | fsa-opfs | ok      |   42 |      41 |      41 |    5.1 | 1394 → 1409 |
| Firefox  | blob     | ok      |   40 |      39 |      41 |    5.4 | 1353 → 1535 |
| Firefox  | sw       | ok      |   41 |      39 |      40 |    5.4 | 1589 → 1801 |
| WebKit   | opfs     | ok      |  145 |     124 |     139 |    1.7 | 581 → 589   |
| WebKit   | fsa-opfs | ok      |  146 |     125 |      91 |    3.1 | 592 → 597   |
| WebKit   | blob     | ok      |  147 |     116 |     143 |    1.9 | 600 → 705   |
| WebKit   | sw       | ok      |  146 |     127 |     134 |    1.9 | 736 → 741   |

#### 1 GiB

| Engine   | Sink     | Outcome | Hash | Encrypt | Decrypt | Wall s | RSS MiB     |
| -------- | -------- | ------- | ---: | ------: | ------: | -----: | ----------- |
| Chromium | opfs     | ok      |  136 |      79 |      95 |   37.9 | 394 → 526   |
| Chromium | fsa-opfs | ok      |  132 |     124 |     125 |   27.4 | 395 → 474   |
| Chromium | blob     | ok      |  132 |     118 |     142 |   26.9 | 393 → 1502  |
| Chromium | sw       | ok      |  131 |     119 |     150 |   25.9 | 393 → 646   |
| Firefox  | opfs     | ok      |   38 |      38 |      41 |   85.0 | 1269 → 1334 |
| Firefox  | fsa-opfs | ok      |   42 |      41 |      42 |   80.3 | 1267 → 1399 |
| Firefox  | blob     | ok      |   42 |      39 |      42 |   81.0 | 1267 → 3690 |
| Firefox  | sw       | ok      |   42 |      39 |      41 |   80.7 | 1270 → 3114 |
| WebKit   | opfs     | ok      |  145 |     129 |     138 |   25.2 | 467 → 551   |
| WebKit   | fsa-opfs | ok      |  143 |     128 |     130 |   25.8 | 469 → 552   |
| WebKit   | blob     | ok      |  144 |     128 |     144 |   24.9 | 467 → 1632  |
| WebKit   | sw       | ok      |  144 |     130 |     139 |   24.9 | 467 → 597   |

#### 5 GiB

| Engine   | Sink     | Outcome                                                | Hash | Encrypt | Decrypt | Wall s | RSS MiB      |
| -------- | -------- | ------------------------------------------------------ | ---: | ------: | ------: | -----: | ------------ |
| Chromium | opfs     | ok                                                     |  136 |     123 |     150 |  128.6 | 393 → 572    |
| Chromium | fsa-opfs | ok                                                     |  138 |     124 |     131 |  133.3 | 394 → 509    |
| Chromium | blob     | ok                                                     |  134 |     123 |     156 |  128.3 | 394 → 2640   |
| Chromium | sw       | ok                                                     |  136 |     124 |     149 |  125.7 | 394 → 665    |
| Firefox  | opfs     | error in decrypt: "OPFS write made no progress"        |   43 |      41 |       – |  385.5 | 1267 → 1397  |
| Firefox  | fsa-opfs | error in decrypt: `QuotaExceededError: Quota exceeded` |   43 |      41 |       – |  386.0 | 1267 → 1403  |
| Firefox  | blob     | ok                                                     |   43 |      41 |      43 |  394.6 | 1268 → 11831 |
| Firefox  | sw       | ok                                                     |   43 |      41 |      42 |  388.0 | 1268 → 6692  |
| WebKit   | opfs     | ok                                                     |  147 |     131 |     145 |  123.2 | 468 → 556    |
| WebKit   | fsa-opfs | ok                                                     |  146 |     130 |     123 |  133.1 | 468 → 550    |
| WebKit   | blob     | ok                                                     |  146 |     131 |     146 |  122.8 | 466 → 5706   |
| WebKit   | sw       | ok                                                     |  146 |     130 |     136 |  123.7 | 467 → 621    |

"OPFS write made no progress" is the spike's error when a sync access handle's `write()` returns 0, which is how Firefox's sync access handle reported the full quota.

#### Chunk size

1 GiB, `opfs` sink, encrypt / decrypt MB/s. The 1 MiB runs of the other sinks are in the results files and match the 256 KiB rows.

| Engine   |    48 KiB |           256 KiB |     1 MiB |
| -------- | --------: | ----------------: | --------: |
| Chromium | 120 / 148 | 79 / 95 (outlier) | 125 / 156 |
| Firefox  |   39 / 40 |           38 / 41 |   41 / 43 |
| WebKit   | 121 / 140 |         129 / 138 | 131 / 147 |

In the pipeline, chunk size made no measurable difference between 48 KiB and 1 MiB. That holds only while the JavaScript SHA-256 sets the pace, and rests on one run per cell. Alone, AES-GCM at 48 KiB ran 1.3 to 1.4 times slower than at 256 KiB in Chromium and 1.8 to 2.1 times slower in Firefox and WebKit (Microbenchmarks), and 48 KiB is the first size in the microbenchmark loop, with no warm-up, so part of that gap may be warm-up. After any change to SHA-256, measure 48 KiB against 256 KiB again.

### Browser × sink support

Playwright builds on macOS, 256 KiB chunks. "ok" means the download matched; memory is RSS growth over the run.

| Sink                                | Chromium 1 GB | Chromium 5 GB | Firefox 1 GB        | Firefox 5 GB        | WebKit 1 GB   | WebKit 5 GB   |
| ----------------------------------- | ------------- | ------------- | ------------------- | ------------------- | ------------- | ------------- |
| `fsa`: save picker                  | pending       | pending       | not available       | not available       | not available | not available |
| `fsa-opfs`: writable stream on OPFS | ok            | ok            | ok                  | fails: quota        | ok            | ok            |
| `opfs`: OPFS, then `blob:` download | ok            | ok            | ok                  | fails: quota        | ok            | ok            |
| `sw`: service worker stream         | ok            | ok            | ok, +1.8 GiB memory | ok, +5.3 GiB memory | ok            | ok            |
| `blob`: in-memory Blob              | ok, +1.1 GiB  | ok, +2.2 GiB  | ok, +2.4 GiB        | ok, +10.3 GiB       | ok, +1.1 GiB  | ok, +5.1 GiB  |

Real Safari, Firefox release, Chrome with the real picker, iPhone and Android are pending.

### Peak memory

RSS growth over each run, MiB, 256 KiB chunks.

| Sink     | Chromium 1 GiB | Chromium 5 GiB | Firefox 1 GiB | Firefox 5 GiB | WebKit 1 GiB | WebKit 5 GiB |
| -------- | -------------: | -------------: | ------------: | ------------: | -----------: | -----------: |
| opfs     |            132 |            179 |            66 |  130 (failed) |           83 |           89 |
| fsa-opfs |             79 |            116 |           132 |  136 (failed) |           84 |           82 |
| blob     |           1109 |           2247 |          2423 |         10562 |         1165 |         5240 |
| sw       |            252 |            271 |          1845 |          5424 |          130 |          153 |

Browser RSS just after the page loaded: Chromium 393 MiB, Firefox 1267 MiB, WebKit 464 MiB. Highest seen: Chromium 2640 MiB, Firefox 11831 MiB and WebKit 5706 MiB, all in the 5 GiB `blob` runs. The microbenchmarks (256 MiB per stage) peaked at 876, 1541 and 580 MiB.

### Disk

- **Two copies.** The disk sinks need about twice the padded size free. During decryption the staged ciphertext and the output exist together: both in OPFS for `opfs` and `fsa-opfs` (5 GiB runs peaked at 10 GiB of origin storage usage, from `navigator.storage.estimate()`, which counts the whole origin, not OPFS alone), or the ciphertext in OPFS and the output in Downloads for `sw` and `fsa`. After the staged ciphertext is deleted, the `opfs` sink's download copies the OPFS file into Downloads, again two copies.
- **Quota.** Firefox reported a fixed 10 GiB quota and refused the second 5 GiB copy. Chromium reported usage plus 10 GiB and WebKit about 19 GiB; both passed. Real browsers size quota from the disk, and Firefox raises it for a site that is granted `navigator.storage.persist()` (from Firefox's documentation, not tested here).
- **WebKit's estimate is unreliable.** After `FileSystemWritableFileStream` writes on OPFS, WebKit's `storage.estimate()` reported usage far above the data written (48 GB after a 5 GiB `fsa-opfs` run, more than its 19 GiB quota) while writes kept succeeding, and its usage did not drop when files were deleted. A pre-flight "does it fit" check cannot rely on `estimate()` in WebKit.

## Link-half delivery

### The two recipient modes

- **Personnummer-locked.** The sender names the recipient by personnummer. The sign request sets `requirement.personalNumber`, so only that person can sign and receive `S`. Someone else holding the link can read META (file name, `C`, the sender's typed name) with `F`, but cannot sign and never gets `S`.
- **Personal link, first identity binds.** The sender names no personnummer. The first person to log in with BankID through the link binds it, signs and receives `S`. Until then the link is the capability: whoever opens it first with a BankID gets the file, and the receipt names them.

In both modes the recipient needs `F` (in the link) and `S` (from Fidant, after signing).

### Why no Fidant path may carry `F`

Fidant holds `S`. If any path Fidant operates also carries `F` (its notice mail, an SMS it sends, a redirect, a page that shows the link, a log line), Fidant holds both halves and could decrypt every transfer whose ciphertext it stores or relays. The split key exists to prevent exactly that, and AGENTS.md's invariant that keys live only in the fragment or in browser memory forbids it. This holds in both modes: the personnummer lock limits who can sign, not what Fidant can decrypt. It covers Fidant's mail provider and every other processor Fidant uses for notices.

This rests on one trust assumption that no delivery channel removes: Fidant serves the receive page's JavaScript, and that code reads `location.hash`. A changed bundle could send `F` to Fidant, which then holds both halves. What limits it: a strict `connect-src` so the page can reach only the origins it needs, reviewed builds, and later a signed or installable client. SIG-35 (prove the web app we serve is the published code) covers this; 0001 lists a malicious served web app as out of its leak model.

### Options

| Option                                                                                  | Who sees `F`                                                 | Cost                                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Fidant mails the full link                                                              | Fidant, its mail provider, the recipient's mail provider     | Fidant holds both halves. Ruled out.                                                      |
| Fidant mails a notice; the sender's device sends the full link (share, `mailto:`, Copy) | The sender's and the recipient's mail or messaging providers | Two messages, and the sender must send one.                                               |
| `F` wrapped to a public key the recipient's browser registered earlier                  | Only the recipient's device                                  | Needs a recipient with a key already in a browser, and key-loss handling. Later, if ever. |
| `F` derived from a password the sender tells the recipient                              | Whoever hears it; offline guessing against META              | Weak keys. Ruled out.                                                                     |

### Recommendation

1. Fidant sends only a notice: a verified sender has a file waiting. It links to the pickup page without a fragment and without key material, and says the sender sends the link separately. This is SIG-14's likely shape.
2. The sender's browser hands the full link to the sender's own channel: `navigator.share` where it exists, a `mailto:` link and Copy. The send page never puts the full link in anything it sends to the server.
3. The receive page reads `F` once, keeps it in memory, and removes the fragment with `history.replaceState`, as the handoff page does. Browsers never send the fragment in requests or in `Referer`. A channel that moves the fragment into the query (the handoff page detects this) would send `F` to Fidant's server in the request line. Such channels are unsupported. No layer in front of the pickup route (proxy, CDN, load balancer) logs its query string. The route itself never logs query strings, and it refuses a request with a `k=` query (matched after percent-decoding, as the handoff detector does), or strips it with a redirect that does not log it.
4. Prefer the personnummer-locked mode when the sender knows the personnummer.

What remains:

- The sender's and the recipient's mail or messaging providers see `F`, and so does any link scanner on the way (Outlook Safe Links and similar). They do not see `S`, which Fidant releases only to a recipient who signed, so a provider alone cannot decrypt. A provider and Fidant together could.
- In the first-identity-binds mode, anyone who reads the link before the recipient (a compromised mailbox, a forwarded message) can bind it with their own BankID and get the file; the receipt then names them. A link scanner fetches the page but cannot complete BankID, so it cannot bind. That scanners never complete BankID is an assumption.
- Anyone holding the link can read the file name, the sender's typed name and `C` without signing, as 0002 accepts. With write access to the stored or relayed ciphertext, they can also rewrite them; see Format.
- Browser history sync may store the full URL, fragment included, before the page removes it. Not tested; a guess.
- Whether each channel delivers the fragment intact is pending.

## Recommendations

### Format

Keep the format as built, with the two-key layering of 0002, plus one change: SEALED authenticates META.

- `metaKey = HKDF-SHA256(F, salt = streamId, info "sigill/v2/meta")` and `contentKey = HKDF-SHA256(F ‖ S, salt = streamId, info "sigill/v2/content")`. HKDF, never `F ‖ S` as the key. The spike's `transferId` is a fresh 16-byte random value per stream (`createTransferId()`), the per-attempt ID of 0002, not 0004's server-side `transferId`. Keep it that way, and name it apart (here `streamId`): IVs are counters from kind and seq, so a key must never encrypt two different streams, and a server ID is shared by every P2P attempt and every slot of one transfer. A fresh ID per stream makes fresh keys per stream even when `F` and `S` repeat. In hosted mode one stored stream serves every download, so it has one ID. This is a decision for SIG-13's record.
- A 29-byte stream header (version, `streamId`, chunkSize, paddedLength) in every frame's AAD, next to the 10-byte frame header, so no frame moves between transfers, chunk sizes or padded lengths.
- META (1024 bytes, `metaKey`) and SEALED (512 bytes, `contentKey`) at seq 0 with their own kinds; IV = kind ‖ 00 00 00 ‖ seq.
- A final-chunk kind instead of an END frame. The reader knows the chunk count from `paddedLength`, and the kind is in the AAD, so truncation, extension and reordering all fail (tested in `stream.test.ts`), with one frame fewer. A verified transfer then needs no END: `C` is checked after the last chunk with the salt from SEALED. This departs from accepted 0002, whose Checksums section says verified transfers compare `C` in END; SIG-13's record amends it (see Follow-ups).
- **SEALED carries SHA-256 of the META frame**, checked right after `openSealed`. As built, `metaKey` derives from `F` alone, and nothing under `contentKey` covers META (`container.ts`). So anyone holding `F` (a mail provider, a link scanner, a reader of a forwarded link) who can also write the stored or relayed ciphertext can re-seal META with another name or `from` and keep `C`. The false name passes every check, and the recipient signs it in the BankID receipt text. With the hash in SEALED, the recipient's browser detects the change as soon as `S` is released, before any content is written. A META-hash mismatch is detected only after signing, so the recipient has already signed the receipt text by then; SIG-23 must define the outcome (for example no download confirmation, a logged tamper event, and telling the user the receipt's name is wrong). Before signing, META's integrity still rests only on `F`, and on the ciphertext hash where the sender registered one with the server. SIG-13 builds it; SIG-23 applies it to P2P.

The app needs two things the spike does not build:

- The P2P ciphertext-hash frame of 0002, under `metaKey`, right after the last chunk. It needs its own kind, so its IV differs from META's.
- Direction. In P2P the recipient also encrypts (RECEIPT) under a shared key, and `frames.ts` puts a direction byte first in the IV. Either use IV = direction ‖ kind ‖ 00 00 ‖ seq, or derive the recipient's frames from their own HKDF label. The second keeps one writer per key.

### Chunk size per mode

AES-GCM is about 7 to 100 times faster than SHA-256 at every chunk size, and the pipeline ran at the same speed with 48 KiB, 256 KiB and 1 MiB chunks. So, while SHA-256 sets the pace, chunk size is a choice about padding and transport, not speed. A faster SHA-256 would change that (see Chunk size under Measurements).

Worst-case padding overhead of `paddedLength` (Padmé, then whole chunks) over each size range, from `padding.ts` `overhead()`:

| File size       | 48 KiB | 256 KiB | 1 MiB |  4 MiB |
| --------------- | -----: | ------: | ----: | -----: |
| 100 kB to 1 MB  |   48 % |   162 % | 949 % | 4094 % |
| 1 MB to 10 MB   |  5.9 % |    25 % | 100 % |  319 % |
| 10 MB to 100 MB |  3.1 % |   3.1 % |  10 % |   33 % |
| 100 MB to 1 GB  |  3.1 % |   3.1 % | 3.1 % |  4.2 % |
| 1 GB to 5 GB    |  3.1 % |   3.1 % | 3.1 % |  3.1 % |

- **P2P:** 48 KiB, as today. It is bounded by what one data-channel message carries across browsers (`MAX_CHUNK_BYTES` in `frames.ts`).
- **Stored ciphertext:** 48 KiB as well. It pads least, it gives both modes one format, and it cost no measured speed at 1 GiB in one run per cell, behind the JavaScript SHA-256. If SHA-256 gets faster, measure 48 KiB against 256 KiB again before fixing it: alone, AES-GCM was up to twice as fast at 256 KiB. The chunk size is independent of the upload's part size: one upload part can carry many chunks. Frame overhead at 48 KiB is 26 bytes per chunk, 0.05 %. If hosted mode shows a per-frame cost the bench did not (5 GiB was not run at 48 KiB), 256 KiB is the next choice: it costs up to 25 % on files of 1 to 10 MB. 1 MiB and above pad small files heavily for no gain.

### `paddedLength`

One function, `paddedLength(size, chunkSize)`, in the shared crypto package, replaces the 48 KiB-only version in `apps/web/src/lib/frames.ts`; 0001 lets SIG-7 replace it. The chunk size is a parameter, carried in the stream header and META. The recipient, after opening SEALED, recomputes `paddedLength(size, chunkSize)` and refuses a stream whose header disagrees (built in `container.ts`), so a sender cannot pick padding that leaks more than Padmé, and the padding must be zeros (built in `PlaintextCheck`). If both modes keep 48 KiB, 0001's wording "Padmé, then whole 48 KiB chunks" stays true; otherwise SIG-13's record should say "whole chunks of the transfer's chunk size".

### Sink per browser

- **Chromium:** `showSaveFilePicker` and a `FileSystemWritableFileStream` when the user picks a file. The output never sits in OPFS, so the device needs the ciphertext plus the file.
- **Elsewhere, or when the user declines the picker:** decrypt into OPFS, then download the disk-backed `File` through a `blob:` URL. Memory grew by at most 179 MiB in every engine.
- **Never the in-memory Blob** for anything but small files: it grew by the file size or more outside Chromium.
- **The service worker only as a fallback**, if at all. It saves the OPFS copy of the output, but it needs a trusted certificate (so a LAN demo with the self-signed certificate cannot use it), it changes the e2e harness (below), and in Firefox it grew memory by the file size, which removes its advantage there.
- **Firefox and large files.** Two copies in OPFS did not fit Firefox's 10 GiB quota at 5 GiB. Options, none tested: request `navigator.storage.persist()` before receiving; decrypt in place, writing each chunk's plaintext over the staged ciphertext at a lower offset with the same sync access handle (plaintext is shorter than its frame, so it never overwrites unread ciphertext), which keeps OPFS at one copy; or set the size limit for Firefox at half its quota. SIG-23 decides. Staging keeps one retry that in-place decryption gives up: if the sink fails during decryption (an `fsa` or `sw` write, or an OPFS write error) while `S` is still in memory, the staged ciphertext is intact, so decrypt again to another sink; in place, the plaintext has already overwritten it. A failed download after in-place decryption finished can still be retried from the plaintext file. In-place writes never grow the file, so in-place decryption cannot run out of space part-way through and does not need the retry for that case. A tab closed after release loses `S` under both designs, since 0004 allows one release per signed slot.
- **`C` comes last.** The recipient verifies `C` only after the last chunk. A `FileSystemWritableFileStream` (`fsa`, `fsa-opfs`) writes to a swap file that reaches the target only on `close()`; the spike checks `C` before closing the sink and calls `abort()` on failure, which fully covers `fsa`. `opfs`, `fsa-opfs` and `blob` are downloaded only after success, so they only have to delete the output. `sw` has already streamed plaintext to the browser's download when `C` fails; the spike errors the stream, but whether the browser then discards the partial download is untested (Chromium may keep an interrupted download's partial file for resume). If it does not, `sw` needs a temporary name and a rename on success, or stays a fallback only.
- **Before receiving**, check `storage.estimate()` against twice `paddedLength` and tell the recipient what to free, knowing WebKit's estimate can be wrong after writable-stream writes. That points to the sync access handle (`opfs`) rather than `createWritable` for OPFS in WebKit.

### SHA-256

The JavaScript SHA-256 sets the speed of every phase: 171 MB/s in Chromium, 153 in WebKit and 44 in Firefox. A 5 GB file in Firefox takes about two minutes per pass, and each side makes two: the sender hashes the plaintext for `C` and the ciphertext for the checksum; the recipient hashes the ciphertext as it arrives (not modelled in the bench) and the plaintext to check `C`.

Options:

- **A faster SHA-256.** A WebAssembly SHA-256 behaves the same in every engine and would likely close Firefox's fourfold gap. 300 to 500 MB/s per core is a guess. WebCrypto's `digest` does not stream, so it does not help. Firefox's gap to the other engines also suggests the JavaScript implementation hits a slow path there, which a profile would show.
- **Hashing in parallel.** The ciphertext hash can run in a second worker while the next chunk is encrypted. The sender's `C` pass must finish before META is written, since META carries `C`; with the ciphertext staged in OPFS, the sender could reserve META's place and fill it last, making one pass instead of two. In P2P that changes what the recipient reads first, and it changes 0002's frame order, so it belongs in SIG-13's record.
- **Replacing `C` with something from the AEAD.** AES-GCM is not key-committing, and tags depend on the key and the IVs, so a verifier would need the key, and each P2P attempt would give a different value. 0002's verifier recomputes `C` from the file and the salt alone, years later, without a key. Changing that changes 0002's Checksums and the evidence package (SIG-19, SIG-20). Not recommended.

Recommendation: keep `C = SHA-256(salt ‖ plaintext)`. Measure a WebAssembly SHA-256 in this bench before SIG-13, and adopt it if it at least doubles Firefox's speed.

### A future `@fidant/crypto` package

Lift the spike's modules into a workspace package when the first production consumer and a second consumer exist (0001: the e2e harness, which must reproduce the derivations). Everything works in the browser and in Node, with no DOM:

- `keys`: `generateHalves()`, `createTransferId()`, `encodeFragmentHalf(F)`, `decodeFragmentHalf(text)`, `deriveMetaKey(F, transferId)`, `deriveContentKey(F, S, transferId)`. Non-extractable AES-GCM keys; raw-bit variants only for tests and the leak detector.
- `padding`: `paddedLength(size, chunkSize)`, `chunkCount(paddedLength, chunkSize)`.
- `stream`: `encodeStreamHeader`, `decodeStreamHeader`, `StreamWriter`, `StreamReader`, `padChunks(source, chunkSize, paddedLength)`.
- `container`: `createSalt()`, `commit(salt, source)`, `sealMeta` and `openMeta`, `sealSealed` and `openSealed`, `PlaintextCheck`, and the ciphertext-hash frame.
- `sha256` (the faster one, if adopted) and `base64url`.

Sinks, OPFS staging and any service worker stay in `apps/web`: they are browser plumbing, not format.

### E2E harness

- **Service worker**, only if the app adopts the `sw` sink. The harness sets `serviceWorkers: "block"`, which disables it. Chromium and Safari refuse a service worker on a page whose certificate error was clicked through, so `ignoreHTTPSErrors` must give way to SPKI or CA trust, as 0001's Certificate trust already says. And the recorder's `context.route` does not see what a service worker answers or fetches. The download itself never touches the network, so the detector loses nothing today; the blind spot is a later change that makes the worker fetch. A spec would have to show it makes no requests (for example a CSP `connect-src 'none'` on the worker script, checked by a test).
- **WebKit.** A WebKit project needs `launchPersistentContext`: an ephemeral WebKit context has no OPFS (`getDirectory()` fails with `UnknownError`). On macOS, keep the display awake while it runs.
- **Downloads.** Specs for large files should check the downloaded file's size and hash, as `src/runner/verify.ts` does. The page saying "done" does not prove the file on disk is right.
- **Detector.** It must derive `metaKey` and `contentKey` from `F`, `S` and the transfer ID and treat both as K. 0001 already counts every derived key as K.

## Pending human runs

Start the bench on the laptop that serves it:

```sh
pnpm --filter @fidant/spike-split-key bench
```

It prints `http://127.0.0.1:8450/` (this machine) and `https://<LAN address>:8451/` (phones, other machines; accept the certificate warning). Per run: choose size, chunk size 256 KiB, the seeded source and a sink, click "Run pipeline", and when it is done click "Copy JSON" and save the JSON to `results/` with the browser and device in the file name. "Clear OPFS" between runs. 5 GiB needs about 11 GB free.

- [ ] **Safari, macOS**, `http://127.0.0.1:8450/`: 1 GiB and 5 GiB with `opfs`, `blob` and `sw` (`fsa` is not offered). Watch the "Safari Web Content" process in Activity Monitor (Memory column) and note its peak.
- [ ] **Firefox release, macOS or Windows**, `http://127.0.0.1:8450/`: 1 GiB and 5 GiB with `opfs`, `sw` and `blob`. Memory from Activity Monitor or Task Manager. At 5 GiB with `opfs`, note whether quota fails as in Nightly, then repeat after running `await navigator.storage.persist()` in the page's console.
- [ ] **Chrome with the real picker**, `http://127.0.0.1:8450/`: 1 GiB and 5 GiB with `fsa`, saving to the Downloads folder. Check the saved file's size.
- [ ] **iPhone Safari**, `https://<LAN address>:8451/`: 64 MiB and 1 GiB with `opfs` and `blob`. `sw` will report unsupported with the self-signed certificate. Note whether the tab reloads (a sign of memory pressure).
- [ ] **Android Chrome**, `https://<LAN address>:8451/`: 64 MiB and 1 GiB with `opfs`, `blob` and `fsa` if offered.
- [ ] **Microbenchmarks on each of these**: "Run microbenchmarks" at 256 MiB (64 MiB on phones).
- [ ] **Fragment handoff**: open `https://<LAN address>:8451/handoff.html` on the sending device, send a fresh probe link per row through the channel, open it on the receiving device by tapping it, and fill in the table in `README.md`: Gmail web, Outlook with Safe Links on and off, Apple Mail (macOS and iOS), iMessage, WhatsApp, Signal, Slack, Microsoft Teams, Android SMS, a link at the end of a sentence and in parentheses, and copy-paste. Where the receiving device cannot reach the LAN address, use "Check a pasted link".

## Follow-ups

- **SIG-13 (Send a file):** implement this format (two keys, stream header in the AAD, final-chunk kind, META and SEALED, the META hash in SEALED) in `@fidant/crypto`, with `apps/web` and the e2e detector as consumers; one `paddedLength(size, chunkSize)`; 48 KiB chunks unless hosted mode shows a reason; measure a WebAssembly SHA-256 first. SIG-13 owns a decision record that amends 0001 and 0002 the way 0004 does, with a "Where 0001 or 0002 says / Read" table. It covers: END replaced by the final-chunk kind, with `C` compared after the last chunk (0002 says verified transfers compare `C` in END); the stream header in the AAD; META's and SEALED's sizes; the HKDF labels; a per-stream random `streamId` as the HKDF salt, apart from the server's `transferId`; the SHA-256 of META in SEALED; ownership of `paddedLength`; and, if adopted, reserving META's place and filling it last, which changes 0002's frame order. When the modules move into `@fidant/crypto`, SIG-13 deletes `spikes/split-key` and the `spikes/*` entry in `pnpm-workspace.yaml`. The spike's `serve.ts` imports `ensureCert` from `apps/server`, a spike shortcut that goes with it.
- **SIG-14 (Notify the recipient):** Fidant sends a notice without the fragment; the sender's browser offers share, `mailto:` and Copy for the full link; the receive page strips the fragment. Run the handoff checks above first.
- **SIG-23 (Verified P2P transfer):** stage ciphertext in OPFS with a sync access handle; check space for two copies before receiving, and let that check gate signing and the release of `S`; decide Firefox's large-file path (persist, in-place decryption or a limit); define, for either design, the outcome of a decrypt or delivery that fails after `S` is released, since 0004 allows one release per signed slot (staging allows a retry only while `S` is still in memory); check `C` before closing the sink and abort on failure (covers `fsa`), and test whether `sw` leaves a partial download after the stream errors; check the META hash in SEALED, and define the outcome of a mismatch found after signing; delete the staged buffer when the recipient does not sign; add the ciphertext-hash frame under `metaKey` and a direction rule for the recipient's frames; pick the sink per browser as above.
- **SIG-39 and SIG-41 (done):** nothing to change unless the app adopts the service worker or adds WebKit. Then a new issue for SPKI or CA trust, `serviceWorkers`, the recorder's service-worker blind spot and WebKit's persistent context; and the detector derives `metaKey` and `contentKey` once `@fidant/crypto` exists.
- **0001:** no change needed now beyond SIG-13's record. If the service worker is adopted, its Certificate trust consequence applies.
- **0002:** the format departs from it in two places (three if META is filled last): verified transfers compare `C` after the final chunk, not in END, and SEALED also carries the SHA-256 of META. SIG-13's record amends it; this spike does not.
- **This spike:** the human runs above.
