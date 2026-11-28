import assert from "node:assert/strict";
import { test } from "node:test";
import {
  joinedAction,
  joinsAgain,
  onSocketClose,
  onSocketOpen,
  resumeAction,
  takesGate,
  takesRefusal,
} from "./receive-guards.ts";

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

test("onSocketClose takes the attempt back while an unsent token is held", () => {
  for (const channelOpen of [false, true]) {
    for (const answered of [false, true]) {
      assert.equal(
        onSocketClose({ channelOpen, aborted: false, answered, hasToken: true }),
        "resume",
      );
    }
  }
});

test("onSocketClose goes on as before 0033 without a token", () => {
  const open = { channelOpen: true, answered: true, hasToken: false };
  assert.equal(onSocketClose({ ...open, aborted: false }), "close");
  assert.equal(onSocketClose({ ...open, aborted: true }), "lost");
  const before = { channelOpen: false, aborted: false, hasToken: false };
  assert.equal(onSocketClose({ ...before, answered: true }), "lost");
  assert.equal(onSocketClose({ ...before, answered: false }), "restart");
});

test("onSocketClose ends an open attempt whose peer already dropped, token or not", () => {
  assert.equal(
    onSocketClose({ channelOpen: true, aborted: true, answered: true, hasToken: true }),
    "lost",
  );
});

test("onSocketOpen sends resume with a token, and never gate or join after the channel opened", () => {
  assert.equal(onSocketOpen({ channelOpen: true, hasToken: true }), "resume");
  assert.equal(onSocketOpen({ channelOpen: false, hasToken: true }), "resume");
  assert.equal(onSocketOpen({ channelOpen: true, hasToken: false }), "none");
  assert.equal(onSocketOpen({ channelOpen: false, hasToken: false }), "ask");
});

test("resumeAction keeps each token, and joins again only after a stall while waiting", () => {
  const ours = { current: true, ours: true, token: true };
  assert.equal(resumeAction({ ...ours, waiting: false, stalled: false }), "keep");
  assert.equal(resumeAction({ ...ours, waiting: true, stalled: false }), "keep");
  assert.equal(resumeAction({ ...ours, waiting: true, stalled: true }), "keep-and-join");
});

test("resumeAction takes a refusal only as the answer to this page's resume", () => {
  const refused = { current: true, ours: true, token: false, stalled: true };
  assert.equal(resumeAction({ ...refused, waiting: true }), "refused");
  assert.equal(resumeAction({ ...refused, waiting: false }), "ignore");
});

test("resumeAction ignores another link or attempt, and an ended attempt", () => {
  for (const token of [false, true]) {
    const base = { token, waiting: true, stalled: true };
    assert.equal(resumeAction({ ...base, current: true, ours: false }), "ignore");
    assert.equal(resumeAction({ ...base, current: false, ours: true }), "ignore");
  }
});
