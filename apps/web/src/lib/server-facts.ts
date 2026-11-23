import type { LogFields } from "@sigill/protocol";
import { formatBytes } from "./format.ts";

export type Relayed = { readonly messages: number; readonly bytes: number };

export const NO_RELAYS: Relayed = { messages: 0, bytes: 0 };

export function addRelay(relayed: Relayed, bytes: number): Relayed {
  return { messages: relayed.messages + 1, bytes: relayed.bytes + bytes };
}

export function passedOn(relayed: Relayed): string {
  if (relayed.messages === 0) {
    return "Nothing yet.";
  }
  const noun = relayed.messages === 1 ? "setup message" : "setup messages";
  return `${relayed.messages} ${noun} (${formatBytes(relayed.bytes)}), all encrypted so the server can't read them.`;
}

export function senderHolds(state: { online: boolean; links: number; connected: number }): string {
  if (!state.online) {
    return "Nothing once it notices the connection has closed. That takes up to a minute if the network dropped.";
  }
  if (state.links === 0) {
    return "No links yet.";
  }
  const ids =
    state.links === 1
      ? "The ID of your link, never the part that unlocks the file."
      : `The IDs of your ${state.links} links, never the part that unlocks the file.`;
  if (state.connected === 0) {
    return ids;
  }
  const who = state.connected === 1 ? "1 recipient" : `${state.connected} recipients`;
  return `${ids} ${who} connected right now.`;
}

export type Tie = "paired" | "unpaired" | "closed";

export function recipientHolds(tie: Tie): string {
  switch (tie) {
    case "paired":
      return "The ID of your link, never the part that unlocks the file, and that this page is connected to the sender.";
    case "unpaired":
      return "Nothing that ties this page to your link. Only the sender's page can keep your link's ID there.";
    case "closed":
      return "Nothing about this page once it notices the connection has closed, which takes up to a minute if the network dropped. Only the sender's page can keep your link's ID there.";
  }
}

export const LOG_FIELD_PHRASES = {
  link: "the first 6 characters of a link ID",
  links: "how many links a sender has",
  bytes: "message sizes",
  reason: "why a link or connection was refused",
  code: "error codes",
  port: "the port it listens on",
} satisfies Record<keyof LogFields, string>;

const phrases = new Intl.ListFormat("en", { type: "conjunction" }).format(
  Object.values(LOG_FIELD_PHRASES),
);

export const LOGS = `What happened, like a link being opened, with ${phrases}. Never names, keys, file data or IP addresses.`;

export const SEES_SENDER =
  "Your IP address and the usual browser details any website gets, and the same for each recipient when they open their link.";
export const SEES_RECIPIENT = "Your IP address and the usual browser details any website gets.";
export const FILE_DATA = "None. The file goes directly between browsers.";
export const AFTERWARDS_SENDER =
  "When you close this tab, the server forgets your links, within a minute at most. Its log lines stay.";
export const AFTERWARDS_RECIPIENT =
  "When this page disconnects, the server drops what it has about this page, within a minute at most. Its log lines stay.";
