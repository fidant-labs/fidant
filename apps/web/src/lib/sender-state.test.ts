import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LINKS } from "@sigill/protocol";
import { createLink } from "./link.ts";
import {
  CHECKSUM_MISMATCH,
  findRecipient,
  hostedLinks,
  initialSenderState,
  SETUP_TIMEOUT_MS,
  type SenderAction,
  type SenderEffect,
  type SenderState,
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

  const s1 = update(s0, { type: "joined", linkId, attempt: A, iceServers: TURN });
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
    { type: "joined", linkId, attempt: A, iceServers: [] },
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
    { type: "receipt", linkId, match: true },
  );
  const result = update(state, { type: "joined", linkId, attempt: A, iceServers: [] });
  assert.equal(result.state, state);
  assert.deepEqual(result.effects, [{ type: "refuse", linkId, attempt: A, reason: "used" }]);
});

test("a join while connecting, offered or receiving is refused as busy", () => {
  const { state: s0, linkId } = withRecipient();
  const steps: SenderAction[] = [
    { type: "joined", linkId, attempt: A, iceServers: [] },
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
  ];
  let state = s0;
  for (const step of steps) {
    state = update(state, step).state;
    const result = update(state, { type: "joined", linkId, attempt: B, iceServers: [] });
    assert.equal(result.state, state, `after ${step.type}`);
    assert.deepEqual(result.effects, [{ type: "refuse", linkId, attempt: B, reason: "busy" }]);
  }
});

test("a join for a link ID not on the list is refused as unknown", () => {
  const { state } = withRecipient();
  const stranger = createLink(ORIGIN).linkId;
  const result = update(state, { type: "joined", linkId: stranger, attempt: A, iceServers: [] });
  assert.equal(result.state, state);
  assert.deepEqual(result.effects, [
    { type: "refuse", linkId: stranger, attempt: A, reason: "unknown" },
  ]);
});

test("a drop before delivery returns the recipient to waiting and frees the link", () => {
  for (const reached of ["connecting", "offered", "receiving"] as const) {
    const { state: s0, linkId } = withRecipient();
    const steps: SenderAction[] = [
      { type: "joined", linkId, attempt: A, iceServers: [] },
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
        { type: "refuse", linkId, attempt: A, reason: "busy" },
        { type: "close", linkId },
      ],
      "the server unbinds a joiner that may still be connected",
    );

    const again = update(dropped.state, { type: "joined", linkId, attempt: A, iceServers: [] });
    assert.equal(statusOf(again.state, linkId), "connecting", "the same link starts over");
    assert.deepEqual(again.effects, [{ type: "start", linkId, attempt: A, iceServers: [] }]);
  }
});

test("a drop or timeout refuses the attempt that started the connection, not a later joiner", () => {
  const { state: s0, linkId } = withRecipient();
  const connecting = run(s0, { type: "joined", linkId, attempt: A, iceServers: [] }).state;
  assert.equal(findRecipient(connecting, linkId)?.attempt, A);
  // B joins while A is still on: B is refused with its own attempt, A stays stored.
  const busy = update(connecting, { type: "joined", linkId, attempt: B, iceServers: [] });
  assert.deepEqual(busy.effects, [{ type: "refuse", linkId, attempt: B, reason: "busy" }]);
  assert.equal(findRecipient(busy.state, linkId)?.attempt, A);
  // A late drop of A refuses A, so the server leaves whoever joined since alone.
  for (const type of ["dropped", "timeout"] as const) {
    const ended = update(busy.state, { type, linkId });
    assert.deepEqual(ended.effects, [
      { type: "refuse", linkId, attempt: A, reason: "busy" },
      { type: "close", linkId },
    ]);
    assert.equal(findRecipient(ended.state, linkId)?.attempt, undefined, type);
  }
  // Once A was dropped, B's join starts a connection that stores B.
  const dropped = update(busy.state, { type: "dropped", linkId }).state;
  const next = run(
    dropped,
    { type: "joined", linkId, attempt: B, iceServers: [] },
    { type: "dropped", linkId },
  );
  assert.deepEqual(next.effects, [
    { type: "start", linkId, attempt: B, iceServers: [] },
    { type: "refuse", linkId, attempt: B, reason: "busy" },
    { type: "close", linkId },
  ]);
});

test("a channel that does not open in time is dropped and its joiner refused", () => {
  assert.equal(SETUP_TIMEOUT_MS, 20_000);
  const { state: s0, linkId } = withRecipient();
  const connecting = run(s0, { type: "joined", linkId, attempt: A, iceServers: [] }).state;
  const result = update(connecting, { type: "timeout", linkId });
  assert.deepEqual(findRecipient(result.state, linkId), findRecipient(s0, linkId));
  assert.deepEqual(result.effects, [
    { type: "refuse", linkId, attempt: A, reason: "busy" },
    { type: "close", linkId },
  ]);

  const again = update(result.state, { type: "joined", linkId, attempt: A, iceServers: [] });
  assert.equal(statusOf(again.state, linkId), "connecting", "the real recipient can join");
  assert.deepEqual(again.effects, [{ type: "start", linkId, attempt: A, iceServers: [] }]);
});

test("a timeout after the channel opened is ignored", () => {
  const { state: s0, linkId } = withRecipient();
  const offered = run(
    s0,
    { type: "joined", linkId, attempt: A, iceServers: [] },
    { type: "channel-open", linkId },
  ).state;
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
  const { state } = run(s0, { type: "joined", linkId, attempt: A, iceServers: [] });
  const result = update(state, { type: "left", linkId });
  assert.deepEqual(findRecipient(result.state, linkId), findRecipient(s0, linkId));
  assert.deepEqual(result.effects, [{ type: "close", linkId }]);
});

test("left once the channel is open is ignored; a receipt after it still delivers", () => {
  const { state: s0, linkId } = withRecipient();
  const offered = run(
    s0,
    { type: "joined", linkId, attempt: A, iceServers: [] },
    { type: "channel-open", linkId },
  ).state;
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
  const { state } = run(
    s0,
    { type: "joined", linkId, attempt: A, iceServers: [] },
    { type: "channel-open", linkId },
  );
  const result = update(state, { type: "declined", linkId });
  assert.equal(statusOf(result.state, linkId), "declined");
  assert.deepEqual(result.effects, [{ type: "close", linkId }]);

  const retry = update(result.state, { type: "joined", linkId, attempt: B, iceServers: [] });
  assert.equal(statusOf(retry.state, linkId), "connecting");
  assert.deepEqual(retry.effects, [{ type: "start", linkId, attempt: B, iceServers: [] }]);
});

test("a mismatching receipt fails the transfer and the next join retries", () => {
  const { state: s0, linkId } = withRecipient();
  const { state } = run(
    s0,
    { type: "joined", linkId, attempt: A, iceServers: [] },
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

  const retry = update(failed.state, { type: "joined", linkId, attempt: A, iceServers: [] });
  const retried = findRecipient(retry.state, linkId);
  assert.equal(retried?.status, "connecting");
  assert.equal(retried && "error" in retried, false, "error cleared");
  assert.deepEqual(retry.effects, [{ type: "start", linkId, attempt: A, iceServers: [] }]);
});

test("events that do not fit the current status are ignored", () => {
  const { state: waiting, linkId } = withRecipient();
  const outOfPlace: Exclude<SenderAction, { type: "add" }>[] = [
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

  const connecting = update(waiting, { type: "joined", linkId, attempt: A, iceServers: [] }).state;
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

test("remove drops a recipient and closes its connection if active", () => {
  const { state: s0, linkId } = withRecipient();
  const idle = update(s0, { type: "remove", linkId });
  assert.deepEqual(idle.state.recipients, []);
  assert.deepEqual(idle.effects, []);

  const active = update(update(s0, { type: "joined", linkId, attempt: A, iceServers: [] }).state, {
    type: "remove",
    linkId,
  });
  assert.deepEqual(active.state.recipients, []);
  assert.deepEqual(active.effects, [{ type: "close", linkId }]);

  const afterRemove = update(idle.state, { type: "joined", linkId, attempt: A, iceServers: [] });
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
    { type: "joined", linkId: a.linkId, attempt: A, iceServers: [] },
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
    { type: "joined", linkId: stranger, attempt: A, iceServers: [] },
    { type: "joined", linkId, attempt: A, iceServers: [] },
    { type: "joined", linkId, attempt: A, iceServers: [] },
    { type: "channel-open", linkId },
    { type: "declined", linkId },
    { type: "joined", linkId, attempt: A, iceServers: [] },
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
    { type: "dropped", linkId },
    { type: "joined", linkId, attempt: A, iceServers: [] },
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
    { type: "receipt", linkId, match: false },
    { type: "joined", linkId, attempt: A, iceServers: [] },
    { type: "channel-open", linkId },
    { type: "accepted", linkId },
    { type: "receipt", linkId, match: true },
    { type: "joined", linkId, attempt: A, iceServers: [] },
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
