import { BlockList, isIP } from "node:net";

export type SiteSettings = { pages: boolean; origin: string | undefined; proxies: BlockList };

const badOrigin = "PUBLIC_ORIGIN must be an https:// origin with no path, like https://fidant.se.";
const badRanges = "TRUSTED_PROXIES must be address ranges like 10.0.0.0/24, separated by commas.";

const badLoose =
  "TRUSTED_PROXIES ranges must start at their first address, like 10.0.0.0/24, not 10.0.0.5/24.";

function toNumber(address: string, family: number): bigint {
  if (family === 4) {
    return address.split(".").reduce((n, octet) => (n << 8n) | BigInt(octet), 0n);
  }
  const host = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const [head = "", tail] = host.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n);
}

export function siteSettings(env: Record<string, string | undefined>): SiteSettings {
  const only = env.SIGNALING_ONLY;
  if (only && only !== "1") {
    throw new Error("SIGNALING_ONLY must be 1 or unset.");
  }

  const origin = env.PUBLIC_ORIGIN || undefined;
  if (origin !== undefined) {
    const parsed = URL.parse(origin);
    if (parsed?.protocol !== "https:" || parsed.origin !== origin) {
      throw new Error(badOrigin);
    }
  }

  const proxies = new BlockList();
  if (env.TRUSTED_PROXIES) {
    for (const entry of env.TRUSTED_PROXIES.split(",")) {
      const parts = entry.trim().split("/");
      const family = isIP(parts[0] ?? "");
      if (
        parts.length !== 2 ||
        !family ||
        entry.includes("%") ||
        !/^\d{1,3}$/.test(parts[1] ?? "")
      ) {
        throw new Error(badRanges);
      }
      const address = parts[0] as string;
      const prefix = Number(parts[1]);
      try {
        proxies.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
      } catch {
        throw new Error(badRanges);
      }
      const hostBits = BigInt((family === 4 ? 32 : 128) - prefix);
      if (toNumber(address, family) & ((1n << hostBits) - 1n)) {
        throw new Error(badLoose);
      }
    }
  }

  return { pages: only !== "1", origin, proxies };
}
