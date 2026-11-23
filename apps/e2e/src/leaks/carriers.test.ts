import assert from "node:assert/strict";
import { test } from "node:test";
import { canaryFile, SeededRandom } from "./canary.ts";
import { type Carrier, maskCarriers } from "./carriers.ts";
import { buildNeedles, fileSecrets } from "./needles.ts";
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
