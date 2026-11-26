import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { addStacks } from "./app.ts";
import {
  boxAddress,
  hostedZoneIds,
  mailFrom,
  relayAddresses,
  relays,
  siteNames,
  zoneNames,
} from "./config.ts";
import { DnsStack } from "./dns.ts";
import { metricLine, overageLine, statusLines } from "./relay-cap/cap.mts";
import { renderRelayUserData, renderUserData } from "./user-data.ts";

const account = "111111111111";
const dnsAccount = "222222222222";
const pocAccount = "333333333333";

const dns = Template.fromStack(
  new DnsStack(new App(), "Dns", {
    env: { account, region: "eu-north-1" },
    mail: {
      apexTxt: ["verify=1", "v=spf1 include:mail.example ~all"],
      mx: [{ priority: 10, hostName: "mx.example" }],
      cnames: [{ name: "key._domainkey", value: "key.example" }],
      dmarc: "v=DMARC1; p=quarantine",
    },
    boxAddress: "192.0.2.10",
    relayAddresses: { sto: "198.51.100.7" },
  }),
);

function zoneRef(zoneName: string): { Ref: string } {
  const [id] = Object.entries(dns.findResources("AWS::Route53::HostedZone")).find(
    ([, zone]) => zone.Properties.Name === `${zoneName}.`,
  ) ?? [""];
  return { Ref: id };
}

function stacksFor(currentAccount: string | undefined): Stack[] {
  const app = new App();
  addStacks(app, {
    CDK_DEFAULT_ACCOUNT: currentAccount,
    FIDANT_DNS_ACCOUNT: dnsAccount,
    FIDANT_POC_ACCOUNT: pocAccount,
  });
  return app.node.children.filter((child) => child instanceof Stack);
}

test("the fidant-dns account gets the protected DNS and DNSSEC stacks and the CI stack", () => {
  const stacks = stacksFor(dnsAccount);
  assert.deepEqual(
    stacks.map((stack) => [stack.stackName, stack.region, stack.terminationProtection]),
    [
      ["FidantDns", "eu-north-1", true],
      ["FidantCi", "eu-north-1", false],
      ["FidantDnssec", "us-east-1", true],
    ],
  );
});

test("the committed config names the hosted zone that FidantDnssec signs for every zone", () => {
  assert.deepEqual(Object.keys(hostedZoneIds), zoneNames);
  for (const id of Object.values(hostedZoneIds)) {
    assert.match(id, /^Z[0-9A-Z]{10,32}$/);
  }
});

test("the fidant-poc account gets the CI, app box and certificate stacks", () => {
  const stacks = stacksFor(pocAccount);
  assert.deepEqual(
    stacks.map((stack) => [stack.stackName, stack.region]),
    [
      ["FidantCi", "eu-north-1"],
      ["FidantApp", "eu-north-1"],
      ["FidantPagesCerts", "us-east-1"],
      ["FidantSignalCerts", "eu-north-1"],
    ],
  );
});

test("no stack depends on or imports from another, so deploying one never deploys another", () => {
  for (const currentAccount of [dnsAccount, pocAccount]) {
    const app = new App();
    addStacks(app, {
      CDK_DEFAULT_ACCOUNT: currentAccount,
      FIDANT_DNS_ACCOUNT: dnsAccount,
      FIDANT_POC_ACCOUNT: pocAccount,
    });
    const assembly = app.synth();
    for (const stack of app.node.children.filter((child) => child instanceof Stack)) {
      assert.deepEqual(stack.dependencies, [], stack.stackName);
      const template = JSON.stringify(assembly.getStackByName(stack.stackName).template);
      assert.doesNotMatch(template, /Fn::ImportValue/, stack.stackName);
    }
  }
});

test("the certificate stacks request DNS-validated certificates, with no zone, outputs or other resources", () => {
  for (const [stackName, names] of [
    ["FidantPagesCerts", zoneNames.map((zone) => [zone, `www.${zone}`])],
    ["FidantSignalCerts", [["sto.signal.fidant.se"]]],
  ] as const) {
    const stack = stacksFor(pocAccount).find((child) => child.stackName === stackName);
    const template = Template.fromStack(stack as Stack).toJSON();
    assert.equal(template.Outputs, undefined, stackName);
    assert.deepEqual(
      Object.values(template.Resources),
      names.map(([domainName, ...others]) => ({
        Type: "AWS::CertificateManager::Certificate",
        Properties: {
          DomainName: domainName,
          ...(others.length > 0 ? { SubjectAlternativeNames: others } : {}),
          Tags: [{ Key: "Name", Value: `${stackName}/${domainName}` }],
          ValidationMethod: "DNS",
        },
      })),
    );
  }
});

function ciTemplate(currentAccount: string): Template {
  const stack = stacksFor(currentAccount).find((child) => child.stackName === "FidantCi");
  return Template.fromStack(stack as Stack);
}

function roleNamed(ci: Template, roleName: string) {
  const [role, ...others] = Object.entries(
    ci.findResources("AWS::IAM::Role", { Properties: { RoleName: roleName } }),
  );
  assert.ok(role && others.length === 0, roleName);
  return role;
}

function roleStatements(ci: Template, roleId: string) {
  const policies = Object.values(ci.findResources("AWS::IAM::Policy")).filter((policy) =>
    policy.Properties.Roles.some((role: { Ref: string }) => role.Ref === roleId),
  );
  assert.equal(policies.length, 1, roleId);
  assert.deepEqual(policies[0]?.Properties.Roles, [{ Ref: roleId }]);
  return policies[0]?.Properties.PolicyDocument.Statement;
}

test("only this repository's production environment can assume the CI role", () => {
  for (const [currentAccount, roles] of [
    [dnsAccount, 1],
    [pocAccount, 2],
  ] as const) {
    const ci = ciTemplate(currentAccount);
    ci.resourceCountIs("AWS::IAM::Role", roles);
    ci.hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIdList: ["sts.amazonaws.com"],
    });
    const [providerId] = Object.keys(ci.findResources("AWS::IAM::OIDCProvider"));
    const [, role] = roleNamed(ci, "fidant-ci-deploy");
    assert.deepEqual(role.Properties.AssumeRolePolicyDocument.Statement, [
      {
        Action: "sts:AssumeRoleWithWebIdentity",
        Effect: "Allow",
        Principal: { Federated: { Ref: providerId } },
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub":
              "repo:sigill-labs@360211033/sigill@1468787132:environment:production",
          },
        },
      },
    ]);
  }
});

test("the CI role may only assume its own account's CDK bootstrap roles", () => {
  const ci = ciTemplate(pocAccount);
  const [roleId, role] = roleNamed(ci, "fidant-ci-deploy");
  assert.equal(role.Properties.ManagedPolicyArns, undefined);
  assert.equal(role.Properties.Policies, undefined);
  assert.deepEqual(roleStatements(ci, roleId), [
    {
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Resource: `arn:aws:iam::${pocAccount}:role/cdk-hnb659fds-*`,
    },
  ]);
});

test("only the app environment can assume the release role, which only fidant-poc has", () => {
  assert.doesNotMatch(JSON.stringify(ciTemplate(dnsAccount).toJSON()), /fidant-release|:app"/);
  const ci = ciTemplate(pocAccount);
  ci.resourceCountIs("AWS::IAM::ManagedPolicy", 0);
  const [providerId] = Object.keys(ci.findResources("AWS::IAM::OIDCProvider"));
  const [, role] = roleNamed(ci, "fidant-release");
  assert.deepEqual(role.Properties, {
    RoleName: "fidant-release",
    MaxSessionDuration: 7200,
    AssumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRoleWithWebIdentity",
          Effect: "Allow",
          Principal: { Federated: { Ref: providerId } },
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub":
                "repo:sigill-labs@360211033/sigill@1468787132:environment:app",
            },
          },
        },
      ],
    },
  });
});

test("the release role may only push the one image, move its tags, redeploy the one service and write the one bucket", () => {
  const ci = ciTemplate(pocAccount);
  const [roleId] = roleNamed(ci, "fidant-release");
  assert.deepEqual(roleStatements(ci, roleId), [
    { Action: "ecr:GetAuthorizationToken", Effect: "Allow", Resource: "*" },
    {
      Action: [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
      ],
      Effect: "Allow",
      Resource: `arn:aws:ecr:eu-north-1:${pocAccount}:repository/fidant-signal`,
    },
    {
      Action: ["ecs:DescribeServices", "ecs:UpdateService"],
      Effect: "Allow",
      Resource: `arn:aws:ecs:eu-north-1:${pocAccount}:service/fidant/fidant-signal`,
    },
    {
      Action: "ecs:UpdateService",
      Effect: "Deny",
      Resource: "*",
      Condition: { StringEquals: { "ecs:enable-execute-command": "true" } },
    },
    {
      Action: "s3:PutObject",
      Effect: "Allow",
      Resource: `arn:aws:s3:::fidant-pages-${pocAccount}/*`,
      Condition: { StringEquals: { "s3:ResourceAccount": pocAccount } },
    },
  ]);
});

test("any other account gets no stacks", () => {
  assert.throws(() => stacksFor(account), /neither FIDANT_DNS_ACCOUNT nor FIDANT_POC_ACCOUNT/);
  assert.throws(() => stacksFor(undefined), /aws sso login/);
  assert.throws(
    () => addStacks(new App(), { CDK_DEFAULT_ACCOUNT: dnsAccount }),
    /FIDANT_DNS_ACCOUNT and FIDANT_POC_ACCOUNT/,
  );
});

const recordSet = "AWS::Route53::RecordSet";
const committed = Template.fromStack(stacksFor(dnsAccount)[0] as Stack);

test("the committed config points every site name and the relay at the box, over IPv4 only", () => {
  assert.equal(isIP(boxAddress), 4);
  for (const [name, ttl] of [
    ...siteNames.map((site) => [site, "60"]),
    ["turn.fidant.se", "1800"],
  ]) {
    committed.hasResourceProperties(recordSet, {
      Name: `${name}.`,
      Type: "A",
      ResourceRecords: [boxAddress],
      TTL: ttl,
    });
    committed.resourcePropertiesCountIs(recordSet, { Name: `${name}.`, Type: "AAAA" }, 0);
  }
  committed.hasResourceProperties(recordSet, {
    Name: "sto.relay.fidant.se.",
    Type: "A",
    TTL: "1800",
  });
});

test("the app box is open only on 80, 443 and the relay's ports, and on 22 only to Lightsail's browser SSH", () => {
  const box = appBox();
  const [instanceId, instance] = instanceNamed(box, "^fidant-app-");
  assert.deepEqual(instance?.Properties.Networking.Ports, [
    { Protocol: "tcp", FromPort: 80, ToPort: 80, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "tcp", FromPort: 443, ToPort: 443, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "tcp", FromPort: 22, ToPort: 22, CidrListAliases: ["lightsail-connect"] },
    { Protocol: "tcp", FromPort: 3478, ToPort: 3478, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "udp", FromPort: 3478, ToPort: 3478, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "udp", FromPort: 49152, ToPort: 65535, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
  ]);
  box.hasResource("AWS::Lightsail::StaticIp", {
    DeletionPolicy: "Retain",
    Properties: { StaticIpName: "fidant-app-ip", AttachedTo: { Ref: instanceId } },
  });
  assert.match(instance?.Properties.InstanceName, /^fidant-app-[0-9a-f]{8}$/);
  assert.equal(instance?.Properties.UserData, renderUserData());
  assert.match(instance?.Properties.UserData, /^fidant\.se \{$/m);
  assert.match(
    instance?.Properties.UserData,
    /^www\.fidant\.se, fidant\.eu, www\.fidant\.eu, fidant\.org, www\.fidant\.org \{\n\timport hsts\n\tredir https:\/\/fidant\.se\{uri\} permanent$/m,
  );
  assert.doesNotMatch(instance?.Properties.UserData, /@[A-Z_]+@/);
  const topLevel = String(instance?.Properties.UserData).split("<<'EOF'")[0] ?? "";
  assert.match(topLevel, /^#!\/bin\/sh\n.*\nset -eux\n/);
  assert.doesNotMatch(topLevel, /pipefail|\[\[/);
});

test("FidantApp has a Stockholm relay box apart from the app box", () => {
  const box = appBox();
  assert.equal(Object.keys(box.findResources("AWS::Lightsail::Instance")).length, 2);
  const [, relay] = instanceNamed(box, "^fidant-relay-sto-[0-9a-f]{8}$");
  const userData = renderRelayUserData({ id: "sto" });
  assert.equal(relay.Properties.UserData, userData);
  assert.equal(
    relay.Properties.InstanceName,
    `fidant-relay-sto-${createHash("sha256").update(userData).digest("hex").slice(0, 8)}`,
  );
  assert.equal(relay.Properties.BundleId, "micro_3_0");
  assert.equal(relay.Properties.BlueprintId, "ubuntu_24_04");
  assert.equal(relay.Properties.AvailabilityZone, "eu-north-1a");
  assert.deepEqual(relay.Properties.Networking.Ports, [
    { Protocol: "tcp", FromPort: 22, ToPort: 22, CidrListAliases: ["lightsail-connect"] },
    { Protocol: "tcp", FromPort: 80, ToPort: 80, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "tcp", FromPort: 443, ToPort: 443, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "tcp", FromPort: 3478, ToPort: 3478, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "udp", FromPort: 3478, ToPort: 3478, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "udp", FromPort: 49152, ToPort: 65535, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
  ]);
});

test("the relay box's static IP is retained, attached to it, and output as RelayStoIp", () => {
  const box = appBox();
  const [relayId] = instanceNamed(box, "^fidant-relay-sto-");
  const ips = Object.keys(
    box.findResources("AWS::Lightsail::StaticIp", {
      DeletionPolicy: "Retain",
      Properties: { StaticIpName: "fidant-relay-sto-ip", AttachedTo: { Ref: relayId } },
    }),
  );
  assert.equal(ips.length, 1);
  assert.deepEqual(box.toJSON().Outputs.RelayStoIp, {
    Value: { "Fn::GetAtt": [ips[0], "IpAddress"] },
  });
});

test("relay user data sets the relay's inputs, carries no secret and fits Lightsail's limit", () => {
  const userData = renderRelayUserData({ id: "sto" });
  const script = readFileSync(new URL("../relay/install.sh", import.meta.url), "utf8");
  assert.match(
    userData,
    /^#!\/bin\/sh\nRELAY_ID=sto\nRELAY_NAME=sto\.relay\.fidant\.se\nAPP_URL=https:\/\/fidant\.se\nexport RELAY_ID RELAY_NAME APP_URL\n/,
  );
  assert.ok(userData.endsWith(script.slice(script.indexOf("\n"))));
  assert.doesNotMatch(userData, /static-auth-secret=|BEGIN [A-Z ]*PRIVATE KEY/);
  assert.equal(spawnSync("/bin/sh", ["-n"], { input: userData }).status, 0);
  assert.ok(Buffer.byteLength(userData) < 16 * 1024);
});

test("the relay keeps the app box's coturn hardening and peer denials, and no static secret", () => {
  const deny = (lines: string[]) => lines.filter((line) => line.startsWith("denied-peer-ip="));
  const userData = renderRelayUserData({ id: "sto" });
  const start = userData.indexOf('\ncat >>"$tmp" <<EOF\n');
  assert.ok(start > 0);
  assert.doesNotMatch(userData, /turnserver\.conf\.(?!XXXXXX)[A-Za-z]/);
  const relay = userData.slice(start, userData.indexOf("\nEOF\n", start)).split("\n").slice(2);
  const box = readFileSync(new URL("../box/turnserver.conf", import.meta.url), "utf8").split("\n");
  assert.equal(deny(box).length, 13);
  assert.deepEqual(deny(relay), deny(box));
  const siteSpecific = /^(#|$|listening-port=|tls-listening-port=|realm=|cert=|pkey=)/;
  const hardening = box.filter((line) => !siteSpecific.test(line));
  assert.equal(hardening.length, 24);
  const relayOnly = /^(userdb=|relay-ip=|tls-listening-port=|realm=|cert=|pkey=)/;
  const shared = relay.filter(
    (line) => !/^(#|$|listening-port=)/.test(line) && !relayOnly.test(line),
  );
  assert.deepEqual([...shared].sort(), [...hardening].sort());
  assert.ok(!relay.some((line) => line.startsWith("static-auth-secret")));
});

test("the relay's scripts that handle a secret or a key run with set -eu and never trace", () => {
  const script = readFileSync(new URL("../relay/install.sh", import.meta.url), "utf8");
  for (const name of [
    "fidant-relay-apply-secret",
    "fidant-relay-secret",
    "fidant-relay-cert-installed",
  ]) {
    const start = script.indexOf(`\ncat >/usr/local/bin/${name} <<'EOF'\n`);
    assert.ok(start > 0, name);
    const body = script.slice(
      script.indexOf("\n", start + 1) + 1,
      script.indexOf("\nEOF\n", start),
    );
    assert.match(body, /^#!\/bin\/sh\nset -eu\n/, name);
    assert.doesNotMatch(body, /\bset\b[^\n;]*\s-[a-z]*x|xtrace/, name);
  }
});

// Changing this name rebuilds the relay box, whose new public key must then be committed.
test("the relay box keeps its name", () => {
  const [, relay] = instanceNamed(appBox(), "^fidant-relay-sto-");
  assert.equal(relay.Properties.InstanceName, "fidant-relay-sto-5349646e");
});

test("the app box keeps log lines for at most 30 days, before any service starts logging", () => {
  const [, instance] = instanceNamed(appBox(), "^fidant-app-");
  const userData = String(instance?.Properties.UserData);
  const dropIn = userData.indexOf(
    "\ncat >/etc/systemd/journald.conf.d/zz-retention.conf <<'EOF'\n[Journal]\nMaxRetentionSec=29day\nMaxFileSec=1day\nForwardToSyslog=no\nEOF\nsystemctl restart systemd-journald\n",
  );
  assert.ok(dropIn > 0);
  assert.ok(dropIn < userData.indexOf("\napt-get "));
});

test("the app box runs coturn after the site is up, with a secret that stays on the box", () => {
  const [, instance] = instanceNamed(appBox(), "^fidant-app-");
  const userData = String(instance?.Properties.UserData);
  const lines = userData.split("\n");
  assert.ok(Buffer.byteLength(userData) < 16 * 1024);

  for (const line of [
    "realm=turn.fidant.se",
    "use-auth-secret",
    "log-file=/dev/null",
    "tls-listening-port=5349",
    "cert=/etc/coturn/turn.crt",
    "pkey=/etc/coturn/turn.key",
    "no-dtls",
  ]) {
    assert.ok(lines.includes(line), line);
  }
  assert.ok(!lines.includes("no-tls"));
  assert.ok(userData.includes(`external-ip=${boxAddress}/%s\\nrelay-ip=%s\\n`));
  const denied = lines.filter((line) => line.startsWith("denied-peer-ip="));
  assert.deepEqual(denied, [
    "denied-peer-ip=0.0.0.0-0.255.255.255",
    "denied-peer-ip=10.0.0.0-10.255.255.255",
    "denied-peer-ip=100.64.0.0-100.127.255.255",
    "denied-peer-ip=127.0.0.0-127.255.255.255",
    "denied-peer-ip=169.254.0.0-169.254.255.255",
    "denied-peer-ip=172.16.0.0-172.31.255.255",
    "denied-peer-ip=192.168.0.0-192.168.255.255",
    "denied-peer-ip=::1",
    "denied-peer-ip=::ffff:0.0.0.0-::ffff:255.255.255.255",
    "denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff",
    "denied-peer-ip=2002::-2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  ]);
  assert.ok(denied.every((line) => !line.includes(boxAddress)));

  const caddy = userData.indexOf("\nsystemctl restart caddy\n");
  const mask = userData.indexOf("\nsystemctl mask coturn\n");
  const install = userData.indexOf(" install -y coturn\n");
  const conf = userData.indexOf("\ninstall -m 640 -g turnserver /dev/null /etc/turnserver.conf\n");
  const template = userData.indexOf("\ncat >>/etc/turnserver.conf <<'EOF'\n");
  const secret = userData.indexOf("; cat /etc/sigill/turn-secret; } >>/etc/turnserver.conf\n");
  const online = userData.indexOf(
    "\ncat >/etc/systemd/system/coturn.service.d/online.conf <<'EOF'\n[Unit]\nWants=network-online.target\nAfter=network-online.target\nEOF\n",
  );
  const unmask = userData.indexOf("\nsystemctl unmask coturn\n");
  const enable = userData.indexOf("\nsystemctl enable --now coturn\n");
  const active = userData.indexOf("\nif systemctl is-active --quiet coturn; then\n");
  const dropIn = userData.indexOf("\n  install -d /etc/systemd/system/sigill.service.d\n");
  const fi = userData.indexOf("\nfi\n", active);
  const order = [
    caddy,
    mask,
    install,
    conf,
    template,
    secret,
    online,
    unmask,
    enable,
    active,
    dropIn,
    fi,
  ];
  assert.ok(
    order.every((index) => index > 0),
    order.join(),
  );
  assert.deepEqual(
    order,
    order.toSorted((a, b) => a - b),
  );
  assert.doesNotMatch(userData.slice(0, caddy), /coturn|turn-secret/);

  assert.deepEqual(userData.match(/static-auth-secret=.*/g), [
    'static-auth-secret=\' "$private_ip" "$private_ip"; cat /etc/sigill/turn-secret; } >>/etc/turnserver.conf',
  ]);
  assert.doesNotMatch(userData, /\$\(openssl/);
  assert.deepEqual(userData.match(/.*rand -hex.*/g), [
    "(umask 077 && openssl rand -hex 32 >/etc/sigill/turn-secret)",
  ]);
});

test("the app box stops its boot rather than fall back to Ubuntu's Caddy 2.6", () => {
  const [, instance] = instanceNamed(appBox(), "^fidant-app-");
  const lines = String(instance?.Properties.UserData).split("\n");
  const curls = lines.filter((line) => line.startsWith("curl "));
  assert.equal(curls.length, 3);
  for (const line of curls) {
    assert.match(line, /^curl --retry 5 --retry-all-errors -fsSL/);
  }
  assert.deepEqual(
    lines.filter((line) => / update$/.test(line)),
    ["apt-get -o DPkg::Lock::Timeout=600 -o APT::Update::Error-Mode=any update"],
  );
});

test("the app box routes 443 by SNI to Caddy and to coturn's TLS, and copies Caddy's relay certificate", () => {
  const [, instance] = instanceNamed(appBox(), "^fidant-app-");
  const userData = String(instance?.Properties.UserData);

  assert.ok(
    userData.includes(
      "\tadmin off\n\thttps_port 8444\n\tauto_https disable_redirects\n\tservers :8444 {\n\t\tlistener_wrappers {\n\t\t\tproxy_protocol {\n\t\t\t\tallow 127.0.0.1/32\n\t\t\t}\n\t\t\ttls\n\t\t}\n\t\tprotocols h1 h2\n\t}\n",
    ),
  );
  assert.match(
    userData,
    /\treverse_proxy https:\/\/127\.0\.0\.1:8443 \{\n(?:\t\t#.*\n)*\t\theader_up Host \{host\}\n/,
  );
  assert.ok(userData.includes("\nhttp:// {\n\tredir https://{host}{uri} permanent\n}\n"));
  assert.ok(userData.includes("\nturn.fidant.se {\n\trespond 404\n}\n"));
  assert.ok(userData.includes("[signed-by=/etc/apt/keyrings/caddy-stable.asc]"));

  const haproxyStart = userData.indexOf("\ncat >/etc/haproxy/haproxy.cfg <<'EOF'\n");
  const haproxy = userData.slice(haproxyStart, userData.indexOf("\nEOF\n", haproxyStart));
  assert.doesNotMatch(haproxy, /^\s*log\b/m);
  assert.match(
    haproxy,
    /^global\n(?:\t#.*\n)?\tuser haproxy\n\tgroup haproxy\n\tchroot \/var\/lib\/haproxy\n/m,
  );
  assert.deepEqual(haproxy.match(/^\t(bind|use_backend|default_backend|server) .*/gm), [
    "\tbind :::443 v4v6",
    "\tuse_backend coturn if { req.ssl_sni -i turn.fidant.se } !{ req.ssl_alpn acme-tls/1 }",
    "\tdefault_backend caddy",
    "\tserver coturn 127.0.0.1:5349",
    "\tserver caddy 127.0.0.1:8444 send-proxy-v2",
  ]);
  // Only the relay keeps an idle connection for an hour. One IPv4 address, or one IPv6 /64 as in
  // decision 0006, holds at most 128 connections.
  assert.deepEqual(haproxy.match(/^\t(timeout|stick-table|tcp-request connection) .*/gm), [
    "\ttimeout connect 5s",
    "\ttimeout client 2m",
    "\ttimeout server 2m",
    "\ttimeout client-fin 30s",
    "\ttimeout server-fin 30s",
    "\tstick-table type ipv6 size 100k expire 2m store conn_cur",
    "\ttcp-request connection track-sc0 src,ipmask(32,64)",
    "\ttcp-request connection reject if { sc0_conn_cur gt 128 }",
    "\ttimeout tunnel 1h",
  ]);
  assert.match(haproxy, /^backend coturn\n(?:\t#.*\n)*\ttimeout tunnel 1h\n/m);

  const caddy = userData.indexOf("\nsystemctl restart caddy\n");
  const order = [
    caddy,
    haproxyStart,
    userData.indexOf("\nsystemctl restart haproxy\n"),
    userData.indexOf("\nsystemctl enable --now coturn\n"),
    userData.indexOf("\nsystemctl enable --now sigill-turn-cert.timer\n"),
    userData.indexOf("\nif systemctl is-active --quiet coturn; then\n"),
  ];
  assert.ok(
    order.every((index) => index > 0),
    order.join(),
  );
  assert.deepEqual(
    order,
    order.toSorted((a, b) => a - b),
  );

  assert.ok(userData.includes("\nOnActiveSec=1min\nOnUnitInactiveSec=5min\n"));
  const syncStart = userData.indexOf("\ncat >/usr/local/sbin/sigill-turn-cert <<'EOF'\n");
  const sync = userData.slice(syncStart, userData.indexOf("\nEOF\n", syncStart));
  assert.match(sync, /^set -eu$/m);
  assert.doesNotMatch(sync, /set -[a-z]*x/);
  const syncLines = sync.split("\n");
  const at = (line: string): number => {
    const index = syncLines.indexOf(line);
    assert.ok(index > 0, line);
    return index;
  };
  // Both new files are in place before either replaces the old pair, and they are read with the
  // caddy user's rights, never through a link.
  const steps = [
    "crt=$(ls -t /var/lib/caddy/.local/share/caddy/certificates/*/$name/$name.crt 2>/dev/null | head -n 1)",
    'if [ -n "$crt" ] && ! cmp -s "$crt" /etc/coturn/turn.crt; then',
    '  if [ -L "$crt" ] || [ -L "$key" ]; then',
    "  install -o turnserver -g turnserver -m 600 /dev/null /etc/coturn/turn.key.new",
    '  runuser -u caddy -- cat "$key" >/etc/coturn/turn.key.new',
    "  install -m 644 /dev/null /etc/coturn/turn.crt.new",
    '  runuser -u caddy -- cat "$crt" >/etc/coturn/turn.crt.new',
    "  openssl pkey -pubout -in /etc/coturn/turn.key.new >/etc/coturn/turn.pub.new",
    "  if ! openssl x509 -pubkey -noout -in /etc/coturn/turn.crt.new | cmp -s - /etc/coturn/turn.pub.new; then",
    "  mv /etc/coturn/turn.key.new /etc/coturn/turn.key",
    "  mv /etc/coturn/turn.crt.new /etc/coturn/turn.crt",
    "  if systemctl is-active --quiet coturn; then",
    "      systemctl kill -s USR2 coturn",
    "      systemctl restart coturn",
    "if [ -e /etc/coturn/turn.crt ] && ! openssl x509 -checkend 1209600 -noout -in /etc/coturn/turn.crt >/dev/null; then",
  ].map(at);
  assert.deepEqual(
    steps,
    steps.toSorted((a, b) => a - b),
  );
  assert.equal(
    at("  mv /etc/coturn/turn.crt.new /etc/coturn/turn.crt") -
      at("  mv /etc/coturn/turn.key.new /etc/coturn/turn.key"),
    1,
  );

  assert.match(
    userData,
    /^turn_urls="stun:turn\.fidant\.se:3478,turn:turn\.fidant\.se:3478\?transport=udp,turns:turn\.fidant\.se:443\?transport=tcp"$/m,
  );
  assert.doesNotMatch(userData, /:3478\?transport=tcp/);
});

test("the committed config signs notify.fidant.se's SES mail with three DKIM keys", () => {
  const dkim = Object.values(committed.findResources(recordSet)).filter((r) =>
    String(r.Properties.Name).endsWith("._domainkey.notify.fidant.se."),
  );
  assert.equal(dkim.length, 3);
  for (const record of dkim) {
    assert.equal(record.Properties.Type, "CNAME");
    const [token] = String(record.Properties.Name).split(".");
    assert.match(token ?? "", /^[a-z0-9]{32}$/);
    assert.deepEqual(record.Properties.ResourceRecords, [`${token}.dkim.amazonses.com.`]);
  }
});

test("the committed config keeps fidant.se's Proton mail records", () => {
  for (const value of [
    '^"protonmail-verification=[0-9a-f]{40}"$',
    '^"v=spf1 include:_spf\\.protonmail\\.ch [~-]all"$',
  ]) {
    committed.hasResourceProperties(recordSet, {
      Name: "fidant.se.",
      Type: "TXT",
      ResourceRecords: Match.arrayWith([Match.stringLikeRegexp(value)]),
    });
  }
  committed.hasResourceProperties(recordSet, {
    Name: "fidant.se.",
    Type: "MX",
    ResourceRecords: ["10 mail.protonmail.ch", "20 mailsec.protonmail.ch"],
  });
  for (const key of ["protonmail", "protonmail2", "protonmail3"]) {
    committed.hasResourceProperties(recordSet, {
      Name: `${key}._domainkey.fidant.se.`,
      Type: "CNAME",
      ResourceRecords: [
        Match.stringLikeRegexp(`^${key}\\.domainkey\\.[a-z0-9]+\\.domains\\.proton\\.ch\\.$`),
      ],
    });
  }
  committed.hasResourceProperties(recordSet, {
    Name: "_dmarc.fidant.se.",
    Type: "TXT",
    ResourceRecords: [Match.stringLikeRegexp('^"v=DMARC1; p=reject[;"]')],
  });
});

test("the committed config keeps fidant.se verified in Google Search Console", () => {
  committed.hasResourceProperties(recordSet, {
    Name: "fidant.se.",
    Type: "TXT",
    ResourceRecords: Match.arrayWith([
      Match.stringLikeRegexp('^"google-site-verification=[A-Za-z0-9_-]{43}"$'),
    ]),
  });
});

test("the hosted zones survive the stack being deleted", () => {
  const zones = Object.values(dns.findResources("AWS::Route53::HostedZone"));
  assert.equal(zones.length, 3);
  for (const zone of zones) {
    assert.equal(zone.DeletionPolicy, "Retain");
  }
});

test("fidant.eu and fidant.org declare that they send no mail", () => {
  for (const zoneName of ["fidant.eu", "fidant.org"]) {
    dns.hasResourceProperties("AWS::Route53::RecordSet", {
      HostedZoneId: zoneRef(zoneName),
      Type: "MX",
      ResourceRecords: ["0 ."],
    });
    dns.hasResourceProperties("AWS::Route53::RecordSet", {
      HostedZoneId: zoneRef(zoneName),
      Name: `_dmarc.${zoneName}.`,
      ResourceRecords: ['"v=DMARC1; p=reject"'],
    });
  }
});

test("only Let's Encrypt, Sectigo and Amazon may issue for any name, and no wildcards", () => {
  for (const zoneName of ["fidant.se", "fidant.eu", "fidant.org"]) {
    dns.hasResourceProperties("AWS::Route53::RecordSet", {
      HostedZoneId: zoneRef(zoneName),
      Name: `${zoneName}.`,
      Type: "CAA",
      ResourceRecords: [
        '0 issue "letsencrypt.org"',
        '0 issue "sectigo.com"',
        '0 issue "amazon.com"',
        '0 issuewild ";"',
      ],
    });
  }
  assert.equal(
    Object.values(dns.findResources("AWS::Route53::RecordSet")).filter(
      (record) => record.Properties.Type === "CAA",
    ).length,
    3,
  );
});

test("fidant.se gets the mail records", () => {
  const zone = zoneRef("fidant.se");
  dns.hasResourceProperties("AWS::Route53::RecordSet", {
    HostedZoneId: zone,
    Name: "fidant.se.",
    Type: "TXT",
    ResourceRecords: ['"verify=1"', '"v=spf1 include:mail.example ~all"'],
  });
  dns.hasResourceProperties("AWS::Route53::RecordSet", {
    HostedZoneId: zone,
    Type: "MX",
    ResourceRecords: ["10 mx.example"],
  });
  dns.hasResourceProperties("AWS::Route53::RecordSet", {
    HostedZoneId: zone,
    Name: "key._domainkey.fidant.se.",
    Type: "CNAME",
  });
});

test("fidant.se holds the SES records for notify with SPF and MX, and no other zone has any", () => {
  const records = [
    ["notify.fidant.se.", "MX", ["0 ."]],
    ["notify.fidant.se.", "TXT", ['"v=spf1 -all"']],
    ["bounce.notify.fidant.se.", "MX", ["10 feedback-smtp.eu-north-1.amazonses.com"]],
    ["bounce.notify.fidant.se.", "TXT", ['"v=spf1 include:amazonses.com -all"']],
  ] as const;
  const all = Object.values(dns.findResources("AWS::Route53::RecordSet"));
  for (const [Name, Type, ResourceRecords] of records) {
    const found = all.filter((r) => r.Properties.Name === Name && r.Properties.Type === Type);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]?.Properties.ResourceRecords, ResourceRecords);
    assert.deepEqual(found[0]?.Properties.HostedZoneId, zoneRef("fidant.se"));
  }
  assert.equal(all.filter((r) => String(r.Properties.Name).startsWith("_dmarc.notify")).length, 0);
  for (const template of [dns, committed]) {
    const rows = Object.values(template.findResources(recordSet));
    const isNotify = (name: string) =>
      name.endsWith("notify.fidant.se.") ||
      name.startsWith("notify.") ||
      name.startsWith("bounce.notify.") ||
      name.includes("._domainkey.notify.");
    for (const record of rows.filter((r) => isNotify(String(r.Properties.Name)))) {
      assert.deepEqual(record.Properties.HostedZoneId, zoneRef("fidant.se"));
    }
    for (const zoneName of ["fidant.eu", "fidant.org"]) {
      for (const record of rows.filter(
        (r) => JSON.stringify(r.Properties.HostedZoneId) === JSON.stringify(zoneRef(zoneName)),
      )) {
        assert.doesNotMatch(String(record.Properties.Name), /^(notify|bounce\.notify)\./);
      }
    }
  }
  for (const record of all) {
    if (record.Properties.Type === "TXT") {
      assert.doesNotMatch(JSON.stringify(record.Properties.ResourceRecords), /ruf=/);
    }
  }
});

test("every site name points at the box over IPv4 only, with a 60-second lifetime", () => {
  for (const name of siteNames) {
    dns.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: `${name}.`,
      Type: "A",
      ResourceRecords: ["192.0.2.10"],
      TTL: "60",
    });
  }
  dns.resourcePropertiesCountIs("AWS::Route53::RecordSet", { Type: "AAAA" }, 0);
});

test("only fidant.se gets the relay name, pointing at the box over IPv4", () => {
  const relay = Object.values(dns.findResources(recordSet)).filter((record) =>
    String(record.Properties.Name).startsWith("turn."),
  );
  assert.deepEqual(
    relay.map(({ Properties: p }) => [p.HostedZoneId, p.Name, p.Type, p.ResourceRecords]),
    [[zoneRef("fidant.se"), "turn.fidant.se.", "A", ["192.0.2.10"]]],
  );
});

test("only fidant.se gets a relay record per relay, over IPv4 only", () => {
  const relay = Object.values(dns.findResources(recordSet)).filter((record) =>
    String(record.Properties.Name).includes(".relay."),
  );
  assert.deepEqual(
    relay.map(({ Properties: p }) => [p.HostedZoneId, p.Name, p.Type, p.ResourceRecords]),
    [[zoneRef("fidant.se"), "sto.relay.fidant.se.", "A", ["198.51.100.7"]]],
  );
});

test("the committed config points sto.relay.fidant.se at the relay box and no other zone has a relay record", () => {
  const records = Object.values(committed.findResources(recordSet)).filter((record) =>
    String(record.Properties.Name).includes(".relay."),
  );
  assert.deepEqual(
    records.map(({ Properties: p }) => [p.Name, p.Type, p.ResourceRecords]),
    [["sto.relay.fidant.se.", "A", ["13.51.1.111"]]],
  );
});

test("every relay address belongs to a relay in the config", () => {
  const ids = relays.map((relay) => relay.id);
  for (const id of Object.keys(relayAddresses)) {
    assert.ok(ids.includes(id), id);
  }
});

// Changing this name replaces the app box, and the site is down for 5–10 minutes.
test("the app box keeps its name", () => {
  const [, instance] = instanceNamed(appBox(), "^fidant-app-");
  assert.equal(instance?.Properties.InstanceName, "fidant-app-3760f705");
});

test("the journal is the only place the box's services keep log lines", () => {
  const [, instance] = instanceNamed(appBox(), "^fidant-app-");
  const userData = String(instance?.Properties.UserData);
  const heredoc = (path: string): string[] => {
    const start = userData.indexOf(`\ncat >${path} <<'EOF'\n`);
    assert.ok(start > 0, path);
    const body = userData.slice(userData.indexOf("\n", start + 1) + 1);
    return body.slice(0, body.indexOf("\nEOF\n")).split("\n");
  };

  const caddyfile = heredoc("/etc/caddy/Caddyfile");
  assert.deepEqual(
    caddyfile.filter((line) => /^\s*log\b/.test(line)),
    ["\tlog default {"],
  );
  assert.ok(!caddyfile.some((line) => /^\s*output\b/.test(line)));

  const turnserver = heredoc(">/etc/turnserver.conf");
  for (const line of ["log-file=/dev/null", "no-stdout-log"]) {
    assert.ok(turnserver.includes(line), line);
  }
  assert.ok(!turnserver.some((line) => /^\s*(syslog|verbose)\b/i.test(line)));

  assert.doesNotMatch(userData, /^\s*Standard(Output|Error)=/m);
});

test("neither the app server nor Caddy, which terminates TLS, has its memory swapped", () => {
  const userData = renderUserData();
  for (const [path, section] of [
    ["sigill.service", "\n[Service]\n"],
    ["caddy.service.d/no-swap.conf", "[Service]\n"],
  ] as const) {
    const start = userData.indexOf(`\ncat >/etc/systemd/system/${path} <<'EOF'\n`);
    assert.ok(start > 0, path);
    const unit = userData.slice(start, userData.indexOf("\nEOF\n", start));
    const service = unit.slice(unit.indexOf(section));
    assert.ok(service.split("\n").includes("MemorySwapMax=0"), path);
  }
  assert.ok(
    userData.indexOf("caddy.service.d/no-swap.conf") <
      userData.indexOf("\nsystemctl restart caddy\n"),
  );
});

test("the box builds only a production commit that is on main, and checks it before installing", () => {
  const userData = renderUserData();
  const start = userData.indexOf("\ncat >/usr/local/bin/sigill-deploy <<'EOF'\n");
  const deploy = userData.slice(start, userData.indexOf("\nEOF\n", start));
  const order = [
    `\nsha=$(git ls-remote "$repo" refs/heads/production | awk '$2 == "refs/heads/production" {print $1}')\n[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "no production branch" >&2; exit 1; }\ndir=`,
    '\nas_sigill "rm -rf $dir && git clone --quiet --filter=blob:none --no-checkout $repo $dir"\n',
    '\nlist=$(as_sigill "git -C $dir rev-list --first-parent refs/remotes/origin/main") || list=\nif [ -z "$list" ]; then\n  echo "could not check $sha against main" >&2\n  as_sigill "rm -rf $dir"\n  exit 1\nfi\n',
    '\ncase "$list" in\n*"$sha"*) ;;\n*)\n  echo "refused $sha: not on main" >&2\n  touch "/opt/sigill/failed-$sha"\n  as_sigill "rm -rf $dir"\n  exit 1\n  ;;\nesac\n',
    '\nas_sigill "cd $dir && git checkout --quiet $sha && pnpm install --frozen-lockfile"\n',
  ].map((text) => deploy.indexOf(text));
  assert.ok(start > 0 && order.every((index) => index > 0), order.join());
  assert.deepEqual(
    order,
    order.toSorted((a, b) => a - b),
  );
  assert.doesNotMatch(deploy, /refs\/heads\/main/);
  assert.ok(userData.includes("\nDescription=Deploy the production branch\n"));
});

test("sigill-deploy refuses a commit off main's first-parent history, and retries a check that fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "sigill-deploy-"));
  try {
    const userData = renderUserData();
    const start = userData.indexOf("\ncat >/usr/local/bin/sigill-deploy <<'EOF'\n");
    assert.ok(start > 0);
    const script = join(dir, "sigill-deploy");
    const body = userData.slice(
      userData.indexOf("\n", start + 1) + 1,
      userData.indexOf("\nEOF\n", start) + 1,
    );
    assert.ok(body.includes("https://github.com/sigill-labs/sigill.git"));
    const local = body
      .replaceAll("https://github.com/sigill-labs/sigill.git", `file://${dir}/src`)
      .replaceAll("/opt/sigill", `${dir}/opt`);
    assert.doesNotMatch(local, /github\.com/);
    writeFileSync(script, local);
    mkdirSync(join(dir, "opt", "releases"), { recursive: true });
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin", "runuser"),
      '#!/bin/sh\ncase "$*" in *rev-list*) [ -z "$FAIL_RUNUSER" ] || exit 1 ;; esac\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, "bin", "pnpm"),
      `#!/bin/sh\ngit rev-parse HEAD >'${dir}/built'\nexit 1\n`,
      {
        mode: 0o755,
      },
    );
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      PATH: `${dir}/bin:${process.env.PATH}`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const git = (...args: string[]) => {
      const { status, stdout } = spawnSync("git", ["-C", join(dir, "src"), ...args], {
        env,
        encoding: "utf8",
      });
      assert.equal(status, 0, args.join(" "));
      return stdout.trim();
    };
    git("init", "-q", "-b", "main");
    git("config", "uploadpack.allowFilter", "true");
    git("commit", "-q", "--allow-empty", "-m", "a");
    git("checkout", "-q", "-b", "feature");
    git("commit", "-q", "--allow-empty", "-m", "b");
    const side = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "m", "feature");
    const tip = git("rev-parse", "HEAD");
    const run = (sha: string, extra = {}) => {
      git("branch", "-f", "production", sha);
      rmSync(join(dir, "built"), { force: true });
      const { status, stderr } = spawnSync("/bin/bash", [script], {
        env: { ...env, ...extra },
        encoding: "utf8",
      });
      return {
        status,
        built: statSync(join(dir, "built"), { throwIfNoEntry: false })
          ? readFileSync(join(dir, "built"), "utf8").trim()
          : undefined,
        marked:
          statSync(join(dir, "opt", `failed-${sha}`), { throwIfNoEntry: false }) !== undefined,
        said: stderr.match(/^(refused|could not check) .*$/m)?.[0],
      };
    };
    const couldNotCheck = {
      status: 1,
      built: undefined,
      marked: false,
      said: `could not check ${tip} against main`,
    };

    assert.deepEqual(run(tip), { status: 1, built: tip, marked: false, said: undefined });
    assert.deepEqual(run(tip, { FAIL_RUNUSER: "1" }), couldNotCheck);
    assert.deepEqual(run(side), {
      status: 1,
      built: undefined,
      marked: true,
      said: `refused ${side}: not on main`,
    });
    git("branch", "-m", "main", "trunk");
    assert.deepEqual(run(tip), couldNotCheck);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function credentialHelper(): { helper: string; rest: string } {
  const userData = renderUserData();
  const start = userData.indexOf("\ncat >/usr/local/bin/sigill-credential <<'EOF'\n");
  const end = userData.indexOf("\nEOF\n", start);
  assert.ok(start > 0 && end > start);
  return {
    helper: userData.slice(userData.indexOf("\n", start + 1) + 1, end + 1),
    rest: userData.slice(0, start) + userData.slice(end + "\nEOF".length),
  };
}

test("the box's user data leaves mail off and installs only the helper that turns it on", () => {
  const { helper, rest } = credentialHelper();
  assert.doesNotMatch(rest, /mail|PUBLIC_ORIGIN/i);
  assert.deepEqual(rest.match(/.*sigill-credential.*/g), [
    "chmod 700 /usr/local/bin/sigill-credential",
  ]);
  assert.doesNotMatch(renderUserData(), /AKIA[A-Z0-9]{16}/);
  assert.equal(mailFrom, "noreply@notify.fidant.se");
  assert.ok(helper.includes(`'Environment="MAIL_FROM=Fidant <${mailFrom}>"'`));
  assert.ok(helper.includes("'Environment=PUBLIC_ORIGIN=https://fidant.se'"));
});

test("sigill-credential writes the mail drop-in only with its password file, and removes it first", () => {
  const dir = mkdtempSync(join(tmpdir(), "sigill-credential-"));
  try {
    const dropin = `${dir}/etc/systemd/system/sigill.service.d/mail.conf`;
    const secret = `${dir}/etc/sigill/mail-password`;
    const script = join(dir, "sigill-credential");
    writeFileSync(script, credentialHelper().helper.replaceAll("/etc/", `${dir}/etc/`));
    const log = join(dir, "log");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "stty"), `#!/bin/sh\necho "$*" >>'${dir}/stty-log'\n`, {
      mode: 0o755,
    });
    writeFileSync(
      join(dir, "bin", "systemctl"),
      `#!/bin/sh\necho "$*:$([ -e '${dropin}' ] && echo D)$([ -e '${secret}' ] && echo S)" >>'${log}'\n`,
      { mode: 0o755 },
    );
    const run = (action: string, input = "") => {
      writeFileSync(log, "");
      const { status } = spawnSync("/bin/sh", [script, "mail", action], {
        input,
        env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` },
      });
      return { status, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
    };
    const exists = (path: string) => statSync(path, { throwIfNoEntry: false }) !== undefined;
    const password = `${"A".repeat(43)}+`;

    assert.deepEqual(run("on", `AKIAIOSFODNN7EXAMPLE\n${password}\n`), {
      status: 0,
      calls: ["daemon-reload:DS", "try-restart sigill:DS"],
    });
    assert.equal(
      readFileSync(dropin, "utf8"),
      [
        "[Service]",
        "Environment=MAIL_SMTP_URL=smtps://AKIAIOSFODNN7EXAMPLE@email-smtp.eu-north-1.amazonaws.com:465",
        `Environment="MAIL_FROM=Fidant <${mailFrom}>"`,
        "Environment=PUBLIC_ORIGIN=https://fidant.se",
        `LoadCredential=mail-password:${secret}`,
        "Environment=MAIL_PASSWORD_FILE=%d/mail-password",
        "",
      ].join("\n"),
    );
    assert.equal(readFileSync(secret, "utf8"), `${password}\n`);
    assert.equal(statSync(secret).mode & 0o777, 0o600);

    assert.deepEqual(run("off"), {
      status: 0,
      calls: ["daemon-reload:S", "try-restart sigill:"],
    });
    assert.ok(!exists(dropin) && !exists(secret));

    for (const input of ["someone\n", `AKIAIOSFODNN7EXAMPLE\n${"A".repeat(43)}=\n`]) {
      assert.deepEqual(run("on", input), { status: 1, calls: [] });
      assert.ok(!exists(dropin) && !exists(secret));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sigill-credential restores terminal echo when a signal ends it at the password prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sigill-credential-"));
  try {
    const script = join(dir, "sigill-credential");
    writeFileSync(script, credentialHelper().helper.replaceAll("/etc/", `${dir}/etc/`));
    const sttyLog = join(dir, "stty-log");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "stty"), `#!/bin/sh\necho "$*" >>'${sttyLog}'\n`, {
      mode: 0o755,
    });
    const shell = statSync("/bin/dash", { throwIfNoEntry: false }) ? "/bin/dash" : "/bin/sh";
    const child = spawn(shell, [script, "mail", "on"], {
      env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const closed = new Promise((resolve) => child.on("close", resolve));
    child.stdin.write("AKIAIOSFODNN7EXAMPLE\n");
    for (let i = 0; i < 100 && !readIfAny(sttyLog).includes("-echo"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.kill("SIGINT");
    await closed;
    assert.deepEqual(readIfAny(sttyLog).split("\n").filter(Boolean), ["-echo", "echo"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readIfAny(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const camelPorts = [
  { protocol: "tcp", fromPort: 80, toPort: 80, cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] },
  { protocol: "tcp", fromPort: 443, toPort: 443, cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] },
  { protocol: "tcp", fromPort: 22, toPort: 22, cidrListAliases: ["lightsail-connect"] },
  { protocol: "tcp", fromPort: 3478, toPort: 3478, cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] },
  { protocol: "udp", fromPort: 3478, toPort: 3478, cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] },
  { protocol: "udp", fromPort: 49152, toPort: 65535, cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] },
];

function appBox(): Template {
  const stack = stacksFor(pocAccount).find((child) => child.stackName === "FidantApp");
  return Template.fromStack(stack as Stack);
}

function instanceNamed(box: Template, name: string) {
  const [instance, ...others] = Object.entries(
    box.findResources("AWS::Lightsail::Instance", {
      Properties: { InstanceName: Match.stringLikeRegexp(name) },
    }),
  );
  assert.ok(instance && others.length === 0, name);
  return instance;
}

function alarmsNamed(box: Template, prefix: string) {
  return Object.values(box.findResources("AWS::CloudWatch::Alarm"))
    .map((alarm) => alarm.Properties)
    .filter((alarm) => String(alarm.AlarmName).startsWith(prefix));
}

function alertTopic(box: Template): { Ref: string } {
  const subscriptions = Object.values(box.findResources("AWS::SNS::Subscription"));
  assert.equal(subscriptions.length, 1);
  return subscriptions[0]?.Properties.TopicArn;
}

function onlyId(box: Template, type: string): string {
  const ids = Object.keys(box.findResources(type));
  assert.equal(ids.length, 1, type);
  return ids[0] ?? "";
}

const relayCamelPorts = [
  { protocol: "tcp", fromPort: 22, toPort: 22, cidrListAliases: ["lightsail-connect"] },
  { protocol: "tcp", fromPort: 80, toPort: 80, cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] },
  { protocol: "tcp", fromPort: 443, toPort: 443, cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] },
  { protocol: "tcp", fromPort: 3478, toPort: 3478, cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] },
  { protocol: "udp", fromPort: 3478, toPort: 3478, cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] },
  { protocol: "udp", fromPort: 49152, toPort: 65535, cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] },
];

function relayCapFunction(box: Template) {
  const functions = Object.entries(box.findResources("AWS::Lambda::Function"))
    .filter(([id]) => id.startsWith("RelayCap"))
    .map(([, fn]) => fn);
  assert.equal(functions.length, 1);
  return functions[0]?.Properties;
}

test("the relay cap checks the app box's and the relay box's pooled traffic every 5 minutes", () => {
  const box = appBox();
  const [appId] = instanceNamed(box, "^fidant-app-");
  const [relayId] = instanceNamed(box, "^fidant-relay-sto-");
  const properties = relayCapFunction(box);
  assert.equal(properties.Runtime, "nodejs24.x");
  assert.equal(properties.Handler, "index.handler");
  assert.equal(properties.Timeout, 30);
  const variables = properties.Environment.Variables;
  assert.deepEqual(Object.keys(variables).sort(), [
    "ALLOWANCE_BYTES",
    "BOXES",
    "BUDGET_USD",
    "RELAYS",
    "STATUS_URL",
    "USD_PER_GB",
  ]);
  assert.equal(variables.ALLOWANCE_BYTES, "4000000000000");
  assert.equal(variables.BUDGET_USD, "20");
  assert.equal(variables.USD_PER_GB, "0.09");
  assert.equal(variables.RELAYS, '["sto"]');
  assert.equal(variables.STATUS_URL, "https://fidant.se/relay-status");
  assert.deepEqual(sdkCall(variables.BOXES), [
    { box: `{Ref:${appId}}`, openPorts: camelPorts, cappedPorts: camelPorts.slice(0, 3) },
    {
      box: `{Ref:${relayId}}`,
      openPorts: relayCamelPorts,
      cappedPorts: relayCamelPorts.slice(0, 2),
    },
  ]);
  box.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(5 minutes)" });
  box.hasResourceProperties("AWS::Lambda::EventInvokeConfig", { MaximumRetryAttempts: 0 });
});

test("every box the relay cap counts is a micro_3_0 bundle, which the 2 TB pool per box assumes", () => {
  const box = appBox();
  const listed = sdkCall(relayCapFunction(box).Environment.Variables.BOXES).map(
    (entry: { box: string }) => entry.box.slice("{Ref:".length, -1),
  );
  const instances = box.findResources("AWS::Lightsail::Instance");
  assert.equal(listed.length, 2);
  for (const id of listed) {
    assert.equal(instances[id]?.Properties.BundleId, "micro_3_0", id);
  }
});

test("the relay cap may only read instance metrics, set the two boxes' ports, and keep its state", () => {
  const box = appBox();
  const [appId] = instanceNamed(box, "^fidant-app-");
  const [relayId] = instanceNamed(box, "^fidant-relay-sto-");
  const policies = Object.values(box.findResources("AWS::IAM::Policy")).filter((policy) =>
    policy.Properties.Roles?.[0].Ref.startsWith("RelayCap"),
  );
  assert.equal(policies.length, 1);
  const statements = policies[0]?.Properties.PolicyDocument.Statement;
  assert.equal(statements.length, 3);
  assert.deepEqual(statements[0], {
    Action: "lightsail:GetInstanceMetricData",
    Effect: "Allow",
    Resource: "*",
  });
  assert.deepEqual(statements[1], {
    Action: "lightsail:PutInstancePublicPorts",
    Effect: "Allow",
    Resource: [
      { "Fn::GetAtt": [appId, "InstanceArn"] },
      { "Fn::GetAtt": [relayId, "InstanceArn"] },
    ],
  });
  assert.deepEqual(statements[2].Action, ["ssm:GetParameter", "ssm:PutParameter"]);
  assert.equal(statements[2].Effect, "Allow");
  const resource = statements[2].Resource["Fn::Join"];
  assert.match(resource[1].at(-1), /:parameter\/fidant\/relay-cap$/);
});

function loggedMetric(line: string) {
  const metric = JSON.parse(line);
  const [declared] = metric._aws.CloudWatchMetrics;
  return {
    Namespace: declared.Namespace,
    MetricName: declared.Metrics[0].Name,
    Dimensions: declared.Dimensions[0].map((key: string) => ({ Name: key, Value: metric[key] })),
  };
}

test("relay traffic past 80 %, the cap, and a failing cap email the alert address", () => {
  const box = appBox();
  box.hasResourceProperties("AWS::SNS::Subscription", {
    Protocol: "email",
    Endpoint: "budget-alert@fidant.se",
  });
  const alarms = alarmsNamed(box, "Fidant relay ");
  assert.equal(alarms.length, 5);
  const byName = (name: string) => alarms.find((alarm) => alarm.AlarmName === name);
  const notify = [alertTopic(box)];
  const now = new Date();
  for (const [name, threshold, logged] of [
    ["Fidant relay traffic past 80 % of the allowance", 3_200_000_000_000, metricLine(0, now)],
    ["Fidant relay stopped: overage budget reached", 20, overageLine(0, now)],
    ["Fidant relay cap failing", 1, undefined],
  ] as const) {
    const alarm = byName(name);
    assert.ok(alarm, name);
    assert.equal(alarm.Threshold, threshold);
    assert.deepEqual(alarm.AlarmActions, notify);
    assert.deepEqual(alarm.OKActions, notify);
    if (logged) {
      const { Namespace, MetricName, Dimensions } = loggedMetric(logged);
      assert.equal(alarm.Namespace, Namespace);
      assert.equal(alarm.MetricName, MetricName);
      assert.equal(alarm.ComparisonOperator, "GreaterThanOrEqualToThreshold");
      assert.deepEqual(alarm.Dimensions, Dimensions);
      assert.equal(alarm.Statistic, "Maximum");
      assert.equal(alarm.Period, 300);
      assert.equal(alarm.EvaluationPeriods, 1);
      assert.equal(alarm.TreatMissingData, "ignore");
    }
  }
});

test("a relay that is down and a status that can't be read each email the alert address after 10 minutes", () => {
  const box = appBox();
  const notify = [alertTopic(box)];
  const logged = statusLines(["sto"], [{ id: "sto", up: true }], new Date()).map(loggedMetric);
  for (const [name, metricName] of [
    ["Fidant relay status unreachable", "RelayStatusOk"],
    ["Fidant relay sto unavailable", "RelayUp"],
  ] as const) {
    const alarm = alarmsNamed(box, name)[0];
    assert.ok(alarm, name);
    assert.deepEqual(
      {
        Namespace: alarm.Namespace,
        MetricName: alarm.MetricName,
        Dimensions: alarm.Dimensions,
      },
      logged.find((metric) => metric.MetricName === metricName),
    );
    assert.equal(alarm.Statistic, "Maximum");
    assert.equal(alarm.Period, 300);
    assert.equal(alarm.Threshold, 1);
    assert.equal(alarm.ComparisonOperator, "LessThanThreshold");
    assert.equal(alarm.EvaluationPeriods, 2);
    assert.equal(alarm.DatapointsToAlarm, 2);
    assert.equal(alarm.TreatMissingData, "ignore");
    assert.deepEqual(alarm.AlarmActions, notify);
    assert.deepEqual(alarm.OKActions, notify);
  }
});

test("the cap's Lambda code imports nothing outside its folder", () => {
  const folder = new URL("./relay-cap/", import.meta.url);
  const files = readdirSync(folder).filter((name) => !name.endsWith(".test.ts"));
  assert.ok(files.includes("index.mjs"));
  for (const file of files) {
    const source = readFileSync(new URL(file, folder), "utf8");
    for (const [, specifier = ""] of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      if (specifier.startsWith(".")) {
        assert.ok(specifier.startsWith("./") && !specifier.includes(".."), `${file}: ${specifier}`);
      } else if (!specifier.startsWith("node:")) {
        assert.ok(
          ["@aws-sdk/client-lightsail", "@aws-sdk/client-ssm"].includes(specifier),
          `${file}: ${specifier}`,
        );
      }
    }
  }
});

test("the app sends mail as notify.fidant.se, with TLS required, no tracking and no suppression list", () => {
  const box = appBox();
  const configSet = onlyId(box, "AWS::SES::ConfigurationSet");
  assert.deepEqual(box.findResources("AWS::SES::ConfigurationSet")[configSet]?.Properties, {
    Name: "fidant-mail",
    DeliveryOptions: { MaxDeliverySeconds: 900, TlsPolicy: "REQUIRE" },
    SuppressionOptions: { SuppressedReasons: [] },
  });
  const identity = onlyId(box, "AWS::SES::EmailIdentity");
  assert.deepEqual(box.findResources("AWS::SES::EmailIdentity")[identity]?.Properties, {
    EmailIdentity: "notify.fidant.se",
    ConfigurationSetAttributes: { ConfigurationSetName: { Ref: configSet } },
    MailFromAttributes: { MailFromDomain: "bounce.notify.fidant.se" },
  });
});

function feedbackTopic(box: Template): string {
  const alerts = alertTopic(box);
  const feedback = Object.keys(box.findResources("AWS::SNS::Topic")).filter(
    (id) => id !== alerts.Ref,
  );
  assert.equal(feedback.length, 1);
  return feedback[0] ?? "";
}

test("bounces and complaints go only to a topic nobody subscribes to", () => {
  const box = appBox();
  const feedback = feedbackTopic(box);
  const destinations = Object.values(
    box.findResources("AWS::SES::ConfigurationSetEventDestination"),
  ).map((destination) => destination.Properties);
  assert.deepEqual(destinations, [
    {
      ConfigurationSetName: { Ref: onlyId(box, "AWS::SES::ConfigurationSet") },
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: ["bounce", "complaint"],
        SnsDestination: { TopicARN: { Ref: feedback } },
      },
    },
  ]);
});

test("SES may publish to the feedback topic only for the configuration set and the identity", () => {
  const box = appBox();
  const feedback = feedbackTopic(box);
  const source = (resource: string, type: string) => ({
    "Fn::Join": [
      "",
      [
        "arn:",
        { Ref: "AWS::Partition" },
        `:ses:eu-north-1:${pocAccount}:${resource}/`,
        { Ref: onlyId(box, type) },
      ],
    ],
  });
  const policy = box.findResources("AWS::SNS::TopicPolicy")[onlyId(box, "AWS::SNS::TopicPolicy")];
  assert.deepEqual(policy?.Properties.Topics, [{ Ref: feedback }]);
  assert.deepEqual(
    policy?.Properties.PolicyDocument.Statement,
    [
      source("configuration-set", "AWS::SES::ConfigurationSet"),
      source("identity", "AWS::SES::EmailIdentity"),
    ].map((sourceArn, sid) => ({
      Sid: String(sid),
      Action: "sns:Publish",
      Effect: "Allow",
      Principal: { Service: "ses.amazonaws.com" },
      Resource: { Ref: feedback },
      Condition: { StringEquals: { "AWS:SourceAccount": pocAccount, "AWS:SourceArn": sourceArn } },
    })),
  );
});

function sdkCall(value: string | { "Fn::Join": [string, (string | { Ref: string })[]] }) {
  const text =
    typeof value === "string"
      ? value
      : value["Fn::Join"][1]
          .map((part) => (typeof part === "string" ? part : `{Ref:${part.Ref}}`))
          .join("");
  return JSON.parse(text);
}

test("the identity sends bounces and complaints to the feedback topic, then stops forwarding them by email", () => {
  const box = appBox();
  const feedback = feedbackTopic(box);
  const identity = onlyId(box, "AWS::SES::EmailIdentity");
  const topicPolicy = onlyId(box, "AWS::SNS::TopicPolicy");
  const settings = Object.entries(box.findResources("Custom::AWS"));
  assert.deepEqual(
    settings.map(([, setting]) => {
      assert.deepEqual(setting.Properties.Update, setting.Properties.Create);
      assert.equal(setting.Properties.Delete, undefined);
      assert.equal(setting.Properties.InstallLatestAwsSdk, false);
      return sdkCall(setting.Properties.Create);
    }),
    [
      ...["Bounce", "Complaint"].map((type) => ({
        service: "SES",
        action: "SetIdentityNotificationTopic",
        parameters: {
          Identity: "notify.fidant.se",
          NotificationType: type,
          SnsTopic: `{Ref:${feedback}}`,
        },
        physicalResourceId: { id: `Mail${type}Topic` },
      })),
      {
        service: "SES",
        action: "SetIdentityFeedbackForwardingEnabled",
        parameters: { Identity: "notify.fidant.se", ForwardingEnabled: false },
        physicalResourceId: { id: "MailForwardingOff" },
      },
    ],
  );
  const ids = settings.map(([id]) => id);
  for (const [index, [, setting]] of settings.entries()) {
    for (const before of [index === 0 ? identity : ids[index - 1], topicPolicy]) {
      assert.ok(setting.DependsOn.includes(before), `${ids[index]} after ${before}`);
    }
  }
});

test("the function behind those settings may only set notification topics and forwarding", () => {
  const box = appBox();
  const functions = Object.entries(box.findResources("AWS::Lambda::Function")).filter(
    ([id]) => !id.startsWith("RelayCap") && !id.startsWith("MailPause"),
  );
  assert.equal(functions.length, 1);
  const [functionId, fn] = functions[0] ?? [];
  for (const [, setting] of Object.entries(box.findResources("Custom::AWS"))) {
    assert.deepEqual(setting.Properties.ServiceToken, { "Fn::GetAtt": [functionId, "Arn"] });
  }
  const role = fn?.Properties.Role["Fn::GetAtt"][0];
  assert.deepEqual(box.findResources("AWS::IAM::Role")[role]?.Properties.ManagedPolicyArns, [
    {
      "Fn::Join": [
        "",
        [
          "arn:",
          { Ref: "AWS::Partition" },
          ":iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        ],
      ],
    },
  ]);
  assert.deepEqual(
    Object.values(box.findResources("AWS::IAM::Policy"))
      .filter((policy) => policy.Properties.Roles?.[0].Ref === role)
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement),
    [
      "ses:SetIdentityNotificationTopic",
      "ses:SetIdentityNotificationTopic",
      "ses:SetIdentityFeedbackForwardingEnabled",
    ].map((action) => ({ Action: action, Effect: "Allow", Resource: "*" })),
  );
  const logGroup = fn?.Properties.LoggingConfig.LogGroup.Ref;
  assert.equal(box.findResources("AWS::Logs::LogGroup")[logGroup]?.Properties.RetentionInDays, 30);
});

test("the mail user may only send through the identity, and CDK gives it no key or password", () => {
  const box = appBox();
  const user = onlyId(box, "AWS::IAM::User");
  assert.deepEqual(box.findResources("AWS::IAM::User")[user]?.Properties, {
    UserName: "fidant-mail",
  });
  box.resourceCountIs("AWS::IAM::AccessKey", 0);
  const arn = (resource: string, id: string) => ({
    "Fn::Join": [
      "",
      [
        "arn:",
        { Ref: "AWS::Partition" },
        `:ses:eu-north-1:${pocAccount}:${resource}/`,
        { Ref: id },
      ],
    ],
  });
  const policies = Object.values(box.findResources("AWS::IAM::Policy"))
    .filter((policy) => policy.Properties.Users)
    .map((policy) => [policy.Properties.Users, policy.Properties.PolicyDocument.Statement]);
  assert.deepEqual(policies, [
    [
      [{ Ref: user }],
      [
        {
          Action: "ses:SendRawEmail",
          Effect: "Allow",
          Resource: [
            arn("identity", onlyId(box, "AWS::SES::EmailIdentity")),
            arn("configuration-set", onlyId(box, "AWS::SES::ConfigurationSet")),
          ],
        },
      ],
    ],
  ]);
});

test("FidantApp outputs only the app box's and the relay's addresses and the three DKIM records", () => {
  const box = appBox();
  const identity = onlyId(box, "AWS::SES::EmailIdentity");
  const outputs = box.toJSON().Outputs;
  assert.deepEqual(Object.keys(outputs).sort(), [
    "Dkim1",
    "Dkim2",
    "Dkim3",
    "PublicIp",
    "RelayStoIp",
  ]);
  for (const n of [1, 2, 3]) {
    assert.deepEqual(outputs[`Dkim${n}`].Value, {
      "Fn::Join": [
        "",
        [
          { "Fn::GetAtt": [identity, `DkimDNSTokenName${n}`] },
          " CNAME ",
          { "Fn::GetAtt": [identity, `DkimDNSTokenValue${n}`] },
        ],
      ],
    });
  }
});

test("FidantApp keeps the signaling images, where only live moves and only untagged images expire", () => {
  const box = appBox();
  const repository = box.findResources("AWS::ECR::Repository")[onlyId(box, "AWS::ECR::Repository")];
  assert.equal(repository?.DeletionPolicy, "Retain");
  assert.equal(repository?.UpdateReplacePolicy, "Retain");
  const { LifecyclePolicy, ...properties } = repository?.Properties ?? {};
  assert.deepEqual(properties, {
    RepositoryName: "fidant-signal",
    ImageTagMutability: "IMMUTABLE_WITH_EXCLUSION",
    ImageTagMutabilityExclusionFilters: [
      {
        ImageTagMutabilityExclusionFilterType: "WILDCARD",
        ImageTagMutabilityExclusionFilterValue: "live",
      },
    ],
  });
  assert.deepEqual(Object.keys(LifecyclePolicy), ["LifecyclePolicyText"]);
  assert.deepEqual(JSON.parse(LifecyclePolicy.LifecyclePolicyText), {
    rules: [
      {
        rulePriority: 1,
        selection: {
          tagStatus: "untagged",
          countType: "sinceImagePushed",
          countNumber: 7,
          countUnit: "days",
        },
        action: { type: "expire" },
      },
    ],
  });
});

function mailPause(box: Template) {
  const functions = Object.entries(box.findResources("AWS::Lambda::Function")).filter(([id]) =>
    id.startsWith("MailPause"),
  );
  assert.equal(functions.length, 1);
  const [id, fn] = functions[0] ?? [];
  return { id: id ?? "", properties: fn?.Properties };
}

test("SES bounce and complaint rates well below AWS's review thresholds pause mail and email the alert address", () => {
  const box = appBox();
  const notify = [alertTopic(box)];
  const pause = { "Fn::GetAtt": [mailPause(box).id, "Arn"] };
  assert.deepEqual(
    alarmsNamed(box, "Fidant SES reputation").map((alarm) => [
      alarm.AlarmName,
      alarm.Namespace,
      alarm.MetricName,
      alarm.Dimensions,
      alarm.ComparisonOperator,
      alarm.Threshold,
      alarm.TreatMissingData,
      alarm.AlarmActions,
      alarm.OKActions,
    ]),
    [
      [
        "Fidant SES reputation: bounce rate 2 % or more, mail paused",
        "AWS/SES",
        "Reputation.BounceRate",
        undefined,
        "GreaterThanOrEqualToThreshold",
        0.02,
        "ignore",
        [...notify, pause],
        notify,
      ],
      [
        "Fidant SES reputation: complaint rate 0.05 % or more, mail paused",
        "AWS/SES",
        "Reputation.ComplaintRate",
        undefined,
        "GreaterThanOrEqualToThreshold",
        0.0005,
        "ignore",
        [...notify, pause],
        notify,
      ],
    ],
  );
});

test("the mail pause may only turn off sending for the configuration set, and only the two SES alarms invoke it", () => {
  const box = appBox();
  const configSet = onlyId(box, "AWS::SES::ConfigurationSet");
  const { id, properties } = mailPause(box);
  assert.equal(properties.Runtime, "nodejs24.x");
  assert.equal(properties.Handler, "index.handler");
  assert.equal(properties.Timeout, 10);
  assert.deepEqual(properties.Environment.Variables, { CONFIGURATION_SET: { Ref: configSet } });
  const logGroup = properties.LoggingConfig.LogGroup.Ref;
  assert.equal(box.findResources("AWS::Logs::LogGroup")[logGroup]?.Properties.RetentionInDays, 30);
  const role = properties.Role["Fn::GetAtt"][0];
  assert.deepEqual(
    Object.values(box.findResources("AWS::IAM::Policy"))
      .filter((policy) => policy.Properties.Roles?.[0].Ref === role)
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement),
    [
      {
        Action: "ses:PutConfigurationSetSendingOptions",
        Effect: "Allow",
        Resource: {
          "Fn::Join": [
            "",
            [
              "arn:",
              { Ref: "AWS::Partition" },
              `:ses:eu-north-1:${pocAccount}:configuration-set/`,
              { Ref: configSet },
            ],
          ],
        },
      },
    ],
  );
  const alarms = Object.entries(box.findResources("AWS::CloudWatch::Alarm"))
    .filter(([, alarm]) => String(alarm.Properties.AlarmName).startsWith("Fidant SES reputation"))
    .map(([alarmId]) => ({ "Fn::GetAtt": [alarmId, "Arn"] }));
  assert.equal(alarms.length, 2);
  assert.deepEqual(
    Object.values(box.findResources("AWS::Lambda::Permission"))
      .map((permission) => permission.Properties)
      .filter((permission) => permission.FunctionName["Fn::GetAtt"]?.[0] === id)
      .map((permission) => [permission.Action, permission.Principal, permission.SourceArn]),
    alarms.map((alarm) => [
      "lambda:InvokeFunction",
      "lambda.alarms.cloudwatch.amazonaws.com",
      alarm,
    ]),
  );
});

test("the mail pause turns off sending for fidant-mail and nothing else", async () => {
  const { properties } = mailPause(appBox());
  const sent: unknown[] = [];
  class PutConfigurationSetSendingOptionsCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  const fakeRequire = (name: string) => {
    assert.equal(name, "@aws-sdk/client-sesv2");
    return {
      SESv2Client: class {
        async send(command: { input: unknown }) {
          sent.push(command.input);
        }
      },
      PutConfigurationSetSendingOptionsCommand,
    };
  };
  const exports: { handler?: () => Promise<void> } = {};
  new Function("require", "exports", "process", properties.Code.ZipFile)(fakeRequire, exports, {
    env: { CONFIGURATION_SET: "fidant-mail" },
  });
  await exports.handler?.();
  assert.deepEqual(sent, [{ ConfigurationSetName: "fidant-mail", SendingEnabled: false }]);
});

test("the cap's Lambda code loads the way Lambda loads it: no package.json, no syntax detection", () => {
  const folder = new URL("./relay-cap/", import.meta.url);
  const asset = mkdtempSync(join(tmpdir(), "relay-cap-"));
  try {
    for (const file of readdirSync(folder).filter((name) => !name.endsWith(".test.ts"))) {
      copyFileSync(new URL(file, folder), join(asset, file));
    }
    const stub = [
      "LightsailClient",
      "GetInstanceMetricDataCommand",
      "PutInstancePublicPortsCommand",
      "SSMClient",
      "GetParameterCommand",
      "PutParameterCommand",
    ]
      .map((name) => `export class ${name} {}`)
      .join("\n");
    for (const sdk of ["client-lightsail", "client-ssm"]) {
      const dir = join(asset, "node_modules", "@aws-sdk", sdk);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), '{"type":"module","exports":"./index.js"}');
      writeFileSync(join(dir, "index.js"), stub);
    }
    const loaded = spawnSync(
      process.execPath,
      [
        "--no-experimental-detect-module",
        "--input-type=module",
        "-e",
        "const { handler } = await import('./index.mjs'); console.log(typeof handler);",
      ],
      { cwd: asset, encoding: "utf8" },
    );
    assert.equal(loaded.stdout.trim(), "function", loaded.stderr);
  } finally {
    rmSync(asset, { recursive: true, force: true });
  }
});
