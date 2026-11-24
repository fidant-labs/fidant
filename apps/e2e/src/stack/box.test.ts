import assert from "node:assert/strict";
import { test } from "node:test";
import { renderUserData } from "../../../infra/src/user-data.ts";
import { boxFiles, heredocs, winningJournald } from "./box.ts";

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
  const files = boxFiles({ secret: "s3cret" });
  assert.deepEqual([...files.keys()].sort(), [
    "/etc/caddy/Caddyfile",
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
});

test("the Caddyfile differs from the rendered one only by Caddy's own CA", () => {
  const rendered = heredocs(renderUserData()).get("/etc/caddy/Caddyfile")?.split("\n");
  const lines = boxFiles({ secret: "s" }).get("/etc/caddy/Caddyfile")?.content.split("\n");
  const added = ["\tlocal_certs", "\tskip_install_trust"];
  assert.deepEqual(
    lines?.filter((line) => !added.includes(line)),
    rendered,
  );
  assert.deepEqual(lines?.slice(0, 3), ["{", ...added]);
});

test("turn.conf names the rendered TURN URLs and turnserver.conf the secret", () => {
  const files = boxFiles({ secret: "s3cret" });
  const turn = files.get("/etc/systemd/system/sigill.service.d/turn.conf")?.content ?? "";
  assert.match(turn, /^Environment=TURN_URLS=stun:turn\.fidant\.se:3478,turn:turn\.fidant\.se/m);
  assert.doesNotMatch(turn, /\$/);
  const conf = files.get("/etc/turnserver.conf")?.content ?? "";
  assert.match(conf, /\nstatic-auth-secret=s3cret\n$/);
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
