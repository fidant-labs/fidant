const listeningUrl = /https:\/\/localhost:(\d{1,5})(?![\d])/;

function validPort(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536
    ? value
    : undefined;
}

/**
 * Reads the server's listening port from one line of its output.
 * Accepts the JSON event `{"event":"listening","port":N}` and the human banner `https://localhost:N`.
 */
export function parsePort(line: string): number | undefined {
  const text = line.trim();
  if (text.startsWith("{")) {
    try {
      const event: unknown = JSON.parse(text);
      if (typeof event === "object" && event !== null && "event" in event && "port" in event) {
        return event.event === "listening" ? validPort(event.port) : undefined;
      }
    } catch {
      // Not JSON after all. Fall through to the banner form.
    }
  }
  const match = listeningUrl.exec(text);
  return match ? validPort(Number(match[1])) : undefined;
}
