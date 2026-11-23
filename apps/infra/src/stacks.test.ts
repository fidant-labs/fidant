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

test("the fidant-dns account gets only the protected DNS stack", () => {
  const stacks = stacksFor(dnsAccount);
  assert.deepEqual(
    stacks.map((stack) => [stack.stackName, stack.region, stack.terminationProtection]),
    [["FidantDns", "eu-north-1", true]],
  );
});

test("the fidant-poc account gets only the site stack, in us-east-1", () => {
  const stacks = stacksFor(pocAccount);
  assert.deepEqual(
    stacks.map((stack) => [stack.stackName, stack.region]),
    [["FidantSite", "us-east-1"]],
  );
  Template.fromStack(stacks[0] as Stack);
});

test("any other account gets no stacks", () => {
  assert.throws(() => stacksFor(account), /neither FIDANT_DNS_ACCOUNT nor FIDANT_POC_ACCOUNT/);
  assert.throws(() => stacksFor(undefined), /aws sso login/);
  assert.throws(
    () => addStacks(new App(), { CDK_DEFAULT_ACCOUNT: dnsAccount }),
    /FIDANT_DNS_ACCOUNT and FIDANT_POC_ACCOUNT/,
  );
});

test("the committed config synthesizes and keeps the Proton verification record", () => {
  const [stack] = stacksFor(dnsAccount);
  Template.fromStack(stack as Stack).hasResourceProperties("AWS::Route53::RecordSet", {
    Name: "fidant.se.",
    Type: "TXT",
    ResourceRecords: Match.arrayWith([Match.stringLikeRegexp('^"protonmail-verification=')]),
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
