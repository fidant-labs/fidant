import assert from "node:assert/strict";
import { test } from "node:test";
import { type EmailStatus, MAX_LINKS } from "@sigill/protocol";
import { createLink, type Link } from "./link.ts";
import {
  CHECKSUM_MISMATCH,
  emailBound,
  findRecipient,
  hostedLinks,
  initialSenderState,
  type Recipient,
  refusesRelay,
  SETUP_TIMEOUT_MS,
  type SenderAction,
  type SenderEffect,
  type SenderState,
  unmarked,
  update,
} from "./sender-state.ts";

const ORIGIN = "https://192.168.1.5:8443";
/** Attempt IDs, one per join. */
const A = "attemptAAAAAAAAAAAAAAA";
const B = "attemptBBBBBBBBBBBBBBB";
const TURN = [{ urls: ["turn:127.0.0.1:3478"], username: "1700000000", credential: "hmac" }];

/** Applies actions in order and collects every effect. */
function run(
  state: SenderState,
  ...actions: SenderAction[]
): { state: SenderState; effects: SenderEffect[] } {
  const effects: SenderEffect[] = [];
  for (const action of actions) {
    const result = update(state, action);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

function withRecipient(name = "Anna") {
  const link = createLink(ORIGIN);
  const { state } = run(initialSenderState, { type: "add", link, name });
  return { state, linkId: link.linkId, link };
}

function statusOf(state: SenderState, linkId: string) {
  return findRecipient(state, linkId)?.status;
}

function joined(linkId: string, attempt: string, turn = true): SenderAction {
  return { type: "joined", linkId, attempt, iceServers: [], turn };
}

test("add creates a waiting recipient from a link and keeps insertion order", () => {
  const a = createLink(ORIGIN);
  const b = createLink(ORIGIN);
  const { state, effects } = run(
    initialSenderState,
    { type: "add", link: a, name: "Anna" },
    { type: "add", link: b, name: "Erik" },
  );
  assert.deepEqual(effects, []);
  assert.deepEqual(state.recipients, [
    { name: "Anna", ...a, status: "waiting", bytesSent: 0 },
    { name: "Erik", ...b, status: "waiting", bytesSent: 0 },
  ]);
  assert.deepEqual(initialSenderState.recipients, [], "initial state untouched");
});

test("add ignores a duplicate link ID and stops at MAX_LINKS", () => {
  const { state, link } = withRecipient();
  assert.equal(update(state, { type: "add", link, name: "Other" }).state, state);

  let full = initialSenderState;
  for (let i = 0; i < MAX_LINKS; i++) {
    full = update(full, { type: "add", link: createLink(ORIGIN), name: `R${i}` }).state;
  }
  assert.equal(full.recipients.length, MAX_LINKS);
  const extra = update(full, { type: "add", link: createLink(ORIGIN), name: "Extra" });
  assert.equal(extra.state, full);
});

test("a full delivery walks waiting → connecting → offered → receiving → delivered", () => {
  const { state: s0, linkId } = withRecipient();

  const s1 = update(s0, { type: "joined", linkId, attempt: A, iceServers: TURN, turn: true });
  assert.equal(statusOf(s1.state, linkId), "connecting");
  assert.deepEqual(s1.effects, [{ type: "start", linkId, attempt: A, iceServers: TURN }]);
  assert.equal(statusOf(s0, linkId), "waiting", "previous state not mutated");

  const s2 = update(s1.state, { type: "channel-open", linkId });
  assert.equal(statusOf(s2.state, linkId), "offered");
  assert.deepEqual(s2.effects, []);

  const s3 = update(s2.state, { type: "accepted", linkId });
  assert.equal(statusOf(s3.state, linkId), "receiving");
  assert.deepEqual(s3.effects, []);

  const s4 = update(s3.state, { type: "progress", linkId, bytesSent: 4096 });
  assert.equal(findRecipient(s4.state, linkId)?.bytesSent, 4096);
  assert.equal(findRecipient(s3.state, linkId)?.bytesSent, 0, "previous state not mutated");

  const s5 = update(s4.state, { type: "receipt", linkId, match: true });
  assert.equal(statusOf(s5.state, linkId), "delivered");
  assert.equal(findRecipient(s5.state, linkId)?.bytesSent, 4096);
  assert.deepEqual(s5.effects, [{ type: "close", linkId }]);
});

test("a join after delivery is refused as used and changes nothing", () => {
  const { state: s0, linkId } = withRecipient();
  const { state } = run(
    s0,
    joined(linkId, A),
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
    { type: "receipt", linkId, match: true },
  );
  const result = update(state, joined(linkId, A));
  assert.equal(result.state, state);
  assert.deepEqual(result.effects, [{ type: "refuse", linkId, attempt: A, reason: "used" }]);
});

test("a join while connecting, offered or receiving is refused as busy", () => {
  const { state: s0, linkId } = withRecipient();
  const steps: SenderAction[] = [
    joined(linkId, A),
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
  ];
  let state = s0;
  for (const step of steps) {
    state = update(state, step).state;
    const result = update(state, joined(linkId, B));
    assert.equal(result.state, state, `after ${step.type}`);
    assert.deepEqual(result.effects, [{ type: "refuse", linkId, attempt: B, reason: "busy" }]);
  }
});

test("a join for a link ID not on the list is refused as unknown", () => {
  const { state } = withRecipient();
  const stranger = createLink(ORIGIN).linkId;
  const result = update(state, joined(stranger, A));
  assert.equal(result.state, state);
  assert.deepEqual(result.effects, [
    { type: "refuse", linkId: stranger, attempt: A, reason: "unknown" },
  ]);
});

test("a drop before delivery returns the recipient to waiting and frees the link", () => {
  for (const reached of ["connecting", "offered", "receiving"] as const) {
    const { state: s0, linkId } = withRecipient();
    const steps: SenderAction[] = [
      joined(linkId, A),
      { type: "channel-open", linkId },
      { type: "accepted", linkId },
      { type: "progress", linkId, bytesSent: 1 << 20 },
    ];
    const count = { connecting: 1, offered: 2, receiving: 4 }[reached];
    const { state } = run(s0, ...steps.slice(0, count));
    assert.equal(statusOf(state, linkId), reached);

    const dropped = update(state, { type: "dropped", linkId });
    assert.deepEqual(findRecipient(dropped.state, linkId), {
      ...findRecipient(s0, linkId),
      status: "waiting",
      bytesSent: 0,
    });
    assert.deepEqual(
      dropped.effects,
      [
        { type: "refuse", linkId, attempt: A, reason: "drop" },
        { type: "close", linkId },
      ],
      "the server unbinds a joiner that may still be connected",
    );

    const again = update(dropped.state, joined(linkId, A));
    assert.equal(statusOf(again.state, linkId), "connecting", "the same link starts over");
    assert.deepEqual(again.effects, [{ type: "start", linkId, attempt: A, iceServers: [] }]);
  }
});

test("a drop or timeout refuses the attempt that started the connection, not a later joiner", () => {
  const { state: s0, linkId } = withRecipient();
  const connecting = run(s0, joined(linkId, A)).state;
  assert.equal(findRecipient(connecting, linkId)?.attempt, A);
  // B joins while A is still on: B is refused with its own attempt, A stays stored.
  const busy = update(connecting, joined(linkId, B));
  assert.deepEqual(busy.effects, [{ type: "refuse", linkId, attempt: B, reason: "busy" }]);
  assert.equal(findRecipient(busy.state, linkId)?.attempt, A);
  // A late drop of A refuses A, so the server leaves whoever joined since alone.
  for (const type of ["dropped", "timeout"] as const) {
    const ended = update(busy.state, { type, linkId });
    assert.deepEqual(ended.effects, [
      { type: "refuse", linkId, attempt: A, reason: "drop" },
      { type: "close", linkId },
    ]);
    assert.equal(findRecipient(ended.state, linkId)?.attempt, undefined, type);
  }
  // Once A was dropped, B's join starts a connection that stores B.
  const dropped = update(busy.state, { type: "dropped", linkId }).state;
  const next = run(dropped, joined(linkId, B), { type: "dropped", linkId });
  assert.deepEqual(next.effects, [
    { type: "start", linkId, attempt: B, iceServers: [] },
    { type: "refuse", linkId, attempt: B, reason: "drop" },
    { type: "close", linkId },
  ]);
});

test("a channel that does not open in time is dropped and its joiner refused", () => {
  assert.equal(SETUP_TIMEOUT_MS, 20_000);
  const { state: s0, linkId } = withRecipient();
  const connecting = run(s0, joined(linkId, A)).state;
  const result = update(connecting, { type: "timeout", linkId });
  assert.deepEqual(findRecipient(result.state, linkId), findRecipient(s0, linkId));
  assert.deepEqual(result.effects, [
    { type: "refuse", linkId, attempt: A, reason: "drop" },
    { type: "close", linkId },
  ]);

  const again = update(result.state, joined(linkId, A));
  assert.equal(statusOf(again.state, linkId), "connecting", "the real recipient can join");
  assert.deepEqual(again.effects, [{ type: "start", linkId, attempt: A, iceServers: [] }]);
});

test("a timeout after the channel opened is ignored", () => {
  const { state: s0, linkId } = withRecipient();
  const offered = run(s0, joined(linkId, A), { type: "channel-open", linkId }).state;
  const receiving = run(offered, { type: "accepted", linkId }).state;
  const delivered = run(receiving, { type: "receipt", linkId, match: true }).state;
  for (const state of [s0, offered, receiving, delivered]) {
    const result = update(state, { type: "timeout", linkId });
    assert.equal(result.state, state);
    assert.deepEqual(result.effects, []);
  }
});

test("left while connecting returns the recipient to waiting", () => {
  const { state: s0, linkId } = withRecipient();
  const { state } = run(s0, joined(linkId, A));
  const result = update(state, { type: "left", linkId });
  assert.deepEqual(findRecipient(result.state, linkId), findRecipient(s0, linkId));
  assert.deepEqual(result.effects, [{ type: "close", linkId }]);
});

test("server-lost resets connecting recipients without blaming the relay", () => {
  const a = withRecipient("Anna");
  const b = withRecipient("Erik");
  const c = withRecipient("Mia");
  const d = withRecipient("Olle");
  let state = initialSenderState;
  state = run(state, { type: "add", link: a.link, name: "Anna" }).state;
  state = run(state, { type: "add", link: b.link, name: "Erik" }).state;
  state = run(state, { type: "add", link: c.link, name: "Mia" }).state;
  state = run(state, { type: "add", link: d.link, name: "Olle" }).state;
  state = run(state, joined(a.linkId, A, false), joined(b.linkId, A), joined(c.linkId, A), {
    type: "channel-open",
    linkId: c.linkId,
  }).state;
  const offered = findRecipient(state, c.linkId);
  const result = update(state, { type: "server-lost" });
  for (const id of [a.linkId, b.linkId]) {
    const after = findRecipient(result.state, id);
    assert.equal(after?.status, "waiting");
    assert.equal(after?.noRelay, undefined);
  }
  assert.deepEqual(result.effects, [
    { type: "close", linkId: a.linkId },
    { type: "close", linkId: b.linkId },
  ]);
  assert.equal(findRecipient(result.state, c.linkId), offered);
  assert.equal(statusOf(result.state, d.linkId), "waiting");
  assert.equal(update(result.state, { type: "server-lost" }).state, result.state);
});

test("left once the channel is open is ignored; a receipt after it still delivers", () => {
  const { state: s0, linkId } = withRecipient();
  const offered = run(s0, joined(linkId, A), { type: "channel-open", linkId }).state;
  const leftOffered = update(offered, { type: "left", linkId });
  assert.equal(leftOffered.state, offered);
  assert.deepEqual(leftOffered.effects, []);

  const receiving = run(offered, { type: "accepted", linkId }).state;
  const leftReceiving = update(receiving, { type: "left", linkId });
  assert.equal(leftReceiving.state, receiving);
  assert.deepEqual(leftReceiving.effects, []);

  const delivered = update(leftReceiving.state, { type: "receipt", linkId, match: true });
  assert.equal(statusOf(delivered.state, linkId), "delivered");
  assert.deepEqual(delivered.effects, [{ type: "close", linkId }]);

  // A decline that arrives after `left` still counts too.
  const declined = update(leftOffered.state, { type: "declined", linkId });
  assert.equal(statusOf(declined.state, linkId), "declined");
});

test("a decline marks the recipient declined and the next join retries", () => {
  const { state: s0, linkId } = withRecipient();
  const { state } = run(s0, joined(linkId, A), { type: "channel-open", linkId });
  const result = update(state, { type: "declined", linkId });
  assert.equal(statusOf(result.state, linkId), "declined");
  assert.deepEqual(result.effects, [{ type: "close", linkId }]);

  const retry = update(result.state, joined(linkId, B));
  assert.equal(statusOf(retry.state, linkId), "connecting");
  assert.deepEqual(retry.effects, [{ type: "start", linkId, attempt: B, iceServers: [] }]);
});

test("a mismatching receipt fails the transfer and the next join retries", () => {
  const { state: s0, linkId } = withRecipient();
  const { state } = run(
    s0,
    joined(linkId, A),
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
    { type: "progress", linkId, bytesSent: 100 },
  );
  const failed = update(state, { type: "receipt", linkId, match: false });
  const recipient = findRecipient(failed.state, linkId);
  assert.equal(recipient?.status, "failed");
  assert.equal(recipient?.error, CHECKSUM_MISMATCH);
  assert.equal(recipient?.bytesSent, 0);
  assert.deepEqual(failed.effects, [{ type: "close", linkId }]);

  const retry = update(failed.state, joined(linkId, A));
  const retried = findRecipient(retry.state, linkId);
  assert.equal(retried?.status, "connecting");
  assert.equal(retried && "error" in retried, false, "error cleared");
  assert.deepEqual(retry.effects, [{ type: "start", linkId, attempt: A, iceServers: [] }]);
});

test("events that do not fit the current status are ignored", () => {
  const { state: waiting, linkId } = withRecipient();
  const outOfPlace: Exclude<SenderAction, { type: "add" | "server-lost" }>[] = [
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
    { type: "progress", linkId, bytesSent: 10 },
    { type: "receipt", linkId, match: true },
    { type: "dropped", linkId },
    { type: "left", linkId },
    { type: "timeout", linkId },
    { type: "declined", linkId },
  ];
  for (const action of outOfPlace) {
    const result = update(waiting, action);
    assert.equal(result.state, waiting, action.type);
    assert.deepEqual(result.effects, [], action.type);
  }

  const connecting = update(waiting, joined(linkId, A)).state;
  for (const action of [
    { type: "accepted", linkId },
    { type: "declined", linkId },
    { type: "receipt", linkId, match: true },
  ] satisfies SenderAction[]) {
    assert.equal(update(connecting, action).state, connecting, action.type);
  }

  const stranger = createLink(ORIGIN).linkId;
  for (const action of outOfPlace) {
    const result = update(waiting, { ...action, linkId: stranger });
    assert.equal(result.state, waiting);
    assert.deepEqual(result.effects, []);
  }
});

test("path records the current attempt's path through offered, receiving and delivered", () => {
  const { state: s0, linkId } = withRecipient();
  const steps: SenderAction[] = [
    { type: "joined", linkId, attempt: A, iceServers: TURN, turn: true },
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
    { type: "receipt", linkId, match: true },
  ];
  let state = s0;
  for (const [i, step] of steps.entries()) {
    state = update(state, step).state;
    if (i === 0) {
      continue;
    }
    const result = update(state, { type: "path", linkId, attempt: A, path: "relay" });
    assert.equal(findRecipient(result.state, linkId)?.path, "relay", `after ${step.type}`);
    assert.equal(statusOf(result.state, linkId), statusOf(state, linkId), `after ${step.type}`);
    assert.deepEqual(result.effects, []);
  }

  const delivered = run(
    s0,
    ...steps.slice(0, 2),
    { type: "path", linkId, attempt: A, path: "direct" },
    ...steps.slice(2),
  ).state;
  assert.equal(statusOf(delivered, linkId), "delivered");
  assert.equal(findRecipient(delivered, linkId)?.path, "direct", "delivery keeps the path");
});

test("a path for another attempt is ignored", () => {
  const { state: s0, linkId } = withRecipient();
  const offered = run(s0, joined(linkId, B), { type: "channel-open", linkId }).state;
  const late = update(offered, { type: "path", linkId, attempt: A, path: "relay" });
  assert.equal(late.state, offered);
  assert.deepEqual(late.effects, []);

  for (const state of [s0, update(offered, { type: "declined", linkId }).state]) {
    const result = update(state, { type: "path", linkId, attempt: B, path: "relay" });
    assert.equal(result.state, state, "no attempt to match once reset");
  }
});

test("a drop, a decline or a failed receipt clears the path, so the next join starts without one", () => {
  const ends = ["dropped", "declined", "receipt"] as const;
  for (const end of ends) {
    const { state: s0, linkId } = withRecipient();
    const steps: SenderAction[] = [
      joined(linkId, A),
      { type: "channel-open", linkId },
      { type: "path", linkId, attempt: A, path: "stun" },
    ];
    if (end === "receipt") {
      steps.push({ type: "accepted", linkId });
    }
    const withPath = run(s0, ...steps).state;
    assert.equal(findRecipient(withPath, linkId)?.path, "stun", end);
    const action: SenderAction =
      end === "receipt" ? { type: end, linkId, match: false } : { type: end, linkId };
    const ended = update(withPath, action).state;
    const recipient = findRecipient(ended, linkId);
    assert.equal(recipient && "path" in recipient, false, `${end} clears the path`);

    const rejoined = findRecipient(update(ended, joined(linkId, B)).state, linkId);
    assert.equal(rejoined?.status, "connecting", end);
    assert.equal(rejoined && "path" in rejoined, false, `the join after ${end} has no path`);
  }
});

test("an attempt that ends while connecting under a refused relay marks the recipient noRelay", () => {
  for (const end of ["dropped", "timeout", "left"] as const) {
    const { state: s0, linkId } = withRecipient();
    const connecting = run(s0, joined(linkId, A, false)).state;
    assert.equal(findRecipient(connecting, linkId)?.turn, false, end);

    const ended = update(connecting, { type: end, linkId });
    assert.deepEqual(
      findRecipient(ended.state, linkId),
      { ...findRecipient(s0, linkId), noRelay: true },
      end,
    );
    assert.deepEqual(
      ended.effects,
      end === "left"
        ? [{ type: "close", linkId }]
        : [
            { type: "refuse", linkId, attempt: A, reason: "drop" },
            { type: "close", linkId },
          ],
      end,
    );

    const rejoined = update(ended.state, {
      type: "joined",
      linkId,
      attempt: B,
      iceServers: TURN,
      turn: true,
    });
    const recipient = findRecipient(rejoined.state, linkId);
    assert.equal(recipient?.status, "connecting", end);
    assert.equal(recipient?.turn, true, end);
    assert.equal(recipient && "noRelay" in recipient, false, `the join after ${end} clears it`);
  }
});

test("noRelay is not set under an allowed relay, or once the channel opened", () => {
  const cases: Array<{ turn: boolean; steps: Array<"channel-open" | "accepted"> }> = [
    { turn: true, steps: [] },
    { turn: false, steps: ["channel-open"] },
    { turn: false, steps: ["channel-open", "accepted"] },
  ];
  for (const { turn, steps } of cases) {
    const { state: s0, linkId } = withRecipient();
    const { state } = run(s0, joined(linkId, A, turn), ...steps.map((type) => ({ type, linkId })));
    for (const end of ["dropped", "timeout", "left"] as const) {
      const recipient = findRecipient(update(state, { type: end, linkId }).state, linkId);
      assert.equal(recipient && "noRelay" in recipient, false, `${end} after ${steps}, ${turn}`);
    }
  }
});

test("a busy join keeps the relay choice of the attempt in progress", () => {
  const { state: s0, linkId } = withRecipient();
  const { state, effects } = run(s0, joined(linkId, A, false), {
    type: "joined",
    linkId,
    attempt: B,
    iceServers: TURN,
    turn: true,
  });
  assert.deepEqual(effects.at(-1), { type: "refuse", linkId, attempt: B, reason: "busy" });
  assert.equal(findRecipient(state, linkId)?.turn, false);
  assert.equal(
    findRecipient(update(state, { type: "timeout", linkId }).state, linkId)?.noRelay,
    true,
  );
});

test("a relay path under a refused relay ends the attempt like a timeout", () => {
  for (const steps of [["channel-open"], ["channel-open", "accepted"]] as const) {
    const { state: s0, linkId } = withRecipient();
    const { state } = run(s0, joined(linkId, A, false), ...steps.map((type) => ({ type, linkId })));
    const result = update(state, { type: "path", linkId, attempt: A, path: "relay" });
    assert.deepEqual(
      findRecipient(result.state, linkId),
      { ...findRecipient(s0, linkId), noRelay: true },
      `after ${steps}`,
    );
    assert.deepEqual(result.effects, [
      { type: "refuse", linkId, attempt: A, reason: "drop" },
      { type: "close", linkId },
    ]);
  }
});

test("a relay path only records the path when the relay was allowed or the file delivered", () => {
  const { state: s0, linkId } = withRecipient();
  const offered = (turn: boolean) =>
    run(s0, joined(linkId, A, turn), { type: "channel-open", linkId }).state;

  const allowed = update(offered(true), { type: "path", linkId, attempt: A, path: "relay" });
  assert.equal(findRecipient(allowed.state, linkId)?.path, "relay");
  assert.equal(statusOf(allowed.state, linkId), "offered");
  assert.deepEqual(allowed.effects, []);

  for (const path of ["direct", "stun"] as const) {
    const result = update(offered(false), { type: "path", linkId, attempt: A, path });
    assert.equal(findRecipient(result.state, linkId)?.path, path);
    assert.equal(statusOf(result.state, linkId), "offered");
    assert.deepEqual(result.effects, []);
  }

  const delivered = run(
    offered(false),
    { type: "accepted", linkId },
    { type: "receipt", linkId, match: true },
  ).state;
  const late = update(delivered, { type: "path", linkId, attempt: A, path: "relay" });
  assert.equal(statusOf(late.state, linkId), "delivered");
  assert.equal(findRecipient(late.state, linkId)?.path, "relay");
  assert.deepEqual(late.effects, []);

  const stale = update(offered(false), { type: "path", linkId, attempt: B, path: "relay" });
  assert.equal(statusOf(stale.state, linkId), "offered");
  assert.deepEqual(stale.effects, []);
});

test("refusesRelay is true only for a relay path on the active attempt that refused it", () => {
  const { state: s0, linkId } = withRecipient();
  const offered = (turn: boolean) => {
    const found = findRecipient(
      run(s0, joined(linkId, A, turn), { type: "channel-open", linkId }).state,
      linkId,
    );
    assert.ok(found);
    return found;
  };
  const refused = offered(false);
  assert.equal(refusesRelay(refused, A, "relay"), true);
  assert.equal(refusesRelay(refused, A, "direct"), false);
  assert.equal(refusesRelay(refused, A, "stun"), false);
  assert.equal(refusesRelay(offered(true), A, "relay"), false, "relay allowed");
  assert.equal(refusesRelay(refused, B, "relay"), false, "stale attempt");

  const delivered = findRecipient(
    run(
      s0,
      joined(linkId, A, false),
      { type: "channel-open", linkId },
      { type: "accepted", linkId },
      { type: "receipt", linkId, match: true },
    ).state,
    linkId,
  );
  assert.ok(delivered);
  assert.equal(delivered.turn, false);
  assert.equal(refusesRelay(delivered, A, "relay"), false, "delivered");
});

test("remove drops a recipient and closes its connection if active", () => {
  const { state: s0, linkId } = withRecipient();
  const idle = update(s0, { type: "remove", linkId });
  assert.deepEqual(idle.state.recipients, []);
  assert.deepEqual(idle.effects, []);

  const active = update(update(s0, joined(linkId, A)).state, {
    type: "remove",
    linkId,
  });
  assert.deepEqual(active.state.recipients, []);
  assert.deepEqual(active.effects, [{ type: "close", linkId }]);

  const afterRemove = update(idle.state, joined(linkId, A));
  assert.deepEqual(afterRemove.effects, [
    { type: "refuse", linkId, attempt: A, reason: "unknown" },
  ]);
});

test("hostedLinks lists every recipient, delivered ones included", () => {
  const a = createLink(ORIGIN);
  const b = createLink(ORIGIN);
  const { state } = run(
    initialSenderState,
    { type: "add", link: a, name: "Anna" },
    { type: "add", link: b, name: "Erik" },
    joined(a.linkId, A),
    { type: "channel-open", linkId: a.linkId },
    { type: "accepted", linkId: a.linkId },
    { type: "receipt", linkId: a.linkId, match: true },
  );
  assert.equal(statusOf(state, a.linkId), "delivered");
  assert.deepEqual(hostedLinks(state), [a.linkId, b.linkId]);
  assert.deepEqual(hostedLinks(initialSenderState), []);
});

test("effects never contain a recipient name or secret", () => {
  const name = `Anna-${crypto.randomUUID()}`;
  const link = createLink(ORIGIN);
  const { linkId } = link;
  const stranger = createLink(ORIGIN).linkId;
  const { effects } = run(
    initialSenderState,
    { type: "add", link, name },
    joined(stranger, A),
    joined(linkId, A),
    joined(linkId, A),
    { type: "channel-open", linkId },
    { type: "declined", linkId },
    joined(linkId, A),
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
    { type: "dropped", linkId },
    joined(linkId, A),
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
    { type: "receipt", linkId, match: false },
    joined(linkId, A),
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
    { type: "receipt", linkId, match: true },
    joined(linkId, A),
    { type: "remove", linkId },
  );
  assert.ok(effects.length >= 10);
  for (const effect of effects) {
    const text = JSON.stringify(effect);
    assert.ok(!text.includes(name), text);
    assert.ok(!text.includes(link.secret), text);
    assert.ok(!text.includes(link.url), text);
    assert.deepEqual(
      Object.keys(effect).sort(),
      {
        refuse: ["attempt", "linkId", "reason", "type"],
        start: ["attempt", "iceServers", "linkId", "type"],
      }[effect.type as string] ?? ["linkId", "type"],
    );
  }
});

test("add with an email starts its mail at sending and keeps both through attempts", () => {
  const link = createLink(ORIGIN);
  const { linkId } = link;
  const email = "anna@example.se";
  const added = run(initialSenderState, { type: "add", link, name: "Anna", email });
  assert.deepEqual(added.effects, []);
  assert.deepEqual(added.state.recipients, [
    { name: "Anna", ...link, status: "waiting", bytesSent: 0, email, mail: "sending" },
  ]);

  const { state, effects } = run(
    added.state,
    { type: "email", linkId, status: "sent" },
    { type: "joined", linkId, attempt: A, iceServers: [], turn: true },
    { type: "dropped", linkId },
  );
  assert.ok(effects.every((effect) => !JSON.stringify(effect).includes(email)));
  assert.equal(statusOf(state, linkId), "waiting");
  assert.equal(findRecipient(state, linkId)?.email, email);
  assert.equal(findRecipient(state, linkId)?.mail, "sent");
});

test("email keeps the latest status, except that verified stays and a notice reply never replaces a code", () => {
  const link = createLink(ORIGIN);
  const { linkId } = link;
  const added = run(initialSenderState, {
    type: "add",
    link,
    name: "Anna",
    email: "anna@example.se",
  }).state;
  const mailAfter = (...statuses: EmailStatus[]) =>
    findRecipient(
      run(added, ...statuses.map((status): SenderAction => ({ type: "email", linkId, status })))
        .state,
      linkId,
    )?.mail;

  assert.equal(mailAfter("sent", "verifying", "verified"), "verified");
  assert.equal(mailAfter("limit"), "limit");
  assert.equal(
    mailAfter("sent", "verifying", "verified", "verifying"),
    "verified",
    "another browser asking for a code does not hide that someone verified",
  );
  assert.equal(mailAfter("failed", "verifying"), "verifying", "a timed-out notice arrived");
  assert.equal(mailAfter("failed", "verifying", "verified"), "verified");
  for (const late of ["sent", "failed", "limit"] as const) {
    assert.equal(mailAfter("verifying", late), "verifying", `a late ${late} after a code`);
    assert.equal(mailAfter("verifying", "verified", late), "verified", `a late ${late}`);
  }

  const verified = run(added, { type: "email", linkId, status: "verified" }).state;
  const late = update(verified, { type: "email", linkId, status: "verifying" });
  assert.equal(late.state, verified);
  assert.deepEqual(late.effects, []);
});

test("email is ignored for an unknown link and for a recipient without an address", () => {
  const { state, linkId } = withRecipient();
  const plain = update(state, { type: "email", linkId, status: "sent" });
  assert.equal(plain.state, state);
  assert.deepEqual(plain.effects, []);
  assert.equal(findRecipient(state, linkId)?.mail, undefined);

  const stranger = createLink(ORIGIN).linkId;
  const unknown = update(state, { type: "email", linkId: stranger, status: "verified" });
  assert.equal(unknown.state, state);
  assert.deepEqual(unknown.effects, []);
});

test("a mark makes the recipient's link the one the server emailed; a refusal keeps it plain", () => {
  const mark = "MMMMMMMMMMMMMMMMMMMMMM";
  const after = (...actions: Omit<Extract<SenderAction, { type: "email" }>, "linkId">[]) => {
    const link = createLink(ORIGIN);
    const { linkId } = link;
    const { state } = run(
      initialSenderState,
      { type: "add", link, name: "Anna", email: "anna@example.se" },
      ...actions.map((action): SenderAction => ({ ...action, linkId })),
    );
    return { link, recipient: findRecipient(state, linkId) };
  };

  for (const status of ["sent", "failed"] as const) {
    const { link, recipient } = after(
      { type: "email", status, mark },
      { type: "email", status: "verifying" },
    );
    assert.equal(recipient?.mark, mark);
    assert.equal(recipient?.url, `${ORIGIN}/r/${link.linkId}#e.${mark}.${link.secret}`);
    assert.equal(recipient?.mail, "verifying");
  }
  const { link: early, recipient: late } = after(
    { type: "email", status: "verifying" },
    { type: "email", status: "sent", mark },
  );
  assert.equal(late?.mail, "verifying", "the notice reply came after a code");
  assert.equal(late?.url, `${ORIGIN}/r/${early.linkId}#e.${mark}.${early.secret}`);
  for (const status of ["limit", "failed"] as const) {
    const { link, recipient } = after({ type: "email", status });
    assert.equal(recipient?.mark, undefined);
    assert.equal(recipient?.url, link.url);
  }
  const { link, recipient } = after();
  assert.equal(recipient?.url, link.url);
});

test("a verifying or verified reply before the notice reply still counts as bound on server-lost", () => {
  for (const status of ["verifying", "verified"] as const) {
    const link = createLink(ORIGIN);
    const { state } = run(
      initialSenderState,
      { type: "add", link, name: "Anna", email: "anna@example.se" },
      { type: "email", linkId: link.linkId, status },
    );
    const recipient = findRecipient(state, link.linkId);
    assert.equal(recipient?.mark, undefined);
    assert.ok(emailBound(recipient as Recipient));
    assert.ok(unmarked(recipient as Recipient));
    const lost = update(state, { type: "server-lost" }).state;
    assert.deepEqual(hostedLinks(lost), []);
  }
});

test("a failed reply without a mark leaves the plain link hosted", () => {
  const link = createLink(ORIGIN);
  const { state } = run(
    initialSenderState,
    { type: "add", link, name: "Anna", email: "anna@example.se" },
    { type: "email", linkId: link.linkId, status: "failed" },
  );
  assert.ok(!emailBound(findRecipient(state, link.linkId) as Recipient));
  assert.deepEqual(hostedLinks(update(state, { type: "server-lost" }).state), [link.linkId]);
});

test("server-lost unbinds every link the server emailed or may have emailed, and stops hosting it", () => {
  const mark = "MMMMMMMMMMMMMMMMMMMMMM";
  const [plain, sending, sent, limited, receiving] = Array.from({ length: 5 }, () =>
    createLink(ORIGIN),
  ) as [Link, Link, Link, Link, Link];
  const email = "anna@example.se";
  const { state } = run(
    initialSenderState,
    { type: "add", link: plain, name: "Plain" },
    { type: "add", link: sending, name: "Sending", email },
    { type: "add", link: sent, name: "Sent", email },
    { type: "add", link: limited, name: "Limited", email },
    { type: "add", link: receiving, name: "Receiving", email },
    { type: "email", linkId: sent.linkId, status: "sent", mark },
    { type: "email", linkId: limited.linkId, status: "limit" },
    { type: "email", linkId: receiving.linkId, status: "sent", mark },
    joined(receiving.linkId, A),
    { type: "channel-open", linkId: receiving.linkId },
    { type: "accepted", linkId: receiving.linkId },
  );
  const lost = update(state, { type: "server-lost" });
  assert.deepEqual(lost.effects, []);
  const unbound = lost.state.recipients.filter((r) => r.unbound).map((r) => r.linkId);
  assert.deepEqual(unbound, [sending.linkId, sent.linkId, receiving.linkId]);
  assert.deepEqual(hostedLinks(lost.state), [plain.linkId, limited.linkId]);
  assert.equal(statusOf(lost.state, receiving.linkId), "receiving");
  assert.equal(update(lost.state, { type: "server-lost" }).state, lost.state);

  const late = update(lost.state, { type: "email", linkId: sending.linkId, status: "sent", mark });
  assert.equal(late.state, lost.state);
  const removed = run(lost.state, { type: "remove", linkId: sent.linkId }).state;
  assert.deepEqual(hostedLinks(removed), [plain.linkId, limited.linkId]);
});
