import assert from "node:assert/strict";
import { test } from "node:test";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { siteNames } from "./config.ts";
import { DnsStack } from "./dns.ts";
import { CertificateStack, SiteStack } from "./site.ts";

const account = "111111111111";

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
  const { certificate } = new CertificateStack(app, "Certificate", {
    env: { account, region: "us-east-1" },
  });
  const site = new SiteStack(app, "Site", { env: { account, region: "eu-north-1" }, certificate });
  return {
    dns: Template.fromStack(dns),
    certificate: Template.fromStack(certificate.stack),
    site: Template.fromStack(site),
  };
}

const { dns, certificate, site } = synth();

function zoneRef(zoneName: string): { Ref: string } {
  const [id] = Object.entries(dns.findResources("AWS::Route53::HostedZone")).find(
    ([, zone]) => zone.Properties.Name === `${zoneName}.`,
  ) ?? [""];
  return { Ref: id };
}

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
  certificate.hasResourceProperties("AWS::CertificateManager::Certificate", {
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
