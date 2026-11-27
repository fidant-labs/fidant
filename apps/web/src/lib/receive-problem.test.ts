import assert from "node:assert/strict";
import { test } from "node:test";
import {
  keepsDeadPeer,
  keepsPart,
  peerLostProblem,
  refusedProblem,
  turnRefused,
  waitsForRelay,
} from "./receive-problem.ts";

test("peerLostProblem says couldn't connect until the channel opened", () => {
  const relayRefused = false;
  assert.equal(peerLostProblem({ channelOpen: false, receiving: false, relayRefused }), "connect");
  assert.equal(peerLostProblem({ channelOpen: true, receiving: false, relayRefused }), "lost");
  assert.equal(
    peerLostProblem({ channelOpen: true, receiving: true, relayRefused }),
    "lostReceiving",
  );
});

test("peerLostProblem blames a refused relay only after a stall, while the channel never opened", () => {
  const relayRefused = true;
  assert.equal(peerLostProblem({ channelOpen: false, receiving: false, relayRefused }), "connect");
  assert.equal(
    peerLostProblem({ channelOpen: false, receiving: false, relayRefused, stalled: true }),
    "noRelay",
  );
  assert.equal(
    peerLostProblem({ channelOpen: false, receiving: false, relayRefused: false, stalled: true }),
    "connect",
  );
  assert.equal(peerLostProblem({ channelOpen: true, receiving: false, relayRefused }), "lost");
  assert.equal(
    peerLostProblem({ channelOpen: true, receiving: true, relayRefused }),
    "lostReceiving",
  );
});

test("peerLostProblem says Try again continues while the attempt holds a kept part", () => {
  const relayRefused = false;
  assert.equal(
    peerLostProblem({ channelOpen: true, receiving: false, resuming: true, relayRefused }),
    "lostReceiving",
  );
  assert.equal(
    peerLostProblem({ channelOpen: false, receiving: false, resuming: true, relayRefused }),
    "connect",
  );
  assert.equal(
    peerLostProblem({
      channelOpen: false,
      receiving: false,
      resuming: true,
      relayRefused: true,
      stalled: true,
    }),
    "noRelay",
  );
});

test("refusedProblem offers Try again for a busy link only while a part is kept", () => {
  assert.deepEqual(refusedProblem("busy", true), { s: "failed", problem: "senderBusy" });
  assert.deepEqual(refusedProblem("busy", false), { s: "refused", problem: "busy" });
  assert.deepEqual(refusedProblem("used", true), { s: "refused", problem: "used" });
  assert.deepEqual(refusedProblem("unknown", true), { s: "refused", problem: "unknown" });
});

test("keepsPart keeps a part until the attempt ends, then only on a failure Try again continues", () => {
  const ended = true;
  assert.equal(keepsPart({ ended: false }), true);
  assert.equal(keepsPart({ ended, ending: { s: "failed", problem: "lostReceiving" } }), true);
  assert.equal(keepsPart({ ended, ending: { s: "failed", problem: "senderBusy" } }), true);
  assert.equal(keepsPart({ ended, ending: { s: "failed", problem: "browser" } }), false);
  assert.equal(keepsPart({ ended, ending: { s: "failed", problem: "differed" } }), false);
  assert.equal(keepsPart({ ended, ending: { s: "refused", problem: "used" } }), false);
  assert.equal(keepsPart({ ended, ending: { s: "declined" } }), false);
  assert.equal(keepsPart({ ended }), false);
});

test("keepsPart keeps nothing once the recipient said the numbers differ", () => {
  assert.equal(keepsPart({ ended: false, saidDiffers: true }), false);
  const lost = { s: "failed", problem: "lostReceiving" } as const;
  assert.equal(keepsPart({ ended: true, saidDiffers: true, ending: lost }), false);
});

test("peerLostProblem says the numbers differed once the recipient said so", () => {
  const attempt = { channelOpen: true, receiving: false, resuming: true, relayRefused: false };
  assert.equal(peerLostProblem({ ...attempt, saidDiffers: true }), "differed");
  assert.equal(peerLostProblem({ ...attempt, saidDiffers: false }), "lostReceiving");
});

test("waitsForRelay only when a relay is up and the channel never opened", () => {
  assert.equal(waitsForRelay({ relayUp: true, channelOpen: false }), true);
  assert.equal(waitsForRelay({ relayUp: true, channelOpen: true }), false);
  assert.equal(waitsForRelay({ channelOpen: false }), false);
});

test("turnRefused restarts a bounded number of times and never once the channel is open", () => {
  for (const restarts of [0, 3]) {
    assert.equal(turnRefused({ channelOpen: false }, restarts, 4), "restart");
  }
  assert.equal(turnRefused({ channelOpen: false }, 4, 4), "fail");
  assert.equal(turnRefused({ channelOpen: true }, 0, 4), "ignore");
  assert.equal(turnRefused({ channelOpen: true }, 4, 4), "ignore");
});

test("keepsDeadPeer holds only while asking and the channel never opened", () => {
  assert.equal(keepsDeadPeer({ asking: true, channelOpen: false }), true);
  assert.equal(keepsDeadPeer({ asking: true, channelOpen: true }), false);
  assert.equal(keepsDeadPeer({ channelOpen: false }), false);
});
