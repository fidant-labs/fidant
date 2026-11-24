import assert from "node:assert/strict";
import { test } from "node:test";
import { peerLostProblem } from "./receive-problem.ts";

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
