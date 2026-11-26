import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Validations,
} from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import {
  imageRepository,
  primaryDomain,
  relayName,
  relays,
  signalCluster,
  signalService,
} from "./config.ts";

export type SignalStackProps = StackProps & {
  certificateId: string;
  relayMasterGeneration: number;
};

export class SignalStack extends Stack {
  // Without this, CDK looks the zones up in the account at synth time.
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
    });
    balancer.setAttribute("routing.http.xff_client_port.enabled", "false");

    const targets = new elbv2.ApplicationTargetGroup(this, "Targets", {
      vpc,
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

    const master = new secretsmanager.Secret(this, `RelayMaster${props.relayMasterGeneration}`, {
      generateSecretString: {
        passwordLength: 64,
        excludeUppercase: true,
        excludePunctuation: true,
        excludeCharacters: "ghijklmnopqrstuvwxyz",
        includeSpace: false,
      },
    });

    const task = new ecs.FargateTaskDefinition(this, "Task", {
      family: signalService,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    task.addContainer("Signal", {
      containerName: "signal",
      image: ecs.ContainerImage.fromEcrRepository(
        ecr.Repository.fromRepositoryName(this, "Images", imageRepository),
        "live",
      ),
      versionConsistency: ecs.VersionConsistency.ENABLED,
      user: "node",
      stopTimeout: Duration.seconds(5),
      readonlyRootFilesystem: true,
      portMappings: [{ containerPort: 8443 }],
      environment: {
        SIGNALING_ONLY: "1",
        PUBLIC_ORIGIN: `https://${primaryDomain}`,
        TRUSTED_PROXIES: vpc.publicSubnets.map((subnet) => subnet.ipv4CidrBlock).join(","),
        RELAYS_FILE: "/app/apps/server/relays.json",
        RELAY_MASTER_FILE: "/run/sigill/relay-master",
        CERT_DIR: "/run/sigill/certs",
        STUN_URLS: relays.map((relay) => `stun:${relayName(relay.id)}:3478`).join(","),
        HTTP_KEEP_ALIVE_MS: "125000",
      },
      secrets: { RELAY_MASTER: ecs.Secret.fromSecretsManager(master) },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "signal",
        logGroup: new logs.LogGroup(this, "Logs", {
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      }),
    });
    // CDK's mount option type has no form that carries a value.
    (task.node.defaultChild as ecs.CfnTaskDefinition).addPropertyOverride(
      "ContainerDefinitions.0.LinuxParameters.Tmpfs",
      [
        {
          ContainerPath: "/run/sigill",
          Size: 1,
          MountOptions: ["noexec", "nosuid", "nodev", "uid=1000", "gid=1000", "mode=700"],
        },
      ],
    );

    const service = new ecs.FargateService(this, "Service", {
      serviceName: signalService,
      cluster: new ecs.Cluster(this, "Cluster", {
        clusterName: signalCluster,
        vpc,
        containerInsightsV2: ecs.ContainerInsights.DISABLED,
      }),
      taskDefinition: task,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.DISABLED,
      enableExecuteCommand: false,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    targets.addTarget(service);

    new CfnOutput(this, "LoadBalancerDnsName", { value: balancer.loadBalancerDnsName });
  }
}
