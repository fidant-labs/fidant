// Incoming data channel messages, decrypted one at a time in arrival order.
//
// Frame readers assign sequence numbers per call, so decrypts must not
// overlap. Both the sender (ACCEPT, RECEIPT) and the recipient (META, CHUNK,
// END) read their frames through an inbox.
//
// Every message is held until next() or takeRaw() hands it out, so a peer
// that ignores flow control could fill memory. An inbox holds at most
// `maxHeld` messages (raw, waiting to decrypt, or decrypted) and fails for
// good on the next one, dropping it.

import type { Frame, FrameReader } from "./frames.ts";

/** The part of a data channel an inbox listens to. */
export type MessageSource = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type Inbox = {
  /**
   * The next message that arrived before start(), undecrypted. The recipient
   * uses it for the plaintext INIT frame. Rejects on abort or a text message.
   */
  takeRaw(): Promise<Uint8Array<ArrayBuffer>>;
  /** Starts decrypting with `reader`. Messages that arrived earlier are queued, not lost. */
  start(reader: FrameReader): void;
  /** The next decrypted frame. Rejects on abort or on any bad frame. */
  next(): Promise<Frame>;
  /** Rejects with the inbox's first failure, even while nobody calls next(). */
  readonly failed: Promise<never>;
  stop(): void;
};

type Waiter<T> = { resolve(value: T): void; reject(error: unknown): void };

/**
 * Decrypts incoming messages one at a time, in arrival order, and hands them
 * out through next(). The first failure is permanent.
 */
export function createInbox(channel: MessageSource, signal: AbortSignal, maxHeld: number): Inbox {
  const frames: Frame[] = [];
  const raw: unknown[] = [];
  let held = 0;
  let rejectFailed: (error: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    rejectFailed = reject;
  });
  failed.catch(() => {});
  let reader: FrameReader | undefined;
  let waiter: Waiter<Frame> | undefined;
  let rawWaiter: Waiter<Uint8Array<ArrayBuffer>> | undefined;
  let failure: { error: unknown } | undefined;
  let queue: Promise<void> = Promise.resolve();

  const fail = (error: unknown) => {
    if (failure) {
      return;
    }
    failure = { error };
    raw.length = 0;
    frames.length = 0;
    rejectFailed(error);
    waiter?.reject(error);
    waiter = undefined;
    rawWaiter?.reject(error);
    rawWaiter = undefined;
  };
  const onAbort = () => fail(signal.reason);

  const toBytes = (data: unknown): Uint8Array<ArrayBuffer> => {
    if (!(data instanceof ArrayBuffer)) {
      throw new Error("unexpected text message");
    }
    return new Uint8Array(data);
  };

  const enqueue = (data: unknown) => {
    queue = queue
      .then(async () => {
        if (failure || !reader) {
          return;
        }
        const frame = await reader.decrypt(toBytes(data));
        if (failure) {
          return;
        }
        if (waiter) {
          const w = waiter;
          waiter = undefined;
          held--;
          w.resolve(frame);
        } else {
          frames.push(frame);
        }
      })
      .catch(fail);
  };

  const giveRaw = (data: unknown, to: Waiter<Uint8Array<ArrayBuffer>>) => {
    held--;
    try {
      to.resolve(toBytes(data));
    } catch (error) {
      fail(error);
      to.reject(error);
    }
  };

  const onMessage = (event: Event) => {
    if (failure) {
      return;
    }
    if (++held > maxHeld) {
      fail(new Error("peer exceeded the frame window"));
      return;
    }
    const { data } = event as MessageEvent;
    if (reader) {
      enqueue(data);
    } else if (rawWaiter) {
      const w = rawWaiter;
      rawWaiter = undefined;
      giveRaw(data, w);
    } else {
      raw.push(data);
    }
  };

  channel.addEventListener("message", onMessage);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }

  return {
    takeRaw() {
      if (failure) {
        return Promise.reject(failure.error);
      }
      if (reader) {
        return Promise.reject(new Error("inbox already started"));
      }
      return new Promise((resolve, reject) => {
        const waiting = { resolve, reject };
        if (raw.length > 0) {
          giveRaw(raw.shift(), waiting);
        } else {
          rawWaiter = waiting;
        }
      });
    },
    start(next) {
      reader = next;
      for (const data of raw.splice(0)) {
        enqueue(data);
      }
    },
    next() {
      if (failure) {
        return Promise.reject(failure.error);
      }
      const frame = frames.shift();
      if (frame) {
        held--;
        return Promise.resolve(frame);
      }
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    failed,
    stop() {
      channel.removeEventListener("message", onMessage);
      signal.removeEventListener("abort", onAbort);
      fail(new Error("inbox stopped"));
    },
  };
}
