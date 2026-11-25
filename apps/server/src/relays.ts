import { createPublicKey, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type IceServer, parseIceServers } from "@sigill/protocol";
import { relaySecret, sealRelaySecret } from "./relay-secret.ts";
import { iceServersFor } from "./turn.ts";
import { turnAllocates } from "./turn-check.ts";

export type Relay = { id: string; urls: string[]; publicKey: string; host: string; port: number };
export type RelayState = { up: boolean; failures: number };

const committedList = fileURLToPath(new URL("../relays.json", import.meta.url));
const defaultMaster = "/var/lib/sigill/relay-master";
const spkiPem = /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/;

function rsaBits(pem: string): number {
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === "rsa" ? (key.asymmetricKeyDetails?.modulusLength ?? 0) : 0;
  } catch {
    return 0;
  }
}

// Messages name a relay by its position only, so nothing read from the file reaches stderr.
function parseRelay(value: unknown, position: number): Relay {
  const relay = `Relay ${position} in the relay list`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${relay} must be an object.`);
  }
  if (Object.keys(value).sort().join() !== "id,publicKey,urls") {
    throw new Error(`${relay} must have exactly id, urls and publicKey.`);
  }
  const { id, urls, publicKey } = value as Record<string, unknown>;
  if (typeof id !== "string" || !/^[a-z][a-z0-9]{1,15}$/.test(id)) {
    throw new Error(
      `${relay} needs an id of 2 to 16 lowercase letters and digits, first a letter.`,
    );
  }
  if (!parseIceServers([{ urls, username: "", credential: "" }])) {
    throw new Error(`${relay} must have 1 to 4 turn:, turns: or stun: URLs.`);
  }
  const target = (urls as string[]).find(
    (url) => url.startsWith("turn:") && url.endsWith("?transport=udp"),
  );
  if (target === undefined) {
    throw new Error(`${relay} needs a turn:<host>:<port>?transport=udp URL to be checked.`);
  }
  if (target.startsWith("turn:[")) {
    throw new Error(`${relay} is checked over IPv4, so its first turn: UDP URL can't be IPv6.`);
  }
  const [, host = "", port = "0"] =
    /^turn:([a-z0-9.-]+):(\d{1,5})\?transport=udp$/i.exec(target) ?? [];
  if (!host || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`${relay} needs a host and a port in its first turn: UDP URL.`);
  }
  if (typeof publicKey !== "string" || !spkiPem.test(publicKey) || rsaBits(publicKey) < 2048) {
    throw new Error(`${relay} needs a publicKey: an RSA key of 2048 bits or more, in SPKI PEM.`);
  }
  return { id, urls: urls as string[], publicKey, host, port: Number(port) };
}

export function parseRelays(text: string): Relay[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The relay list is not valid JSON.");
  }
  if (!Array.isArray(value)) {
    throw new Error("The relay list must be a JSON array.");
  }
  const relays = value.map((entry, index) => parseRelay(entry, index + 1));
  relays.forEach(({ id }, index) => {
    if (relays.findIndex((other) => other.id === id) !== index) {
      throw new Error(`Relay ${index + 1} in the relay list repeats an earlier id.`);
    }
  });
  return relays;
}

// RELAYS_FILE set but empty turns the list off, even on the app box.
export function relayConfig(
  env: Record<string, string | undefined>,
  onBox: boolean,
): { file: string; masterFile: string } | undefined {
  const file = env.RELAYS_FILE === undefined && onBox ? committedList : env.RELAYS_FILE;
  return file ? { file, masterFile: env.RELAY_MASTER_FILE || defaultMaster } : undefined;
}

// Messages never carry the file's content, which is the master or close to it.
export function readOrCreateMaster(file: string): string {
  try {
    writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "EEXIST") {
      throw new Error(`Could not create the relay master file (${code}).`);
    }
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read the relay master file (${(error as NodeJS.ErrnoException).code}).`,
    );
  }
  if (!/^[0-9a-f]{64}\n?$/.test(text)) {
    throw new Error("The relay master file must hold 64 lowercase hex characters.");
  }
  return text.slice(0, 64);
}

export function nextState(state: RelayState, ok: boolean): RelayState {
  if (ok) {
    return { up: true, failures: 0 };
  }
  const failures = state.failures + 1;
  return { up: state.up && failures < 2, failures };
}

/** The relay list in use, or undefined when there is none or it is empty. */
export function loadRelays(
  env: Record<string, string | undefined>,
  onBox: boolean,
): { relays: Relay[]; masterFile: string } | undefined {
  const config = relayConfig(env, onBox);
  if (!config) {
    return undefined;
  }
  let text: string;
  try {
    text = readFileSync(config.file, "utf8");
  } catch (error) {
    throw new Error(`Could not read the relay list (${(error as NodeJS.ErrnoException).code}).`);
  }
  const relays = parseRelays(text);
  return relays.length > 0 ? { relays, masterFile: config.masterFile } : undefined;
}

export type Relays = ReturnType<typeof startRelays>;

/** Checks each relay now and every `intervalMs`, and offers the first one up in list order. */
export function startRelays(
  relays: Relay[],
  master: string,
  {
    check = (relay: Relay) => turnAllocates(relay.host, relay.port, relaySecret(master, relay.id)),
    intervalMs = 60_000,
  }: { check?: (relay: Relay) => Promise<boolean>; intervalMs?: number } = {},
) {
  const down: RelayState = { up: false, failures: 0 };
  const entries = relays.map((relay) => {
    const secret = relaySecret(master, relay.id);
    const sealed = sealRelaySecret(relay.publicKey, secret);
    return { relay, ice: { urls: relay.urls, secret }, sealed, state: down, checking: false };
  });
  const checkAll = () => {
    for (const entry of entries) {
      if (entry.checking) {
        continue;
      }
      entry.checking = true;
      void Promise.resolve()
        .then(() => check(entry.relay))
        .catch(() => false)
        .then((ok) => {
          entry.state = nextState(entry.state, ok);
          entry.checking = false;
        });
    }
  };
  checkAll();
  const timer = setInterval(checkAll, intervalMs).unref();
  return {
    /** The first relay up, or STUN only from the first relay listed when none is. */
    ice(turn: boolean): IceServer[] {
      const up = entries.find((entry) => entry.state.up);
      return iceServersFor((up ?? entries[0])?.ice, Date.now(), turn && up !== undefined);
    },
    status: () => entries.map(({ relay, state }) => ({ id: relay.id, up: state.up })),
    handOut: (id: string) => entries.find((entry) => entry.relay.id === id)?.sealed,
    stop: () => clearInterval(timer),
  };
}
