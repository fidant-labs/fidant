import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import * as kms from "aws-cdk-lib/aws-kms";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as sns from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

export type DnssecStackProps = StackProps & {
  hostedZoneIds: Record<string, string>;
  alertEmail: string;
};

const alarms = [
  ["DNSSECInternalFailure", "failure"],
  ["DNSSECKeySigningKeysNeedingAction", "key needs action"],
] as const;

export class DnssecStack extends Stack {
  constructor(scope: Construct, id: string, props: DnssecStackProps) {
    super(scope, id, props);

    const kmsKey = new kms.Key(this, "SigningKey", {
      description: "Signs the Fidant hosted zones with DNSSEC",
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const topic = new sns.Topic(this, "Alerts", { displayName: "Fidant DNSSEC" });
    topic.addSubscription(new EmailSubscription(props.alertEmail));
    const notify = new SnsAction(topic);

    for (const [zoneName, hostedZoneId] of Object.entries(props.hostedZoneIds)) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, `${zoneName} zone`, {
        hostedZoneId,
        zoneName,
      });
      const keySigningKey = new route53.KeySigningKey(this, `${zoneName} KSK`, {
        hostedZone,
        kmsKey,
        keySigningKeyName: zoneName.replaceAll(".", "_"),
      });
      new route53.CfnDNSSEC(this, `${zoneName} DNSSEC`, { hostedZoneId }).node.addDependency(
        keySigningKey,
      );

      for (const [metricName, label] of alarms) {
        const alarm = new cloudwatch.Alarm(this, `${zoneName} ${metricName}`, {
          alarmName: `Fidant DNSSEC ${label}: ${zoneName}`,
          metric: new cloudwatch.Metric({
            namespace: "AWS/Route53",
            metricName,
            dimensionsMap: { HostedZoneId: hostedZoneId },
            statistic: cloudwatch.Stats.SUM,
            period: Duration.hours(4),
          }),
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.IGNORE,
        });
        alarm.addAlarmAction(notify);
        alarm.addOkAction(notify);
      }
    }
  }
}
