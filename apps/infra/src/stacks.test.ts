import assert from "node:assert/strict";
import { isIP } from "node:net";
import { test } from "node:test";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { addStacks } from "./app.ts";
import { boxAddress, hostedZoneIds, siteNames, zoneNames } from "./config.ts";
import { DnsStack } from "./dns.ts";

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

test("the fidant-poc account gets the CI and app box stacks, in eu-north-1", () => {
  const stacks = stacksFor(pocAccount);
  assert.deepEqual(
    stacks.map((stack) => [stack.stackName, stack.region]),
    [
      ["FidantCi", "eu-north-1"],
      ["FidantApp", "eu-north-1"],
    ],
  );
});

function ciTemplate(currentAccount: string): Template {
  const stack = stacksFor(currentAccount).find((child) => child.stackName === "FidantCi");
  return Template.fromStack(stack as Stack);
}

test("only this repository's production environment can assume the CI role", () => {
  for (const currentAccount of [dnsAccount, pocAccount]) {
    const ci = ciTemplate(currentAccount);
    ci.resourceCountIs("AWS::IAM::Role", 1);
    ci.hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIdList: ["sts.amazonaws.com"],
    });
    const [providerId] = Object.keys(ci.findResources("AWS::IAM::OIDCProvider"));
    const [role] = Object.values(ci.findResources("AWS::IAM::Role"));
    assert.equal(role?.Properties.RoleName, "fidant-ci-deploy");
    assert.deepEqual(role?.Properties.AssumeRolePolicyDocument.Statement, [
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
  const [role] = Object.values(ci.findResources("AWS::IAM::Role"));
  assert.equal(role?.Properties.ManagedPolicyArns, undefined);
  assert.equal(role?.Properties.Policies, undefined);
  const policies = Object.values(ci.findResources("AWS::IAM::Policy"));
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0]?.Properties.PolicyDocument.Statement, [
    {
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Resource: `arn:aws:iam::${pocAccount}:role/cdk-hnb659fds-*`,
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
  for (const name of [...siteNames, "turn.fidant.se"]) {
    committed.hasResourceProperties(recordSet, {
      Name: `${name}.`,
      Type: "A",
      ResourceRecords: [boxAddress],
    });
    committed.resourcePropertiesCountIs(recordSet, { Name: `${name}.`, Type: "AAAA" }, 0);
  }
});

test("the app box is open only on 80, 443 and the relay's ports, and on 22 only to Lightsail's browser SSH", () => {
  const stack = stacksFor(pocAccount).find((child) => child.stackName === "FidantApp");
  const box = Template.fromStack(stack as Stack);
  const [instance] = Object.values(box.findResources("AWS::Lightsail::Instance"));
  assert.deepEqual(instance?.Properties.Networking.Ports, [
    { Protocol: "tcp", FromPort: 80, ToPort: 80, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "tcp", FromPort: 443, ToPort: 443, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "tcp", FromPort: 22, ToPort: 22, CidrListAliases: ["lightsail-connect"] },
    { Protocol: "tcp", FromPort: 3478, ToPort: 3478, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "udp", FromPort: 3478, ToPort: 3478, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "udp", FromPort: 49152, ToPort: 65535, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
  ]);
  const [instanceId] = Object.keys(box.findResources("AWS::Lightsail::Instance"));
  box.hasResourceProperties("AWS::Lightsail::StaticIp", { AttachedTo: { Ref: instanceId } });
  box.hasResource("AWS::Lightsail::StaticIp", { DeletionPolicy: "Retain" });
  assert.match(instance?.Properties.InstanceName, /^fidant-app-[0-9a-f]{8}$/);
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

test("the app box keeps log lines for at most 30 days, before any service starts logging", () => {
  const stack = stacksFor(pocAccount).find((child) => child.stackName === "FidantApp");
  const [instance] = Object.values(
    Template.fromStack(stack as Stack).findResources("AWS::Lightsail::Instance"),
  );
  const userData = String(instance?.Properties.UserData);
  const dropIn = userData.indexOf(
    "\ncat >/etc/systemd/journald.conf.d/zz-retention.conf <<'EOF'\n[Journal]\nMaxRetentionSec=29day\nMaxFileSec=1day\nForwardToSyslog=no\nEOF\nsystemctl restart systemd-journald\n",
  );
  assert.ok(dropIn > 0);
  assert.ok(dropIn < userData.indexOf("\napt-get "));
});

test("the app box runs coturn after the site is up, with a secret that stays on the box", () => {
  const stack = stacksFor(pocAccount).find((child) => child.stackName === "FidantApp");
  const box = Template.fromStack(stack as Stack);
  const [instance] = Object.values(box.findResources("AWS::Lightsail::Instance"));
  const userData = String(instance?.Properties.UserData);
  const lines = userData.split("\n");
  assert.ok(Buffer.byteLength(userData) < 16 * 1024);

  for (const line of ["realm=turn.fidant.se", "use-auth-secret", "log-file=/dev/null"]) {
    assert.ok(lines.includes(line), line);
  }
  assert.ok(userData.includes(`external-ip=${boxAddress}/`));
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
    'static-auth-secret=\' "$private_ip"; cat /etc/sigill/turn-secret; } >>/etc/turnserver.conf',
  ]);
  assert.doesNotMatch(userData, /\$\(openssl/);
  assert.deepEqual(userData.match(/.*rand -hex.*/g), [
    "(umask 077 && openssl rand -hex 32 >/etc/sigill/turn-secret)",
  ]);
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

test("only Caddy's two certificate authorities may issue for any name, and no wildcards", () => {
  for (const zoneName of ["fidant.se", "fidant.eu", "fidant.org"]) {
    dns.hasResourceProperties("AWS::Route53::RecordSet", {
      HostedZoneId: zoneRef(zoneName),
      Name: `${zoneName}.`,
      Type: "CAA",
      ResourceRecords: ['0 issue "letsencrypt.org"', '0 issue "sectigo.com"', '0 issuewild ";"'],
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

test("every site name points at the box over IPv4 only", () => {
  for (const name of siteNames) {
    dns.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: `${name}.`,
      Type: "A",
      ResourceRecords: ["192.0.2.10"],
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
