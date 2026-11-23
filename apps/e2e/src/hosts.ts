/** Schemes whose URLs never leave the browser. */
const localSchemes = new Set(["data:", "blob:", "about:"]);
/** WebSocket schemes compare as the HTTP scheme they upgrade from. */
const httpScheme: Record<string, string> = { "ws:": "http:", "wss:": "https:" };
const defaultPorts: Record<string, string> = { "http:": "80", "https:": "443" };
/** Names for this machine that count as the same host, but only on a port of the stack. */
const loopbackHosts = new Set(["localhost", "127.0.0.1"]);

interface Endpoint {
  scheme: string;
  host: string;
  port: string;
}

function endpoint(url: URL): Endpoint {
  const scheme = httpScheme[url.protocol] ?? url.protocol;
  return { scheme, host: url.hostname, port: url.port || defaultPorts[scheme] || "" };
}

function sameHost(a: string, b: string): boolean {
  return a === b || (loopbackHosts.has(a) && loopbackHosts.has(b));
}

/**
 * Whether the browser may reach `url`: true only for the exact origins of the running stack
 * (scheme, host and port), or for URLs that stay inside the browser (data:, blob:, about:).
 * `localhost` and `127.0.0.1` are interchangeable on a stack port and nowhere else.
 */
export function isStackHost(url: string, stackOrigins: readonly string[]): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (localSchemes.has(target.protocol)) {
    return true;
  }
  const to = endpoint(target);
  if (!to.port) {
    return false;
  }
  return stackOrigins.some((origin) => {
    const stack = endpoint(new URL(origin));
    return stack.scheme === to.scheme && stack.port === to.port && sameHost(stack.host, to.host);
  });
}

/** Parses the comma-separated `SIGILL_E2E_STACK_ORIGINS` that global setup publishes. */
export function parseStackOrigins(value: string | undefined): string[] {
  const origins = (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map((origin) => new URL(origin).origin);
  if (origins.length === 0) {
    throw new Error(
      "SIGILL_E2E_STACK_ORIGINS is not set. Run the suite through Playwright's global setup.",
    );
  }
  return origins;
}
