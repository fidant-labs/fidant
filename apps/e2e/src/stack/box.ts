// ponytail: relative import, not a workspace dependency, which would pull aws-cdk-lib into e2e.
import { renderUserData } from "../../../infra/src/user-data.ts";

export type BoxFile = { content: string; mode: number };

/** Path → body of every `cat >path <<'EOF'` or `cat >>path <<EOF` block in a shell script. */
export function heredocs(text: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const match of text.matchAll(/^[ \t]*cat >>?(\S+) <<(?:'EOF'|EOF)\n([\s\S]*?)^EOF$/gm)) {
    files.set(match[1] as string, match[2] as string);
  }
  return files;
}

/**
 * The files the box container needs, built from the rendered user data, with the modes the
 * user data gives them. Differences from production: Caddy uses its own CA (offline), coturn
 * has no external-ip and relays from `ip` (the container sits on the public network itself), coturn's TLS pair is the
 * run's own certificate (`turnCert`) in place of the one sigill-turn-cert copies from Caddy, and
 * two test-only files.
 */
export function boxFiles({
  ip,
  secret,
  turnCert,
}: {
  /** The container's address, for coturn's relay-ip, which production sets to its private one. */
  ip: string;
  secret: string;
  /** PEM certificate and key for turn.fidant.se, which the browsers trust by public key. */
  turnCert: { cert: string; key: string };
}): Map<string, BoxFile> {
  const userData = renderUserData();
  const docs = heredocs(userData);
  const doc = (path: string) => {
    const body = docs.get(path);
    if (body === undefined) {
      throw new Error(`The box's user data has no heredoc for ${path}`);
    }
    return body;
  };
  const turnUrls = /^turn_urls="([^"$]+)"$/m.exec(userData)?.[1];
  if (turnUrls === undefined) {
    throw new Error("The box's user data has no turn_urls line");
  }
  const caddyfile = doc("/etc/caddy/Caddyfile");
  if (!caddyfile.startsWith("{\n")) {
    throw new Error("The box's Caddyfile does not start with a global options block");
  }
  const turnserverConf = doc("/etc/turnserver.conf");
  const certPath = /^cert=(\S+)$/m.exec(turnserverConf)?.[1];
  const keyPath = /^pkey=(\S+)$/m.exec(turnserverConf)?.[1];
  if (certPath === undefined || keyPath === undefined) {
    throw new Error("The box's turnserver.conf names no cert or pkey");
  }
  const unit = "/etc/systemd/system/sigill.service";
  return new Map([
    [
      "/etc/systemd/journald.conf.d/zz-retention.conf",
      { content: doc("/etc/systemd/journald.conf.d/zz-retention.conf"), mode: 0o644 },
    ],
    [unit, { content: doc(unit), mode: 0o644 }],
    [
      "/etc/caddy/Caddyfile",
      {
        content: caddyfile.replace("{\n", "{\n\tlocal_certs\n\tskip_install_trust\n"),
        mode: 0o644,
      },
    ],
    // Production empties the package's default file before appending, so this is all of it.
    // The container must give it group turnserver, as `install -g turnserver` does.
    [
      "/etc/turnserver.conf",
      {
        content: `${turnserverConf}relay-ip=${ip}\nstatic-auth-secret=${secret}\n`,
        mode: 0o640,
      },
    ],
    ["/etc/haproxy/haproxy.cfg", { content: doc("/etc/haproxy/haproxy.cfg"), mode: 0o644 }],
    // ponytail: the pair is in place from boot, as if sigill-turn-cert had run, so its script and
    // timer are left out. A test that waits for the timer to copy Caddy's local-CA certificate,
    // with Chrome trusting that CA, would exercise them. The Dockerfile gives the key to turnserver.
    [certPath, { content: turnCert.cert, mode: 0o644 }],
    [keyPath, { content: turnCert.key, mode: 0o600 }],
    [
      "/etc/systemd/system/coturn.service.d/online.conf",
      { content: doc("/etc/systemd/system/coturn.service.d/online.conf"), mode: 0o644 },
    ],
    [
      `${unit}.d/turn.conf`,
      { content: doc(`${unit}.d/turn.conf`).replaceAll("$turn_urls", turnUrls), mode: 0o644 },
    ],
    ["/etc/sigill/turn-secret", { content: `${secret}\n`, mode: 0o600 }],
    // RELAYS_FILE set but empty keeps the box on its own coturn, whatever relays.json lists.
    [
      `${unit}.d/e2e.conf`,
      {
        content:
          "[Service]\nEnvironment=CERT_DIR=/var/lib/sigill/certs\nEnvironment=RELAYS_FILE=\n",
        mode: 0o644,
      },
    ],
  ]);
}

/**
 * Reads `systemd-analyze cat-config systemd/journald.conf`: the `# /path` header of every file
 * it printed, and each `[Journal]` key's value, where the last one read wins as in journald.
 */
export function winningJournald(catConfig: string): {
  files: string[];
  settings: Map<string, string>;
} {
  const files: string[] = [];
  const settings = new Map<string, string>();
  let journal = false;
  for (const raw of catConfig.split("\n")) {
    const line = raw.trim();
    const header = /^# (\/\S+)$/.exec(line);
    if (header) {
      files.push(header[1] as string);
    } else if (line.startsWith("[")) {
      journal = line === "[Journal]";
    } else if (journal && line.includes("=") && !/^[#;]/.test(line)) {
      const at = line.indexOf("=");
      settings.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }
  return { files, settings };
}
