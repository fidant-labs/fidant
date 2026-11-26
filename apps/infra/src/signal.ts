import { CfnOutput, Duration, Stack, type StackProps, Validations } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import type { Construct } from "constructs";

export type SignalStackProps = StackProps & { certificateId: string };

export class SignalStack extends Stack {
  // Without this, CDK looks the zones up in the account at deploy time.
  override get availabilityZones(): string[] {
    return [`${this.region}a`, `${this.region}b`];
  }

  constructor(scope: Construct, id: string, props: SignalStackProps) {
    super(scope, id, props);
    Validations.of(this).acknowledge({
      id: "CloudFormation-Validate::W3010",
      reason: "Fn::GetAZs may reorder its list, which would replace a subnet.",
    });

    const vpc = new ec2.Vpc(this, "Network", {
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const balancer = new elbv2.ApplicationLoadBalancer(this, "Balancer", {
      vpc,
      internetFacing: true,
      loadBalancerName: "fidant-signal",
      idleTimeout: Duration.seconds(120),
      xffHeaderProcessingMode: elbv2.XffHeaderProcessingMode.APPEND,
      preserveXffClientPort: false,
    });
    // CDK leaves this out when false; the record wants it set.
    balancer.setAttribute("routing.http.xff_client_port.enabled", "false");

    const targets = new elbv2.ApplicationTargetGroup(this, "Targets", {
      vpc,
      targetGroupName: "fidant-signal",
      targetType: elbv2.TargetType.IP,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      port: 8443,
      deregistrationDelay: Duration.seconds(5),
      healthCheck: {
        // An ALB's health check speaks HTTP unless told otherwise; the server answers only HTTPS.
        protocol: elbv2.Protocol.HTTPS,
        path: "/relay-status",
        healthyHttpCodes: "200",
        interval: Duration.seconds(10),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
    });

    balancer.addListener("Https", {
      protocol: elbv2.ApplicationProtocol.HTTPS,
      port: 443,
      sslPolicy: elbv2.SslPolicy.TLS13_12_RES_PQ,
      certificates: [
        elbv2.ListenerCertificate.fromArn(
          this.formatArn({
            service: "acm",
            resource: "certificate",
            resourceName: props.certificateId,
          }),
        ),
      ],
      defaultTargetGroups: [targets],
    });

    new CfnOutput(this, "LoadBalancerName", { value: balancer.loadBalancerDnsName });
  }
}
