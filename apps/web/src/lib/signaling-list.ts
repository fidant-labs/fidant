const ID = /^[a-z][a-z0-9]{1,15}$/;

function refuse(reason: string): never {
  throw new Error(`The signaling list ${reason}`);
}

function usableUrl(value: unknown): value is string {
  try {
    return typeof value === "string" && value === `wss://${new URL(value).host}/signal`;
  } catch {
    return false;
  }
}

/** The first entry's address, after refusing any list a page could not use. */
export function signalingUrlFrom(text: string): string {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return refuse("is not valid JSON.");
  }
  if (!Array.isArray(list) || list.length === 0) {
    return refuse("must be a non-empty array.");
  }
  const ids = new Set<string>();
  for (const entry of list) {
    const keys =
      typeof entry === "object" && entry !== null ? Object.keys(entry).sort().join() : "";
    if (keys !== "id,url") {
      return refuse("entries must have exactly an id and a url.");
    }
    if (typeof entry.id !== "string" || !ID.test(entry.id)) {
      return refuse("has an invalid id.");
    }
    if (ids.has(entry.id)) {
      return refuse("repeats an id.");
    }
    ids.add(entry.id);
    if (!usableUrl(entry.url)) {
      return refuse("has a url that is not a plain wss:// /signal url.");
    }
  }
  return list[0].url;
}

/** The address the build named, or the signaling endpoint of the host that served the page. */
export function signalingUrl(built: string | undefined, host: string): string {
  return built ? built : `wss://${host}/signal`;
}
