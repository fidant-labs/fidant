import assert from "node:assert/strict";
import { test } from "node:test";
import { siteSettings } from "./settings.ts";

const origin = "PUBLIC_ORIGIN must be an https:// origin with no path, like https://fidant.se.";
const ranges = "TRUSTED_PROXIES must be address ranges like 10.0.0.0/24, separated by commas.";

test("serves pages and trusts no proxy when nothing is set", () => {
  const site = siteSettings({});
  assert.equal(site.pages, true);
  assert.equal(site.origin, undefined);
  assert.equal(site.proxies.check("10.0.1.5", "ipv4"), false);
  assert.equal(site.keepAliveMs, undefined);
  assert.deepEqual(site.stun, []);
});

const keepAlive = "HTTP_KEEP_ALIVE_MS must be a whole number of milliseconds from 1000 to 299000.";

test("HTTP_KEEP_ALIVE_MS takes whole milliseconds from 1000 to 299000", () => {
  assert.equal(siteSettings({ HTTP_KEEP_ALIVE_MS: "" }).keepAliveMs, undefined);
  for (const ms of [1000, 125_000, 299_000]) {
    assert.equal(siteSettings({ HTTP_KEEP_ALIVE_MS: String(ms) }).keepAliveMs, ms);
  }
  for (const value of ["abc", "999", "300000", "1e5", " 125000", "125000 ", "-1000", "1000.5"]) {
    assert.throws(() => siteSettings({ HTTP_KEEP_ALIVE_MS: value }), { message: keepAlive }, value);
  }
});

const stun = "STUN_URLS must be 1 to 4 stun: URLs like stun:example.com:3478, separated by commas.";

test("STUN_URLS takes 1 to 4 stun: URLs separated by commas", () => {
  assert.deepEqual(siteSettings({ STUN_URLS: "" }).stun, []);
  assert.deepEqual(
    siteSettings({
      STUN_URLS: "stun:sto.relay.fidant.se:3478, stun:198.51.100.20,stun:[2001:db8::1]:3478",
    }).stun,
    ["stun:sto.relay.fidant.se:3478", "stun:198.51.100.20", "stun:[2001:db8::1]:3478"],
  );
  for (const value of [
    "stun:a,stun:b,stun:c,stun:d,stun:e",
    "turn:a:3478",
    "stun:a,turns:a:443",
    "http://a",
    "stun:",
    "stun:a b",
    "stun:a:0",
    "stun:[::::]",
    "stun:[1]",
    "stun:.",
    "stun:-",
    "stun:a..b",
    "stun:-a.com",
    "stun:a-.com",
    "stun:999.999.999.999",
    "stun:1.2.3",
    "stun:a:65536",
    "stun:a:3478?transport=udp",
    `stun:${"a".repeat(256)}`,
    ",",
    " ",
  ]) {
    assert.throws(() => siteSettings({ STUN_URLS: value }), { message: stun }, value);
  }
});

test("SIGNALING_ONLY=1 turns the pages off and any other value stops the server", () => {
  assert.equal(siteSettings({ SIGNALING_ONLY: "1" }).pages, false);
  assert.equal(siteSettings({ SIGNALING_ONLY: "" }).pages, true);
  for (const value of ["0", "true", "yes", " 1"]) {
    assert.throws(() => siteSettings({ SIGNALING_ONLY: value }), {
      message: "SIGNALING_ONLY must be 1 or unset.",
    });
  }
});

test("PUBLIC_ORIGIN stands alone and must be an https origin with no path", () => {
  assert.equal(siteSettings({ PUBLIC_ORIGIN: "https://fidant.se" }).origin, "https://fidant.se");
  assert.equal(
    siteSettings({ PUBLIC_ORIGIN: "https://localhost:8443" }).origin,
    "https://localhost:8443",
  );
  assert.equal(siteSettings({ PUBLIC_ORIGIN: "" }).origin, undefined);
  for (const value of [
    "http://fidant.se",
    "https://fidant.se/",
    "https://fidant.se/x",
    "https://FIDANT.se",
    "fidant.se",
  ]) {
    assert.throws(() => siteSettings({ PUBLIC_ORIGIN: value }), { message: origin });
  }
});

test("TRUSTED_PROXIES takes address ranges and refuses anything else", () => {
  const { proxies } = siteSettings({ TRUSTED_PROXIES: "10.0.1.0/24, 2001:db8:aa::/48" });
  assert.equal(proxies.check("10.0.1.5", "ipv4"), true);
  assert.equal(proxies.check("10.0.2.5", "ipv4"), false);
  assert.equal(proxies.check("2001:db8:aa::7", "ipv6"), true);
  assert.equal(siteSettings({ TRUSTED_PROXIES: "" }).proxies.check("10.0.1.5", "ipv4"), false);
  for (const value of [
    "10.0.1.0",
    "10.0.1.0/33",
    "10.0.1.0/-1",
    "10.0.1.0/",
    "10.0.1.0/2x",
    "10.0.1.0/24,",
    "10.0.1.0/24,,10.0.2.0/24",
    "10.0.1.0/24 10.0.2.0/24",
    "lb.internal/24",
    "2001:db8::/129",
  ]) {
    assert.throws(() => siteSettings({ TRUSTED_PROXIES: value }), { message: ranges }, value);
  }
});

const loose =
  "TRUSTED_PROXIES ranges must start at their first address, like 10.0.0.0/24, not 10.0.0.5/24.";

test("TRUSTED_PROXIES refuses a range that does not start at its first address", () => {
  for (const value of [
    "10.0.1.0/2",
    "10.0.1.5/24",
    "fd00:1::5/64",
    "::ffff:10.0.0.1/104",
    "10.0.1.0/24,10.0.2.1/24",
  ]) {
    assert.throws(() => siteSettings({ TRUSTED_PROXIES: value }), { message: loose }, value);
  }
  for (const value of [
    "10.0.1.0/24",
    "10.0.1.4/30",
    "10.0.1.5/32",
    "0.0.0.0/0",
    "fd00:1::/64",
    "fd00:1::5/128",
    "::ffff:10.0.0.0/104",
    "FD00:0001::/32",
  ]) {
    assert.doesNotThrow(() => siteSettings({ TRUSTED_PROXIES: value }), value);
  }
});

test("TRUSTED_PROXIES refuses an address with a zone or a prefix too long for it", () => {
  for (const value of ["fe80::%eth0/64", "10.0.0.0/33", "fd00::/129"]) {
    assert.throws(() => siteSettings({ TRUSTED_PROXIES: value }), { message: ranges }, value);
  }
});

test("an IPv6 range trusts its own addresses and not the next network's", () => {
  const { proxies } = siteSettings({ TRUSTED_PROXIES: "fd00:1::/64" });
  assert.equal(proxies.check("fd00:1::9", "ipv6"), true);
  assert.equal(proxies.check("fd00:1:0:1::9", "ipv6"), false);
});
