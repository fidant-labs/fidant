import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lightsail from "aws-cdk-lib/aws-lightsail";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import { mailDomain, relayCapBytes, relayWarnBytes } from "./config.ts";
import { renderUserData } from "./user-data.ts";

const anywhere = { cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] };

const otherPorts: lightsail.CfnInstance.PortProperty[] = [
  { protocol: "tcp", fromPort: 80, toPort: 80, ...anywhere },
  { protocol: "tcp", fromPort: 443, toPort: 443, ...anywhere },
  { protocol: "tcp", fromPort: 22, toPort: 22, cidrListAliases: ["lightsail-connect"] },
];

const relayPorts: lightsail.CfnInstance.PortProperty[] = [
  { protocol: "tcp", fromPort: 3478, toPort: 3478, ...anywhere },
  { protocol: "udp", fromPort: 3478, toPort: 3478, ...anywhere },
  { protocol: "udp", fromPort: 49152, toPort: 65535, ...anywhere },
];

export type BoxStackProps = StackProps & { alertEmail: string };

export class BoxStack extends Stack {
  constructor(scope: Construct, id: string, props: BoxStackProps) {
    super(scope, id, props);

    const userData = renderUserData();
    const box = new lightsail.CfnInstance(this, "Box", {
      // Lightsail updates user data in place without re-running it; a new name forces a fresh box.
      instanceName: `fidant-app-${createHash("sha256").update(userData).digest("hex").slice(0, 8)}`,
      availabilityZone: `${this.region}a`,
      blueprintId: "ubuntu_24_04",
      bundleId: "micro_3_0",
      userData,
      networking: {
        ports: [...otherPorts, ...relayPorts],
      },
    });

    const address = new lightsail.CfnStaticIp(this, "Address", {
      staticIpName: "fidant-app-ip",
      attachedTo: box.ref,
    });
    address.applyRemovalPolicy(RemovalPolicy.RETAIN);

    new CfnOutput(this, "PublicIp", { value: address.attrIpAddress });

    const fn = new lambda.Function(this, "RelayCap", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(fileURLToPath(new URL("./relay-cap/", import.meta.url)), {
        exclude: ["*.test.ts"],
      }),
      timeout: Duration.seconds(30),
      retryAttempts: 0,
      logGroup: new logs.LogGroup(this, "RelayCapLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        BOX: box.ref,
        LIMIT_BYTES: String(relayCapBytes),
        OPEN_PORTS: JSON.stringify([...otherPorts, ...relayPorts]),
        CAPPED_PORTS: JSON.stringify(otherPorts),
      },
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lightsail:GetInstanceMetricData", "lightsail:PutInstancePublicPorts"],
        resources: [box.attrInstanceArn],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [
          this.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: "fidant/relay-cap",
          }),
        ],
      }),
    );
    new events.Rule(this, "RelayCapSchedule", {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(fn, { retryAttempts: 0 })],
    });

    const configurationSet = new ses.ConfigurationSet(this, "MailConfig", {
      configurationSetName: "fidant-mail",
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
      disableSuppressionList: true,
      maxDeliveryDuration: Duration.minutes(15),
    });
    configurationSet.addEventDestination("Feedback", {
      destination: ses.EventDestination.snsTopic(new sns.Topic(this, "MailFeedback")),
      events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT],
    });
    const identity = new ses.EmailIdentity(this, "MailIdentity", {
      identity: ses.Identity.domain(mailDomain),
      configurationSet,
      mailFromDomain: `bounce.${mailDomain}`,
    });
    new iam.User(this, "MailUser", { userName: "fidant-mail" }).addToPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendRawEmail"],
        resources: [
          identity.emailIdentityArn,
          this.formatArn({
            service: "ses",
            resource: "configuration-set",
            resourceName: configurationSet.configurationSetName,
          }),
        ],
      }),
    );
    for (const [index, record] of identity.dkimRecords.entries()) {
      new CfnOutput(this, `Dkim${index + 1}`, { value: `${record.name} CNAME ${record.value}` });
    }

    const topic = new sns.Topic(this, "Alerts", { displayName: "Fidant relay" });
    topic.addSubscription(new EmailSubscription(props.alertEmail));
    const notify = new SnsAction(topic);
    const monthBytes = new cloudwatch.Metric({
      namespace: "Fidant",
      metricName: "RelayMonthBytes",
      dimensionsMap: { Service: "relay" },
      statistic: cloudwatch.Stats.MAXIMUM,
      period: Duration.minutes(5),
    });
    const alarms = [
      new cloudwatch.Alarm(this, "RelayWarn", {
        alarmName: "Fidant relay traffic past 80 % of the monthly cap",
        metric: monthBytes,
        threshold: relayWarnBytes,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.IGNORE,
      }),
      new cloudwatch.Alarm(this, "RelayCapped", {
        alarmName: "Fidant relay stopped: monthly traffic cap reached",
        metric: monthBytes,
        threshold: relayCapBytes,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.IGNORE,
      }),
      new cloudwatch.Alarm(this, "RelayCapFailing", {
        alarmName: "Fidant relay cap failing",
        metric: fn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      ...(
        [
          ["BounceRate", "bounce rate 5 % or more", 0.05],
          ["ComplaintRate", "complaint rate 0.1 % or more", 0.001],
        ] as const
      ).map(
        ([name, label, threshold]) =>
          new cloudwatch.Alarm(this, `Mail${name}`, {
            alarmName: `Fidant SES reputation: ${label}`,
            metric: new cloudwatch.Metric({
              namespace: "AWS/SES",
              metricName: `Reputation.${name}`,
              statistic: cloudwatch.Stats.MAXIMUM,
              period: Duration.hours(1),
            }),
            threshold,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            evaluationPeriods: 1,
            treatMissingData: cloudwatch.TreatMissingData.IGNORE,
          }),
      ),
    ];
    for (const alarm of alarms) {
      alarm.addAlarmAction(notify);
      alarm.addOkAction(notify);
    }
  }
}
