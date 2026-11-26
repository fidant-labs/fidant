import assert from "node:assert/strict";
import { test } from "node:test";
import { peerLostProblem, refusedProblem } from "./receive-problem.ts";

test("peerLostProblem says couldn't connect until the channel opened", () => {
  const relayRefused = false;
  assert.equal(peerLostProblem({ channelOpen: false, receiving: false, relayRefused }), "connect");
  assert.equal(peerLostProblem({ channelOpen: true, receiving: false, relayRefused }), "lost");
  assert.equal(
    peerLostProblem({ channelOpen: true, receiving: true, relayRefused }),
    "lostReceiving",
  );
});

test("peerLostProblem blames a refused relay only while the channel never opened", () => {
  const relayRefused = true;
  assert.equal(peerLostProblem({ channelOpen: false, receiving: false, relayRefused }), "noRelay");
  assert.equal(peerLostProblem({ channelOpen: true, receiving: false, relayRefused }), "lost");
  assert.equal(
    peerLostProblem({ channelOpen: true, receiving: true, relayRefused }),
    "lostReceiving",
  );
});

test("refusedProblem offers Try again for a busy link only while a part is kept", () => {
  assert.deepEqual(refusedProblem("busy", true), { s: "failed", problem: "senderBusy" });
  assert.deepEqual(refusedProblem("busy", false), { s: "refused", problem: "busy" });
  assert.deepEqual(refusedProblem("used", true), { s: "refused", problem: "used" });
  assert.deepEqual(refusedProblem("unknown", true), { s: "refused", problem: "unknown" });
});
