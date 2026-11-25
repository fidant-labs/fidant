import { BlockList, isIP } from "node:net";

export type SiteSettings = { pages: boolean; origin: string | undefined; proxies: BlockList };

const badOrigin = "PUBLIC_ORIGIN must be an https:// origin with no path, like https://fidant.se.";
const badRanges = "TRUSTED_PROXIES must be address ranges like 10.0.0.0/24, separated by commas.";

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
      if (parts.length !== 2 || !family || !/^\d{1,3}$/.test(parts[1] ?? "")) {
        throw new Error(badRanges);
      }
      try {
        proxies.addSubnet(parts[0] as string, Number(parts[1]), family === 4 ? "ipv4" : "ipv6");
      } catch {
        throw new Error(badRanges);
      }
    }
  }

  return { pages: only !== "1", origin, proxies };
}
