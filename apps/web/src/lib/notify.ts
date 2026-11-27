// Browser notifications and a beep that tell the sender a link has delivered
// or needs an answer.
//
// A notification leaves the page: the operating system shows it and can keep
// it in its notification list, and some systems mirror that list to other
// devices. So callers pass only fixed text and counts, never a file name, a
// recipient's name, a link or a key.

const api = () => (typeof Notification === "undefined" ? undefined : Notification);

/** Where the page stands with notifications; "default" means asking is worth it. */
export function notifyPermission(): NotificationPermission | "unsupported" {
  const N = api();
  if (!N) {
    return "unsupported";
  }
  if (N.permission === "default") {
    // Chrome on Android has `Notification` but its constructor throws, because a page there
    // needs a service worker to notify. Without permission this shows nothing anywhere.
    try {
      new N("").close();
    } catch {
      return "unsupported";
    }
  }
  return N.permission;
}

/** Asks the browser for permission. Call it from a click. */
export async function askToNotify(): Promise<NotificationPermission | "unsupported"> {
  const N = api();
  if (!N) {
    return "unsupported";
  }
  try {
    return await N.requestPermission();
  } catch {
    return N.permission;
  }
}

/** When the alerts for one open question go off, counted from when it shows. */
export const ALERT_AFTER_MS = [0, 60_000, 300_000];

/**
 * Shows a notification if the sender allowed it and isn't looking at the page.
 * Clicking it brings the page back. Returns a function that closes it.
 */
export function notify(
  title: string,
  body: string,
  options?: { requireInteraction?: boolean },
): () => void {
  const N = api();
  if (N?.permission !== "granted" || document.hasFocus()) {
    return () => {};
  }
  try {
    const notification = new N(title, { body, ...options });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return () => {
      try {
        notification.close();
      } catch {
        // Already gone.
      }
    };
  } catch {
    // What it tells is on the page; a notification is only a nudge.
    return () => {};
  }
}

let audio: AudioContext | undefined;

/**
 * Makes the page able to beep later, from a timer. Call it from a click:
 * browsers keep an audio context silent until the user has acted on the page.
 */
export function armSound(): void {
  try {
    if (typeof AudioContext === "undefined") {
      return;
    }
    audio ??= new AudioContext();
    audio.resume().catch(() => {});
  } catch {
    // No sound; the page still shows what the beep would have pointed at.
  }
}

/** Plays `times` short tones, louder the more there are. Silent unless `armSound` worked. */
export function beep(times: number): void {
  if (audio?.state !== "running") {
    return;
  }
  try {
    const gain = audio.createGain();
    gain.gain.value = Math.min(1, 0.2 * times);
    gain.connect(audio.destination);
    for (let i = 0; i < times; i++) {
      const tone = audio.createOscillator();
      tone.frequency.value = 880;
      tone.connect(gain);
      const at = audio.currentTime + i * 0.3;
      tone.start(at);
      tone.stop(at + 0.15);
    }
  } catch {
    // As in armSound.
  }
}
