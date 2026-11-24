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
    "/etc/haproxy/haproxy.cfg",
    "/etc/sigill/turn-secret",
    "/etc/systemd/journald.conf.d/zz-retention.conf",
    "/etc/systemd/system/coturn.service.d/online.conf",
    "/etc/systemd/system/sigill.service",
    "/etc/systemd/system/sigill.service.d/e2e.conf",
    "/etc/systemd/system/sigill.service.d/turn.conf",
    "/etc/turnserver.conf",
  ]);
  assert.equal(files.get("/etc/sigill/turn-secret")?.mode, 0o600);
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
  const turn = files.get("/etc/systemd/system/sigill.service.d/turn.conf")?.content ?? "";
  assert.match(turn, /^Environment=TURN_URLS=stun:turn\.fidant\.se:3478,turn:turn\.fidant\.se/m);
  assert.doesNotMatch(turn, /\$/);
  const conf = files.get("/etc/turnserver.conf")?.content ?? "";
  assert.match(conf, /\nrelay-ip=192\.0\.2\.30\nstatic-auth-secret=s3cret\n$/);
  assert.doesNotMatch(conf, /external-ip/);
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

test("the box image has the Lightsail blueprint's Ubuntu and the server container's node", () => {
  const dockerfile = readFileSync(
    new URL("../../networks/box/Dockerfile", import.meta.url),
    "utf8",
  );
  const infra = readFileSync(new URL("../../../infra/src/box.ts", import.meta.url), "utf8");
  const blueprint = /blueprintId: "ubuntu_(\d+)_(\d+)"/.exec(infra);
  assert.ok(blueprint, "apps/infra/src/box.ts has no Ubuntu blueprintId");
  assert.match(
    dockerfile,
    new RegExp(`^FROM ubuntu:${blueprint[1]}\\.${blueprint[2]}@sha256:`, "m"),
  );
  assert.ok(dockerfile.includes(`\nCOPY --from=${serverImage} /usr/local/bin/node `));
});
