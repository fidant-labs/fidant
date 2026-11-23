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
    return "Nothing now. It forgot your links when the connection to it closed.";
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

export function recipientHolds(active: boolean): string {
  return active
    ? "The ID of your link, never the part that unlocks the file, and that you're connected to the sender."
    : "Nothing now. It forgot your link when this page disconnected from it.";
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
  "When you close this tab, the server forgets your links. Its log lines stay.";
export const AFTERWARDS_RECIPIENT =
  "The server forgets your link as soon as this page disconnects from it. Its log lines stay.";
