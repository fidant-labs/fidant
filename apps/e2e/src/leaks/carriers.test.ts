import assert from "node:assert/strict";
import { test } from "node:test";
import { canaryFile, canaryKey, SeededRandom } from "./canary.ts";
import { mailCaptures } from "./captures.ts";
import { allowEmailed, type Carrier, maskCarriers } from "./carriers.ts";
import {
  type Allowed,
  buildNeedles,
  fileSecrets,
  keySecrets,
  type Secret,
  textSecrets,
} from "./needles.ts";
import { type Capture, scan } from "./scan.ts";

const random = SeededRandom.fromLabel("carriers test");
const file = canaryFile(random.fork("file"), { size: 1000 });
const needles = buildNeedles(fileSecrets("file#1", file));
const receipt = `Jag har tagit emot filen ${file.name} från avsändaren.`;
const carriers: Carrier[] = [{ name: "receipt text", value: receipt }];
const allowed = (point: string) => point.startsWith("bankid");

/** The `class label` of each M finding the scan makes after masking. */
function names(captures: Capture[]): string[] {
  return scan(captures, needles)
    .filter((finding) => finding.class === "M")
    .map((finding) => `${finding.label} @ ${finding.point}`);
}

/** The receipt in the encodings a sign request or its storage may use. */
const carrying = [
  JSON.stringify({ receiptText: receipt }),
  JSON.stringify({ receiptText: receipt.normalize("NFD") }),
  JSON.stringify({ receiptText: receipt }).replace(
    /[\u0080-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  ),
  JSON.stringify({ userVisibleData: Buffer.from(receipt).toString("base64") }),
  `receipt=${encodeURIComponent(receipt)}`,
  `\\x${Buffer.from(receipt).toString("hex")}`,
];

test("the scan finds the name in each carrying form before masking", () => {
  for (const text of carrying) {
    assert.ok(names([{ point: "bankid#1", bytes: Buffer.from(text) }]).length > 0, text);
  }
});

test("masks a name inside an allowed carrier, so the scan finds no M", () => {
  for (const text of carrying) {
    const before = Buffer.from(text);
    const { captures, misplaced } = maskCarriers(
      [{ point: "bankid#1", bytes: before }],
      carriers,
      allowed,
    );
    assert.deepEqual(misplaced, []);
    assert.deepEqual(names(captures), [], text);
    assert.equal(captures[0]?.bytes.length, before.length, "keeps the length");
  }
});

test("reports the same carrier at a point that is not allowed", () => {
  for (const text of carrying) {
    const capture = { point: "signaling#1", bytes: Buffer.from(text) };
    const { captures, misplaced } = maskCarriers([capture], carriers, allowed);
    assert.deepEqual(
      misplaced.map((finding) => `${finding.class} ${finding.label} @ ${finding.point}`),
      ["M carrier receipt text @ signaling#1"],
      text,
    );
    assert.equal(captures[0], capture, "leaves the capture for the scan");
    assert.ok(names(captures).length > 0);
  }
});

test("still finds a name outside any carrier at an allowed point", () => {
  const text = JSON.stringify({ receiptText: receipt, fileName: file.name });
  const { captures, misplaced } = maskCarriers(
    [{ point: "bankid#1", bytes: Buffer.from(text) }],
    carriers,
    allowed,
  );
  assert.deepEqual(misplaced, []);
  assert.ok(names(captures).includes("file#1 name @ bankid#1"));
});

test("masks binary carriers and refuses short ones", () => {
  const blob = random.bytes(64);
  const { captures } = maskCarriers(
    [{ point: "bankid#2", bytes: Buffer.from(`sig=${blob.toString("base64url")}`) }],
    [{ name: "signature", value: blob }],
    allowed,
  );
  assert.equal(Buffer.from(captures[0]?.bytes ?? []).toString(), `sig=${".".repeat(86)}`);
  assert.throws(
    () => maskCarriers([], [{ name: "short", value: "too short" }], allowed),
    RangeError,
  );
});

const link = random.fork("link").bytes(16).toString("base64url");
const secret = canaryKey(random.fork("secret")).text;
const to = "anna@example.com";
const url = `https://localhost:8443/r/${link}#e.${random.fork("mark").bytes(16).toString("base64url")}.${secret}`;

/** A raw mail as Mailpit saves it, with a quoted-printable body wrapped at 76 characters. */
function eml(headers: string[], body: string): Buffer {
  const wrapped = body.replace(/[^\n]{75}(?=[^\n])/g, "$&=\r\n");
  const all = [...headers, "Content-Type: text/plain; charset=utf-8"];
  return Buffer.from(
    `${all.join("\r\n")}\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${wrapped}`,
  );
}

const notice = (headers: string[] = []) =>
  eml([`To: ${to}`, "Subject: A file for you on Fidant", ...headers], `Open this link:\n${url}\n`);

const frame = (point: string, message: object) => ({
  point,
  bytes: Buffer.from(JSON.stringify(message)),
});

/** The `label @ point` of each finding `allowEmailed` keeps, labels without their ` text` form. */
function kept(captures: Capture[], secrets: Secret[]): string[] {
  const findings = scan(captures, buildNeedles(secrets));
  const left = allowEmailed(findings, captures, secrets);
  return [...new Set(left.map((f) => `${f.label.replace(/ text$/, "")} @ ${f.point}`))].sort();
}

const tagged = (secrets: Secret[], allowed: Allowed) =>
  secrets.map((s) => (s.label.endsWith(" sha256") ? s : { ...s, allowed }));

test("an emailed link's secret is allowed in its first registering frame and its notice's body", () => {
  const secrets = tagged(keySecrets("secret", secret), {
    link,
    frames: ["sent email"],
    mail: { to, notice: "N1" },
  });
  const registering = { t: "email", link, to, secret, from: "", lang: "en" };
  const captures = [
    frame("o/t/sender.jsonl#3 frame-sent.payload", registering),
    frame("o/t/sender.jsonl#5 frame-sent.payload", registering),
    frame("o/t/sender.jsonl#6 frame-sent.payload", { ...registering, link: "other" }),
    frame("o/t/recipient.jsonl#2 frame-received.payload", { t: "email", link, secret }),
    ...mailCaptures("o/t/mail/N1.eml", notice()),
    ...mailCaptures("o/u/mail/N1.eml", notice([`Subject: =?UTF-8?B?${btoa(secret)}?=`])),
    ...mailCaptures("o/v/mail/N1.eml", notice(["Bcc: bob@example.com"])),
    ...mailCaptures("o/w/mail/N1.eml", notice(["Cc: bob@example.com"])),
    ...mailCaptures("o/x/mail/N1.eml", eml([`To: ${to}, bob@example.com`], url)),
    ...mailCaptures("o/t/mail/N2.eml", notice()),
    { point: "o/run/server.stdout.log:4", bytes: Buffer.from(secret) },
  ];
  // Without the tag every one of them is a finding, the allowed notice body included.
  assert.ok(kept(captures, keySecrets("secret", secret)).includes("secret @ o/t/mail/N1.eml body"));
  assert.deepEqual(kept(captures, secrets), [
    "secret @ o/run/server.stdout.log:4",
    "secret @ o/t/mail/N2.eml body",
    "secret @ o/t/recipient.jsonl#2 frame-received.payload",
    "secret @ o/t/sender.jsonl#5 frame-sent.payload",
    "secret @ o/t/sender.jsonl#6 frame-sent.payload",
    "secret @ o/u/mail/N1.eml headers",
    "secret @ o/v/mail/N1.eml body",
    "secret @ o/w/mail/N1.eml body",
    "secret @ o/x/mail/N1.eml body",
  ]);
});

test("an address is allowed in any plain-text mail to it alone, and its token in its frames", () => {
  const token = random.fork("token").bytes(16).toString("base64url");
  const secrets = [
    ...textSecrets("M", "address", to).map((s) => ({
      ...s,
      allowed: { link, frames: ["sent email"], mail: { to } },
    })),
    ...tagged(keySecrets("token", token), { link, frames: ["received token", "sent join"] }),
  ];
  const code = eml([`To: <${to}>`, "Subject: Your Fidant code"], "Your code: 123456");
  const captures = [
    frame("o/t/sender.jsonl#3 frame-sent.payload", { t: "email", link, to }),
    frame("o/t/recipient.jsonl#4 frame-received.payload", { t: "token", link, token }),
    frame("o/t/recipient.jsonl#5 frame-sent.payload", { t: "join", link, attempt: "a", token }),
    frame("o/t/recipient.jsonl#6 frame-sent.payload", { t: "gate", link, token }),
    ...mailCaptures("o/t/mail/C1.eml", code),
    ...mailCaptures("o/t/mail/C2.eml", eml(["To: bob@example.com"], `Write to ${to}`)),
    ...mailCaptures(
      "o/t/mail/C3.eml",
      Buffer.from(`To: ${to}\r\nContent-Type: multipart/mixed\r\n\r\n${to}`),
    ),
    { point: "o/run/server.stdout.log:7", bytes: Buffer.from(`${to} ${token}`) },
  ];
  assert.deepEqual(kept(captures, secrets), [
    "address @ o/run/server.stdout.log:7",
    "address @ o/t/mail/C2.eml body",
    "address @ o/t/mail/C3.eml body",
    "address @ o/t/mail/C3.eml headers",
    "token @ o/run/server.stdout.log:7",
    "token @ o/t/recipient.jsonl#6 frame-sent.payload",
  ]);
});

test("a mail splits into unfolded headers and its body", () => {
  const raw = Buffer.from("To: anna@example.com\r\nSubject: one\r\n two\r\n\r\nbody\r\n\r\nmore");
  assert.deepEqual(
    mailCaptures("m.eml", raw).map(({ point, bytes }) => [point, bytes.toString()]),
    [
      ["m.eml headers", "To: anna@example.com\r\nSubject: one two"],
      ["m.eml body", "body\r\n\r\nmore"],
    ],
  );
});
