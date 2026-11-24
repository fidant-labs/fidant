import assert from "node:assert/strict";
import { test } from "node:test";
import { peerLostProblem } from "./receive-problem.ts";

test("peerLostProblem says couldn't connect until the channel opened", () => {
  assert.equal(peerLostProblem({ channelOpen: false, receiving: false }), "connect");
  assert.equal(peerLostProblem({ channelOpen: true, receiving: false }), "lost");
  assert.equal(peerLostProblem({ channelOpen: true, receiving: true }), "lostReceiving");
});
