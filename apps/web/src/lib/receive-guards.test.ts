import assert from "node:assert/strict";
import { test } from "node:test";
import { joinedAction, joinsAgain, takesGate, takesRefusal } from "./receive-guards.ts";

test("joinsAgain joins again only for a live attempt the sender's socket still holds", () => {
  assert.equal(joinsAgain({ current: true, hostGone: false, aborted: false }), true);
  assert.equal(joinsAgain({ current: false, hostGone: false, aborted: false }), false);
  assert.equal(joinsAgain({ current: true, hostGone: true, aborted: false }), false);
  assert.equal(joinsAgain({ current: true, hostGone: false, aborted: true }), false);
});

test("takesGate takes a gate for this link only before the channel opens", () => {
  assert.equal(takesGate({ current: true, ourLink: true, channelOpen: false }), true);
  assert.equal(takesGate({ current: true, ourLink: true, channelOpen: true }), false);
  assert.equal(takesGate({ current: false, ourLink: true, channelOpen: false }), false);
  assert.equal(takesGate({ current: true, ourLink: false, channelOpen: false }), false);
});

test("takesRefusal ignores busy, and any refusal after host-gone, once the channel is open", () => {
  const open = { channelOpen: true, hostGone: false };
  assert.equal(takesRefusal(open, "busy"), false);
  for (const reason of ["busy", "drop", "used", "starting"] as const) {
    assert.equal(takesRefusal({ channelOpen: true, hostGone: true }, reason), false, reason);
  }
});

test("takesRefusal still ends the attempt on drop or used after the channel opened", () => {
  const open = { channelOpen: true, hostGone: false };
  assert.equal(takesRefusal(open, "drop"), true);
  assert.equal(takesRefusal(open, "used"), true);
});

test("takesRefusal takes every refusal before the channel opens, busy included", () => {
  for (const hostGone of [false, true]) {
    for (const reason of ["busy", "drop", "used", "starting"] as const) {
      assert.equal(takesRefusal({ channelOpen: false, hostGone }, reason), true, reason);
    }
  }
});

test("joinedAction pairs, hands a repeat to the peer, or ignores another or an ended attempt", () => {
  assert.equal(joinedAction({ current: true, ours: true, hasPeer: false }), "pair");
  assert.equal(joinedAction({ current: true, ours: true, hasPeer: true }), "rejoin");
  assert.equal(joinedAction({ current: true, ours: false, hasPeer: true }), "ignore");
  assert.equal(joinedAction({ current: false, ours: true, hasPeer: true }), "ignore");
  assert.equal(joinedAction({ current: false, ours: true, hasPeer: false }), "ignore");
});
