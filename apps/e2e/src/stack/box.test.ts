import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderUserData } from "../../../infra/src/user-data.ts";
import { boxFiles, heredocs, winningJournald } from "./box.ts";
import { serverImage } from "./networks.ts";

const turnCert = { cert: "CERT", key: "KEY" };

test("heredocs reads quoted and unquoted, writing and appending blocks", () => {
  const script = [
    "cat >/a <<'EOF'",
    "one $x",
    "EOF",
    "  cat >>/b <<EOF",
    "two",
    "three",
    "EOF",
    "cat >/c <<'END'",
    "skipped",
    "END",
  ].join("\n");
  assert.deepEqual(
    heredocs(script),
    new Map([
      ["/a", "one $x\n"],
      ["/b", "two\nthree\n"],
    ]),
  );
});

test("boxFiles builds every file the box container needs", () => {
  const files = boxFiles({ ip: "192.0.2.30", secret: "s3cret", turnCert });
  assert.deepEqual([...files.keys()].sort(), [
    "/etc/caddy/Caddyfile",
    "/etc/coturn/turn.crt",
    "/etc/coturn/turn.key",
    "/etc/fidant/turn-secret",
    "/etc/haproxy/haproxy.cfg",
    "/etc/systemd/journald.conf.d/zz-retention.conf",
    "/etc/systemd/system/coturn.service.d/online.conf",
    "/etc/systemd/system/fidant.service",
    "/etc/systemd/system/fidant.service.d/e2e.conf",
    "/etc/systemd/system/fidant.service.d/turn.conf",
    "/etc/turnserver.conf",
  ]);
  assert.equal(files.get("/etc/fidant/turn-secret")?.mode, 0o600);
  assert.equal(files.get("/etc/turnserver.conf")?.mode, 0o640);
  assert.equal(files.get("/etc/coturn/turn.key")?.content, "KEY");
  assert.equal(files.get("/etc/coturn/turn.key")?.mode, 0o600);
});

test("the Caddyfile differs from the rendered one only by Caddy's own CA", () => {
  const rendered = heredocs(renderUserData()).get("/etc/caddy/Caddyfile")?.split("\n");
  const lines = boxFiles({ ip: "192.0.2.30", secret: "s", turnCert })
    .get("/etc/caddy/Caddyfile")
    ?.content.split("\n");
  const added = ["\tlocal_certs", "\tskip_install_trust"];
  assert.deepEqual(
    lines?.filter((line) => !added.includes(line)),
    rendered,
  );
  assert.deepEqual(lines?.slice(0, 3), ["{", ...added]);
});

test("turn.conf names the rendered TURN URLs and turnserver.conf the secret", () => {
  const files = boxFiles({ ip: "192.0.2.30", secret: "s3cret", turnCert });
  const turn = files.get("/etc/systemd/system/fidant.service.d/turn.conf")?.content ?? "";
  assert.match(turn, /^Environment=TURN_URLS=stun:turn\.fidant\.se:3478,turn:turn\.fidant\.se/m);
  assert.doesNotMatch(turn, /\$/);
  const conf = files.get("/etc/turnserver.conf")?.content ?? "";
  assert.match(conf, /\nrelay-ip=192\.0\.2\.30\nstatic-auth-secret=s3cret\n$/);
  assert.doesNotMatch(conf, /external-ip/);
});

test("e2e.conf turns the relay list off, so the box keeps its own coturn", () => {
  const files = boxFiles({ ip: "192.0.2.30", secret: "s3cret", turnCert });
  const conf = files.get("/etc/systemd/system/fidant.service.d/e2e.conf")?.content ?? "";
  assert.match(conf, /^Environment=RELAYS_FILE=$/m);
});

test("winningJournald takes the last value read and lists the files", () => {
  const output = [
    "# /etc/systemd/journald.conf",
    "[Journal]",
    "#ForwardToSyslog=no",
    "MaxFileSec=1month",
    "",
    "# /usr/lib/systemd/journald.conf.d/syslog.conf",
    "[Journal]",
    "ForwardToSyslog=yes",
    "",
    "# /etc/systemd/journald.conf.d/zz-retention.conf",
    "[Journal]",
    "ForwardToSyslog=no",
    "MaxFileSec=1day",
    "[Other]",
    "MaxFileSec=9day",
  ].join("\n");
  const { files, settings } = winningJournald(output);
  assert.deepEqual(files, [
    "/etc/systemd/journald.conf",
    "/usr/lib/systemd/journald.conf.d/syslog.conf",
    "/etc/systemd/journald.conf.d/zz-retention.conf",
  ]);
  assert.deepEqual(
    settings,
    new Map([
      ["MaxFileSec", "1day"],
      ["ForwardToSyslog", "no"],
    ]),
  );
});

test("the box and relay images use the Lightsail blueprint's Ubuntu, the box .node-version's node", () => {
  const dockerfile = readFileSync(
    new URL("../../networks/box/Dockerfile", import.meta.url),
    "utf8",
  );
  const infra = readFileSync(new URL("../../../infra/src/box.ts", import.meta.url), "utf8");
  const blueprint = /blueprintId: "ubuntu_(\d+)_(\d+)"/.exec(infra);
  assert.ok(blueprint, "apps/infra/src/box.ts has no Ubuntu blueprintId");
  const relay = readFileSync(new URL("../../networks/relay/Dockerfile", import.meta.url), "utf8");
  for (const file of [dockerfile, relay]) {
    assert.match(file, new RegExp(`^FROM ubuntu:${blueprint[1]}\\.${blueprint[2]}@sha256:`, "m"));
  }
  const nodeVersion = readFileSync(new URL("../../../../.node-version", import.meta.url), "utf8");
  assert.match(
    serverImage,
    new RegExp(`^node:${nodeVersion.trim()}\\.[\\w.-]+@sha256:[0-9a-f]{64}$`),
  );
  assert.ok(dockerfile.includes("\nCOPY --from=node /usr/local/bin/node "));
});
