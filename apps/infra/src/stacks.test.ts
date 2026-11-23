import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { addStacks } from "./app.ts";
import { siteNames } from "./config.ts";
import { DnsStack } from "./dns.ts";
import { SiteStack } from "./site.ts";

const account = "111111111111";
const dnsAccount = "222222222222";
const pocAccount = "333333333333";

function synth() {
  const app = new App();
  const dns = new DnsStack(app, "Dns", {
    env: { account, region: "eu-north-1" },
    mail: {
      apexTxt: ["verify=1", "v=spf1 include:mail.example ~all"],
      mx: [{ priority: 10, hostName: "mx.example" }],
      cnames: [{ name: "key._domainkey", value: "key.example" }],
      dmarc: "v=DMARC1; p=quarantine",
    },
    certificateValidation: [{ name: "_a.www.fidant.eu.", value: "_b.acm-validations.aws." }],
    distributionDomain: "d111.cloudfront.net",
  });
  const site = new SiteStack(app, "Site", { env: { account, region: "us-east-1" } });
  return { dns: Template.fromStack(dns), site: Template.fromStack(site) };
}

const { dns, site } = synth();

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

test("the fidant-poc account gets the site stack and the CI stack, in us-east-1", () => {
  const stacks = stacksFor(pocAccount);
  assert.deepEqual(
    stacks.map((stack) => [stack.stackName, stack.region]),
    [
      ["FidantSite", "us-east-1"],
      ["FidantCi", "us-east-1"],
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
    for (const type of ["A", "AAAA"]) {
      committed.hasResourceProperties(recordSet, {
        Name: `${name}.`,
        Type: type,
        AliasTarget: { DNSName: Match.stringLikeRegexp("^d[a-z0-9]+\\.cloudfront\\.net$") },
      });
    }
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
    ResourceRecords: [Match.stringLikeRegexp('^"v=DMARC1; p=(quarantine|reject)[;"]')],
  });
});

test("the committed config keeps a validation record and an alias for every site name", () => {
  const [stack] = stacksFor(dnsAccount);
  const template = Template.fromStack(stack as Stack);
  for (const name of siteNames) {
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: Match.stringLikeRegexp(`^_[0-9a-f]+\\.${name.replaceAll(".", "\\.")}\\.$`),
      Type: "CNAME",
      ResourceRecords: [Match.stringLikeRegexp("\\.acm-validations\\.aws\\.$")],
    });
    for (const type of ["A", "AAAA"]) {
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: `${name}.`,
        Type: type,
        AliasTarget: {
          DNSName: Match.stringLikeRegexp("^d[0-9a-z]+\\.cloudfront\\.net$"),
          HostedZoneId: "Z2FDTNDATAQYW2",
        },
      });
    }
  }
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
