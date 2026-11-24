// What the server has, as data. The text for it lives under `server` in the dictionaries.

export type Relayed = { readonly messages: number; readonly bytes: number };

export const NO_RELAYS: Relayed = { messages: 0, bytes: 0 };

export function addRelay(relayed: Relayed, bytes: number): Relayed {
  return { messages: relayed.messages + 1, bytes: relayed.bytes + bytes };
}

/** How the recipient page stands with the server. */
export type Tie = "paired" | "unpaired" | "closed";

/** What the page shares. `unknown` is a recipient page before the offer arrives. */
export type Kind = "file" | "secret" | "unknown";
