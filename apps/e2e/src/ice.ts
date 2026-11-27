import type { BrowserContext, Page } from "@playwright/test";

/** The fields of a WebRTC stats entry that say which ICE candidate pair carries the transfer. */
export interface IceStat {
  type: string;
  id: string;
  selectedCandidatePairId?: string;
  state?: string;
  nominated?: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
  relayProtocol?: string;
}

/** One peer connection of a page: its last stats snapshot and its local ICE password. */
export interface PeerConnectionRecord {
  stats: IceStat[];
  pwd?: string | undefined;
  /** The type of every local candidate it gathered, kept after ICE drops the candidate. */
  gathered: string[];
  /**
   * Every connection and signaling state change. `pwd` is the password of `currentLocalDescription`,
   * which changes only once a restart's offer and answer are both set (`localDescription` already
   * carries a pending offer's new one).
   */
  events: ConnectionEvent[];
}

export interface ConnectionEvent {
  at: number;
  state: RTCPeerConnectionState;
  signalingState: RTCSignalingState;
  pwd?: string | undefined;
}

type PageGlobals = typeof globalThis & {
  peerConnections?: PeerConnectionRecord[];
  showSaveFilePicker?: unknown;
};

/**
 * Records every peer connection the context's pages open, without changing its configuration.
 * Call it before the page loads the app. It also removes `showSaveFilePicker`, so downloads go
 * through Playwright's download event.
 */
export async function recordPeerConnections(context: BrowserContext): Promise<void> {
  // Serialized into the page: it must not refer to anything outside itself.
  await context.addInitScript(() => {
    const page = globalThis as PageGlobals;
    delete page.showSaveFilePicker;
    const records: PeerConnectionRecord[] = [];
    page.peerConnections = records;
    const keys = [
      "type",
      "id",
      "selectedCandidatePairId",
      "state",
      "nominated",
      "localCandidateId",
      "remoteCandidateId",
      "candidateType",
      "relayProtocol",
    ];
    const Native = globalThis.RTCPeerConnection;
    globalThis.RTCPeerConnection = class extends Native {
      #timer: ReturnType<typeof setInterval> | undefined;
      constructor(config?: RTCConfiguration) {
        super(config);
        const record: PeerConnectionRecord = { stats: [], gathered: [], events: [] };
        records.push(record);
        this.addEventListener("icecandidate", ({ candidate }) => {
          if (candidate?.type) {
            record.gathered.push(candidate.type);
          }
        });
        const snapshot = async () => {
          const stats: IceStat[] = [];
          for (const entry of (await this.getStats()).values()) {
            const kept: Record<string, unknown> = {};
            for (const key of keys) {
              if (entry[key] !== undefined) {
                kept[key] = entry[key];
              }
            }
            stats.push(kept as unknown as IceStat);
          }
          record.stats = stats;
        };
        const note = () =>
          record.events.push({
            at: Date.now(),
            state: this.connectionState,
            signalingState: this.signalingState,
            pwd: /^a=ice-pwd:(\S+)/m.exec(this.currentLocalDescription?.sdp ?? "")?.[1],
          });
        this.addEventListener("signalingstatechange", note);
        this.addEventListener("connectionstatechange", () => {
          note();
          if (this.connectionState === "connected") {
            record.pwd = /^a=ice-pwd:(\S+)/m.exec(this.localDescription?.sdp ?? "")?.[1];
            void snapshot();
            this.#timer ??= setInterval(() => void snapshot().catch(() => {}), 250);
          } else {
            clearInterval(this.#timer);
            this.#timer = undefined;
          }
        });
      }
      override close() {
        clearInterval(this.#timer);
        this.#timer = undefined;
        super.close();
      }
    };
  });
}

/** The peer connections a page recorded through `recordPeerConnections`. */
export function readPeerConnections(page: Page): Promise<PeerConnectionRecord[]> {
  return page.evaluate(() => (globalThis as PageGlobals).peerConnections ?? []);
}

export interface SelectedPair {
  /** Candidate types: host, srflx, prflx or relay. */
  local: string | undefined;
  remote: string | undefined;
  /** How the local relay candidate reaches the TURN server (udp, tcp or tls), if it is one. */
  relayProtocol: string | undefined;
}

/** The candidate pair ICE selected, from one stats snapshot, or undefined if none is. */
export function selectedPair(stats: readonly IceStat[]): SelectedPair | undefined {
  const byId = new Map(stats.map((entry) => [entry.id, entry]));
  const selectedId = stats.find(
    (entry) => entry.type === "transport" && entry.selectedCandidatePairId,
  )?.selectedCandidatePairId;
  const pair =
    (selectedId ? byId.get(selectedId) : undefined) ??
    stats.find(
      (entry) => entry.type === "candidate-pair" && entry.state === "succeeded" && entry.nominated,
    );
  if (!pair) {
    return undefined;
  }
  const local = byId.get(pair.localCandidateId ?? "");
  const remote = byId.get(pair.remoteCandidateId ?? "");
  return {
    local: local?.candidateType,
    remote: remote?.candidateType,
    relayProtocol: local?.relayProtocol,
  };
}
