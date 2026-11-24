import assert from "node:assert/strict";
import { test } from "node:test";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { zoneNames } from "./config.ts";
import { DnssecStack } from "./dnssec.ts";

const hostedZoneIds = Object.fromEntries(
  zoneNames.map((zoneName, index) => [zoneName, `Z000000000000000000000${index}`]),
);

const dnssec = Template.fromStack(
  new DnssecStack(new App(), "Dnssec", {
    env: { account: "111111111111", region: "us-east-1" },
    hostedZoneIds,
    alertEmail: "alerts@example.test",
  }),
);

function logicalId(type: string, match: (properties: Record<string, unknown>) => boolean): string {
  const ids = Object.entries(dnssec.findResources(type))
    .filter(([, resource]) => match(resource.Properties ?? {}))
    .map(([id]) => id);
  assert.equal(ids.length, 1, `${type}: ${ids.join(", ")}`);
  return ids[0] ?? "";
}

test("one retained P-256 signing key signs every zone", () => {
  dnssec.resourceCountIs("AWS::KMS::Key", 1);
  dnssec.hasResource("AWS::KMS::Key", {
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
    Properties: { KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY" },
  });
  const keyArn = { "Fn::GetAtt": [logicalId("AWS::KMS::Key", () => true), "Arn"] };
  dnssec.resourceCountIs("AWS::Route53::KeySigningKey", 3);
  for (const [zoneName, hostedZoneId] of Object.entries(hostedZoneIds)) {
    dnssec.hasResourceProperties("AWS::Route53::KeySigningKey", {
      HostedZoneId: hostedZoneId,
      KeyManagementServiceArn: keyArn,
      Name: zoneName.replaceAll(".", "_"),
      Status: "ACTIVE",
    });
  }
});

test("Route 53 may sign with the key only on behalf of these zones", () => {
  const [key] = Object.values(dnssec.findResources("AWS::KMS::Key"));
  const statements: { Principal?: { Service?: string }; Action: string | string[] }[] =
    key?.Properties.KeyPolicy.Statement ?? [];
  const signing = statements.filter(
    (statement) =>
      statement.Principal?.Service === "dnssec-route53.amazonaws.com" &&
      [statement.Action].flat().includes("kms:Sign"),
  );
  assert.equal(signing.length, zoneNames.length);
  for (const hostedZoneId of Object.values(hostedZoneIds)) {
    dnssec.hasResource("AWS::KMS::Key", {
      Properties: {
        KeyPolicy: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: "dnssec-route53.amazonaws.com" },
              Condition: {
                ArnEquals: {
                  "aws:SourceArn": {
                    "Fn::Join": ["", Match.arrayWith([`:route53:::hostedzone/${hostedZoneId}`])],
                  },
                },
              },
            }),
          ]),
        },
      },
    });
  }
});

test("signing turns on only after the zone's signing key exists", () => {
  dnssec.resourceCountIs("AWS::Route53::DNSSEC", 3);
  for (const hostedZoneId of Object.values(hostedZoneIds)) {
    const ksk = logicalId("AWS::Route53::KeySigningKey", (p) => p.HostedZoneId === hostedZoneId);
    dnssec.hasResource("AWS::Route53::DNSSEC", {
      Properties: { HostedZoneId: hostedZoneId },
      DependsOn: Match.arrayWith([ksk]),
    });
  }
});

test("a DNSSEC failure or a key needing action emails the alert address", () => {
  dnssec.hasResourceProperties("AWS::SNS::Subscription", {
    Protocol: "email",
    Endpoint: "alerts@example.test",
  });
  const topic = { Ref: logicalId("AWS::SNS::Topic", () => true) };
  dnssec.resourceCountIs("AWS::CloudWatch::Alarm", 6);
  for (const hostedZoneId of Object.values(hostedZoneIds)) {
    for (const metricName of ["DNSSECInternalFailure", "DNSSECKeySigningKeysNeedingAction"]) {
      dnssec.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: Match.stringLikeRegexp("^Fidant DNSSEC "),
        Namespace: "AWS/Route53",
        MetricName: metricName,
        Dimensions: [{ Name: "HostedZoneId", Value: hostedZoneId }],
        Statistic: "Sum",
        Threshold: 1,
        AlarmActions: [topic],
        OKActions: [topic],
      });
    }
  }
});

// Once DS records are published, replacing the key or a KSK takes the domain offline.
test("the signing key and the KSKs keep their logical IDs", () => {
  assert.deepEqual(
    [
      logicalId("AWS::KMS::Key", () => true),
      ...Object.values(hostedZoneIds).map((id) =>
        logicalId("AWS::Route53::KeySigningKey", (p) => p.HostedZoneId === id),
      ),
    ],
    [
      "SigningKeyEEFC2790", // gitleaks:allow (a CloudFormation logical ID, not a secret)
      "fidantseKSKCDF312A8",
      "fidanteuKSK9D9C34BB",
      "fidantorgKSKB1D633B2",
    ],
  );
});
