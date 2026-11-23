import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { addStacks } from "./app.ts";
import { boxAddress, primaryDomain, siteNames } from "./config.ts";
import { DnsStack } from "./dns.ts";
import { SiteStack } from "./site.ts";

const account = "111111111111";
const dnsAccount = "222222222222";
const pocAccount = "333333333333";

function synth() {
  const app = new App();
  const dnsProps = {
    env: { account, region: "eu-north-1" },
    mail: {
      apexTxt: ["verify=1", "v=spf1 include:mail.example ~all"],
      mx: [{ priority: 10, hostName: "mx.example" }],
      cnames: [{ name: "key._domainkey", value: "key.example" }],
      dmarc: "v=DMARC1; p=quarantine",
    },
    certificateValidation: [{ name: "_a.www.fidant.eu.", value: "_b.acm-validations.aws." }],
    distributionDomain: "d111.cloudfront.net",
  };
  const dns = new DnsStack(app, "Dns", { ...dnsProps, boxAddress: undefined });
  const boxDns = new DnsStack(app, "BoxDns", { ...dnsProps, boxAddress: "192.0.2.10" });
  const site = new SiteStack(app, "Site", { env: { account, region: "us-east-1" } });
  return {
    dns: Template.fromStack(dns),
    boxDns: Template.fromStack(boxDns),
    site: Template.fromStack(site),
  };
}

const { dns, boxDns, site } = synth();

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

test("the fidant-dns account gets the protected DNS stack and the CI stack", () => {
  const stacks = stacksFor(dnsAccount);
  assert.deepEqual(
    stacks.map((stack) => [stack.stackName, stack.region, stack.terminationProtection]),
    [
      ["FidantDns", "eu-north-1", true],
      ["FidantCi", "eu-north-1", false],
    ],
  );
});

test("the fidant-poc account gets the site, CI and app box stacks", () => {
  const stacks = stacksFor(pocAccount);
  assert.deepEqual(
    stacks.map((stack) => [stack.stackName, stack.region]),
    [
      ["FidantSite", "us-east-1"],
      ["FidantCi", "us-east-1"],
      ["FidantApp", "eu-north-1"],
    ],
  );
  Template.fromStack(stacks[0] as Stack);
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

test("the committed config keeps the certificate valid and every site name pointed at CloudFront", () => {
  for (const name of siteNames) {
    const escaped = name.replaceAll(".", "\\.");
    committed.resourcePropertiesCountIs(
      recordSet,
      {
        Type: "CNAME",
        Name: Match.stringLikeRegexp(`^_[0-9a-f]{32}\\.${escaped}\\.$`),
        ResourceRecords: [
          Match.stringLikeRegexp("^_[0-9a-f]{32}\\.[a-z0-9]+\\.acm-validations\\.aws\\.$"),
        ],
      },
      1,
    );
    if (name === primaryDomain && boxAddress !== undefined) {
      continue;
    }
    for (const type of ["A", "AAAA"]) {
      committed.hasResourceProperties(recordSet, {
        Name: `${name}.`,
        Type: type,
        AliasTarget: { DNSName: Match.stringLikeRegexp("^d[a-z0-9]+\\.cloudfront\\.net$") },
      });
    }
  }
  if (boxAddress !== undefined) {
    assert.match(boxAddress, /^\d{1,3}(\.\d{1,3}){3}$/);
    committed.hasResourceProperties(recordSet, {
      Name: `${primaryDomain}.`,
      Type: "A",
      ResourceRecords: [boxAddress],
    });
  }
});

test("with a box address, fidant.se points at the box over IPv4 only and www keeps CloudFront", () => {
  boxDns.hasResourceProperties(recordSet, {
    Name: "fidant.se.",
    Type: "A",
    ResourceRecords: ["192.0.2.10"],
  });
  boxDns.resourcePropertiesCountIs(recordSet, { Name: "fidant.se.", Type: "AAAA" }, 0);
  boxDns.hasResourceProperties(recordSet, {
    Name: "www.fidant.se.",
    Type: "A",
    AliasTarget: Match.objectLike({ DNSName: "d111.cloudfront.net" }),
  });
});

test("the app box is open only on 80 and 443, and on 22 only to Lightsail's browser SSH", () => {
  const stack = stacksFor(pocAccount).find((child) => child.stackName === "FidantApp");
  const box = Template.fromStack(stack as Stack);
  const [instance] = Object.values(box.findResources("AWS::Lightsail::Instance"));
  assert.deepEqual(instance?.Properties.Networking.Ports, [
    { Protocol: "tcp", FromPort: 80, ToPort: 80, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "tcp", FromPort: 443, ToPort: 443, Cidrs: ["0.0.0.0/0"], Ipv6Cidrs: ["::/0"] },
    { Protocol: "tcp", FromPort: 22, ToPort: 22, CidrListAliases: ["lightsail-connect"] },
  ]);
  const [instanceId] = Object.keys(box.findResources("AWS::Lightsail::Instance"));
  box.hasResourceProperties("AWS::Lightsail::StaticIp", { AttachedTo: { Ref: instanceId } });
  assert.match(instance?.Properties.InstanceName, /^fidant-app-[0-9a-f]{8}$/);
  assert.match(instance?.Properties.UserData, /^fidant\.se \{$/m);
  assert.doesNotMatch(instance?.Properties.UserData, /@DOMAIN@/);
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
    ResourceRecords: [Match.stringLikeRegexp('^"v=DMARC1; p=(quarantine|reject)[;"]')],
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

test("a certificate validation record lands in the zone it belongs to", () => {
  dns.hasResourceProperties("AWS::Route53::RecordSet", {
    HostedZoneId: zoneRef("fidant.eu"),
    Name: "_a.www.fidant.eu.",
    Type: "CNAME",
    ResourceRecords: ["_b.acm-validations.aws."],
  });
});

test("every site name points at the distribution over IPv4 and IPv6", () => {
  for (const type of ["A", "AAAA"]) {
    for (const name of siteNames) {
      dns.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: `${name}.`,
        Type: type,
        AliasTarget: { DNSName: "d111.cloudfront.net", HostedZoneId: "Z2FDTNDATAQYW2" },
      });
    }
  }
});

test("one certificate covers every site name", () => {
  site.hasResourceProperties("AWS::CertificateManager::Certificate", {
    DomainName: "fidant.se",
    SubjectAlternativeNames: siteNames.filter((name) => name !== "fidant.se"),
    ValidationMethod: "DNS",
  });
});

test("the bucket is private and refuses plain HTTP", () => {
  site.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  site.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: "Deny",
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        }),
      ]),
    },
  });
});

test("the distribution serves every site name over HTTPS only", () => {
  site.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  site.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: Match.objectLike({
      Aliases: siteNames,
      ViewerCertificate: Match.objectLike({ MinimumProtocolVersion: "TLSv1.2_2021" }),
      DefaultCacheBehavior: Match.objectLike({
        ViewerProtocolPolicy: "redirect-to-https",
        FunctionAssociations: [Match.objectLike({ EventType: "viewer-request" })],
      }),
    }),
  });
});

test("a missing page answers 404, not S3's 403", () => {
  site.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: Match.objectLike({
      CustomErrorResponses: [
        Match.objectLike({ ErrorCode: 403, ResponseCode: 404, ResponsePagePath: "/index.html" }),
      ],
    }),
  });
});

test("responses carry a strict content security policy", () => {
  site.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
    ResponseHeadersPolicyConfig: Match.objectLike({
      SecurityHeadersConfig: Match.objectLike({
        ContentSecurityPolicy: Match.objectLike({
          ContentSecurityPolicy: Match.stringLikeRegexp("^default-src 'none';"),
        }),
      }),
    }),
  });
});
