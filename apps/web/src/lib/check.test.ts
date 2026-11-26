import assert from "node:assert/strict";
import { test } from "node:test";
import { checkNumber, commitFingerprint, sdpFingerprint } from "./check.ts";

const A =
  "00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F";
const B =
  "FF:FE:FD:FC:FB:FA:F9:F8:F7:F6:F5:F4:F3:F2:F1:F0:EF:EE:ED:EC:EB:EA:E9:E8:E7:E6:E5:E4:E3:E2:E1:E0";

function sdp(...fingerprintLines: string[]): string {
  const media = (line: string) =>
    ["m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0", line].join("\r\n");
  return [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    ...fingerprintLines.map(media),
    "",
  ].join("\r\n");
}

test("the safety number follows the fixed vectors", async () => {
  assert.equal(await checkNumber(A, B), "013 306");
  assert.equal(await checkNumber(B, A), "948 540");
  assert.equal(await checkNumber(A, A), "459 244");
});

test("the commitment follows the fixed vectors", async () => {
  assert.equal(await commitFingerprint(A), "eJYHYAxO7JqecPu7xarRNkTK0oca8dgQDy9zzSxGpf4");
  assert.equal(await commitFingerprint(B), "KrwLEpkRBXWd-eY4QBlfSl9eUNMmWKcZGdKaIFxUUfA");
});

test("sdpFingerprint reads the one sha-256 fingerprint, upper-cased", () => {
  const line = `a=fingerprint:sha-256 ${A.toLowerCase()}`;
  assert.equal(sdpFingerprint(sdp(line, line)), A);
});

test("sdpFingerprint refuses an SDP without exactly one sha-256 fingerprint", () => {
  assert.equal(sdpFingerprint(sdp("a=setup:actpass")), undefined);
  assert.equal(sdpFingerprint(sdp(`a=fingerprint:sha-1 ${A.slice(0, 59)}`)), undefined);
  assert.equal(
    sdpFingerprint(sdp(`a=fingerprint:sha-256 ${A}`, `a=fingerprint:sha-256 ${B}`)),
    undefined,
  );
  assert.equal(sdpFingerprint(sdp(`a=fingerprint:sha-256 ${A.slice(3)}`)), undefined);
});

test("sdpFingerprint refuses an SDP that adds a fingerprint of another algorithm", () => {
  assert.equal(
    sdpFingerprint(sdp(`a=fingerprint:sha-256 ${A}`, `a=fingerprint:sha-512 ${B}:${B}`)),
    undefined,
  );
});

test("sdpFingerprint refuses any spelling of a fingerprint line but the exact one", () => {
  const exact = `a=fingerprint:sha-256 ${A}`;
  for (const hidden of [
    `a=Fingerprint:sha-256 ${B}`,
    `a=FINGERPRINT:sha-256 ${B}`,
    `A=fingerprint:sha-256 ${B}`,
    `a=fingerprint sha-256 ${B}`,
    `a=fingerprint :sha-256 ${B}`,
    `a= fingerprint:sha-256 ${B}`,
    ` a=fingerprint:sha-256 ${B}`,
    `\ta=fingerprint:sha-256 ${B}`,
    `a=fingerprint:SHA-256 ${B}`,
    `a=fingerprint:sha-256  ${B}`,
    `a=fingerprint:sha-256 ${B} `,
    `a=fingerprint:sha-256\t${B}`,
  ]) {
    assert.equal(sdpFingerprint(sdp(exact, hidden)), undefined, JSON.stringify(hidden));
    assert.equal(sdpFingerprint(sdp(hidden)), undefined, JSON.stringify(hidden));
  }
  assert.equal(sdpFingerprint(sdp(`${exact}\ra=fingerprint:sha-256 ${B}`)), undefined);
});
