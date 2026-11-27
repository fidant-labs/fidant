import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ALERT_AFTER_MS, armSound, askToNotify, beep, notify, notifyPermission } from "./notify.ts";

type Shown = { title: string; body: string | undefined };

/** What the last `browser()` saw beyond the text: each notification's option and whether it closed. */
let made: { requireInteraction: boolean | undefined; closed: boolean }[] = [];

/** Installs a fake `Notification` and `document`, and returns what was shown. */
function browser(permission: NotificationPermission, focused: boolean, broken = false): Shown[] {
  const shown: Shown[] = [];
  made = [];
  class Fake {
    static permission = permission;
    static requestPermission = async () => "granted" as const;
    onclick: (() => void) | null = null;
    constructor(title: string, options?: NotificationOptions) {
      if (broken) {
        throw new TypeError("Illegal constructor");
      }
      shown.push({ title, body: options?.body });
      this.seen.requireInteraction = options?.requireInteraction;
      made.push(this.seen);
    }
    seen = { requireInteraction: undefined as boolean | undefined, closed: false };
    close() {
      this.seen.closed = true;
    }
  }
  Object.assign(globalThis, { Notification: Fake, document: { hasFocus: () => focused } });
  return shown;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "Notification");
  Reflect.deleteProperty(globalThis, "document");
});

test("notify shows the notification only when allowed and the page is out of focus", () => {
  const shown = browser("granted", false);
  notify("Delivered", "1 of 2");
  assert.deepEqual(shown, [{ title: "Delivered", body: "1 of 2" }]);

  const focused = browser("granted", true);
  notify("a", "b");
  assert.deepEqual(focused, []);

  const notAllowed = browser("default", false);
  notify("a", "b");
  assert.deepEqual(notAllowed, []);
});

test("notify does nothing without the API or when the constructor throws", () => {
  notify("a", "b");
  const shown = browser("granted", false, true);
  notify("a", "b");
  assert.deepEqual(shown, []);
});

test("notifyPermission says unsupported where a page can't notify", async () => {
  assert.equal(notifyPermission(), "unsupported");
  assert.equal(await askToNotify(), "unsupported");
  browser("default", false, true);
  assert.equal(notifyPermission(), "unsupported");
  browser("default", false);
  assert.equal(notifyPermission(), "default");
  assert.equal(await askToNotify(), "granted");
  browser("denied", false, true);
  assert.equal(notifyPermission(), "denied");
});

test("notify passes requireInteraction through and returns a closer", () => {
  browser("granted", false);
  const close = notify("a", "b", { requireInteraction: true });
  notify("a", "b");
  assert.deepEqual(made, [
    { requireInteraction: true, closed: false },
    { requireInteraction: undefined, closed: false },
  ]);
  close();
  assert.deepEqual(
    made.map((n) => n.closed),
    [true, false],
  );

  // Nothing shown: the closer is still safe to call.
  browser("granted", true);
  notify("a", "b")();
  browser("granted", false, true);
  notify("a", "b")();
  assert.deepEqual(made, []);
});

test("the alerts go off at once, after a minute and after five", () => {
  assert.deepEqual(ALERT_AFTER_MS, [0, 60_000, 300_000]);
});

// The module keeps one audio context, so these steps share it and run in order.
test("beep is silent until armed and running, then plays one 880 Hz tone per count", () => {
  type Tone = { hz: number; gain: number; start: number; stop: number };
  const tones: Tone[] = [];
  const contexts: FakeAudio[] = [];
  class FakeAudio {
    state = "suspended";
    resumed = 0;
    currentTime = 10;
    destination = {};
    constructor() {
      contexts.push(this);
    }
    resume() {
      this.resumed++;
      return Promise.resolve();
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    createOscillator() {
      const tone: Tone = { hz: 0, gain: 0, start: 0, stop: 0 };
      return {
        frequency: {
          set value(hz: number) {
            tone.hz = hz;
          },
        },
        connect(to: { gain: { value: number } }) {
          tone.gain = to.gain.value;
        },
        start(at: number) {
          tone.start = at;
        },
        stop(at: number) {
          tone.stop = at;
          tones.push(tone);
        },
      };
    }
  }

  // No audio API, armed or not.
  armSound();
  beep(1);

  Object.assign(globalThis, { AudioContext: FakeAudio });
  try {
    // Not armed.
    beep(1);
    assert.equal(contexts.length, 0);

    // Armed, but the browser hasn't let it run.
    armSound();
    const [context] = contexts;
    assert.ok(context);
    assert.equal(context.resumed, 1);
    beep(1);
    assert.equal(tones.length, 0);

    // A second click reuses the context and resumes it.
    armSound();
    assert.equal(contexts.length, 1);
    assert.equal(context.resumed, 2);

    context.state = "running";
    const gains: number[] = [];
    for (const times of [1, 2, 3]) {
      tones.length = 0;
      beep(times);
      assert.equal(tones.length, times);
      for (const [i, tone] of tones.entries()) {
        assert.equal(tone.hz, 880);
        assert.ok(tone.start >= 10 && tone.stop > tone.start);
        assert.ok(i === 0 || tone.start > (tones[i - 1]?.stop ?? 0));
      }
      gains.push(tones[0]?.gain ?? 0);
    }
    assert.ok(gains[0] && gains[1] && gains[2] && gains[0] < gains[1] && gains[1] < gains[2]);
    assert.ok(gains[2] <= 1);

    // A context that throws breaks nothing.
    context.createGain = () => {
      throw new Error("gone");
    };
    beep(1);
  } finally {
    Reflect.deleteProperty(globalThis, "AudioContext");
  }
});
