import assert from "node:assert/strict";
import { test } from "node:test";
import { type IceStat, selectedPair } from "./ice.ts";

const candidates: IceStat[] = [
  { type: "local-candidate", id: "L1", candidateType: "host" },
  { type: "local-candidate", id: "L2", candidateType: "relay", relayProtocol: "tcp" },
  { type: "remote-candidate", id: "R1", candidateType: "srflx" },
  { type: "remote-candidate", id: "R2", candidateType: "prflx" },
];

test("follows the transport's selected candidate pair", () => {
  const stats: IceStat[] = [
    ...candidates,
    // A nominated pair that is not the selected one must not win.
    {
      type: "candidate-pair",
      id: "P1",
      state: "succeeded",
      nominated: true,
      localCandidateId: "L1",
      remoteCandidateId: "R1",
    },
    { type: "candidate-pair", id: "P2", localCandidateId: "L2", remoteCandidateId: "R2" },
    { type: "transport", id: "T", selectedCandidatePairId: "P2" },
  ];
  assert.deepEqual(selectedPair(stats), { local: "relay", remote: "prflx", relayProtocol: "tcp" });
});

test("falls back to a succeeded, nominated pair", () => {
  const stats: IceStat[] = [
    ...candidates,
    {
      type: "candidate-pair",
      id: "P1",
      state: "in-progress",
      nominated: true,
      localCandidateId: "L2",
      remoteCandidateId: "R2",
    },
    {
      type: "candidate-pair",
      id: "P2",
      state: "succeeded",
      nominated: true,
      localCandidateId: "L1",
      remoteCandidateId: "R1",
    },
    { type: "transport", id: "T" },
  ];
  assert.deepEqual(selectedPair(stats), {
    local: "host",
    remote: "srflx",
    relayProtocol: undefined,
  });
});

test("is undefined when no pair is selected", () => {
  const stats: IceStat[] = [
    ...candidates,
    { type: "candidate-pair", id: "P1", state: "succeeded", nominated: false },
    { type: "transport", id: "T" },
  ];
  assert.equal(selectedPair(stats), undefined);
  assert.equal(selectedPair([]), undefined);
});
