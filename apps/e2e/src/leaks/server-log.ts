import { ERROR_CODES, REFUSE_REASONS, UPGRADE_REJECT_REASONS } from "@sigill/protocol";

/**
 * The values server stdout may carry (0001, "Server stdout"). Every field is an enum value, a
 * 6-character link prefix or a count, so no free text can reach the log.
 */
export interface LogAllowlist {
  events: ReadonlySet<string>;
  reasons: ReadonlySet<string>;
  codes: ReadonlySet<string>;
}

/** The rule a log line breaks. */
export type LogRule =
  | "json"
  | "object"
  | "key"
  | "event"
  | "link"
  | "links"
  | "bytes"
  | "port"
  | "reason"
  | "code";

export interface LogViolation {
  /** 1-based, as editors count. */
  line: number;
  rule: LogRule;
  /** What is wrong, such as `unknown key "name"`. */
  message: string;
  /**
   * The start of the line. Violations are printed in public CI logs, so the excerpt is cut short;
   * any canary in it is a throwaway test value.
   */
  excerpt: string;
}

/**
 * The allowlist for today's server. Reasons and codes come from @sigill/protocol, so a new enum
 * value there is allowed here too. Protocol does not export the event names (the server passes
 * them as strings to its logger), so they are listed here; a new event needs a reviewed change.
 */
export const serverLogAllowlist: LogAllowlist = {
  events: new Set([
    "listening",
    "upgrade-rejected",
    "bad-message",
    "error",
    "host",
    "host-gone",
    "host-closed",
    "joined",
    "refused",
    "relay",
    "relay-dropped",
    "left",
  ]),
  // LogReason in @sigill/protocol.
  reasons: new Set<string>([...REFUSE_REASONS, ...UPGRADE_REJECT_REASONS]),
  codes: new Set<string>(ERROR_CODES),
};

const excerptLength = 120;
const linkPattern = /^[A-Za-z0-9_-]{6}$/;
const counts = ["links", "bytes", "port"] as const;
const allowedKeys = new Set(["event", "link", "reason", "code", ...counts]);

/**
 * Checks server stdout line by line: each non-empty line is one JSON object with only the
 * allowed keys, and each value is an allowed enum value, a link prefix or a non-negative integer.
 * Reports every broken rule; an empty result means the log is clean.
 */
export function checkServerLog(lines: string[], allowlist: LogAllowlist): LogViolation[] {
  const violations: LogViolation[] = [];
  lines.forEach((text, index) => {
    if (text.trim() === "") {
      return;
    }
    const report = (rule: LogRule, message: string) =>
      violations.push({ line: index + 1, rule, message, excerpt: excerpt(text) });
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      report("json", "not JSON");
      return;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      report("object", "not a JSON object");
      return;
    }
    const fields = entry as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (!allowedKeys.has(key)) {
        report("key", `unknown key ${quote(key)}`);
      }
    }
    const { event, link, reason, code } = fields;
    if (typeof event !== "string" || !allowlist.events.has(event)) {
      report("event", event === undefined ? "no event" : `unknown event ${quote(event)}`);
    }
    if ("link" in fields && (typeof link !== "string" || !linkPattern.test(link))) {
      report("link", "link is not a 6-character link prefix");
    }
    for (const key of counts) {
      const value = fields[key];
      if (key in fields && !(Number.isSafeInteger(value) && (value as number) >= 0)) {
        report(key, `${key} is not a non-negative integer`);
      }
    }
    if ("reason" in fields && (typeof reason !== "string" || !allowlist.reasons.has(reason))) {
      report("reason", `unknown reason ${quote(reason)}`);
    }
    if ("code" in fields && (typeof code !== "string" || !allowlist.codes.has(code))) {
      report("code", `unknown code ${quote(code)}`);
    }
  });
  return violations;
}

/** One line per violation, `<location>: <rule>: <message>: <excerpt>`, for test failures and logs. */
export function formatLogViolation(violation: LogViolation, location: string): string {
  return `${location}: ${violation.rule}: ${violation.message}: ${violation.excerpt}`;
}

function excerpt(text: string): string {
  return text.length > excerptLength ? `${text.slice(0, excerptLength)}…` : text;
}

/** A value for a message, cut short like the excerpt. */
function quote(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
