import { createHash } from "node:crypto";

export type Headers = Record<string, string>;

/** What a request record says about the request body. */
export interface RequestBody {
  /** The body as base64, when Playwright exposed it. */
  body?: string;
  /**
   * Set when the request may have had a body that Playwright did not expose, such as a stream.
   * The scan cannot see such a body; the recording proxy of 0001 is the source for those.
   */
  bodyMissing?: true;
}

/**
 * One observed browser event, written as one JSON line. Response bodies are not recorded: data
 * the server sends to the browser is not a leak to infrastructure.
 */
export type ObservationRecord =
  | ({ type: "request"; time: string; method: string; url: string; headers: Headers } & RequestBody)
  | { type: "response"; time: string; url: string; status: number; headers: Headers }
  | { type: "requestfailed"; time: string; url: string; failure: string }
  | { type: "websocket-open"; time: string; url: string }
  | {
      type: "frame-sent" | "frame-received";
      time: string;
      url: string;
      payload: string;
      /** Set when the frame was binary and `payload` holds its bytes as base64. */
      base64?: true;
    }
  | { type: "websocket-close"; time: string; url: string }
  | { type: "console"; time: string; url: string; text: string }
  | BlockedRecord;

export interface BlockedRecord {
  type: "blocked";
  time: string;
  url: string;
  kind: "http" | "websocket";
}

/**
 * Drops the fragment from a URL. Browsers never send it, and FID-21 links carry the key there,
 * so no URL is stored with one.
 */
export function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

const maxSlugText = 80;

/**
 * A directory name for one test: readable words from its title path, plus a short hash of the
 * full path so that tests with similar titles never share a directory.
 */
export function testSlug(titlePath: readonly string[]): string {
  const text = titlePath
    .join(" ")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\.spec\.ts\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxSlugText)
    .replace(/-+$/, "");
  const hash = createHash("sha256").update(JSON.stringify(titlePath)).digest("hex").slice(0, 8);
  return text ? `${text}-${hash}` : hash;
}

/** The parts of Playwright's TestInfo that name a test's observations directory. */
export interface TestIdentity {
  project: { name: string };
  titlePath: readonly string[];
  retry: number;
  repeatEachIndex: number;
}

/**
 * The observations directory name for one run of a test. Retries and repeats get their own
 * directory, so a later attempt never overwrites an earlier one.
 */
export function testDirName(test: TestIdentity): string {
  const path = [test.project.name, ...test.titlePath];
  if (test.repeatEachIndex > 0) {
    path.push(`repeat ${test.repeatEachIndex}`);
  }
  if (test.retry > 0) {
    path.push(`retry ${test.retry}`);
  }
  return testSlug(path);
}

const actorName = /^[a-z][a-z0-9-]{0,31}$/;

/** Actor names become file names, so they are kept to lowercase words. */
export function assertActorName(name: string): void {
  if (!actorName.test(name)) {
    throw new Error(
      `Actor name "${name}" must be lowercase letters, digits and dashes, starting with a letter.`,
    );
  }
}
