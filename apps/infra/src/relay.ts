import { createHash } from "node:crypto";
import { CfnOutput, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as lightsail from "aws-cdk-lib/aws-lightsail";
import { Construct } from "constructs";
import { renderRelayUserData } from "./user-data.ts";

const anywhere = { cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] };

export const ports: lightsail.CfnInstance.PortProperty[] = [
  { protocol: "tcp", fromPort: 22, toPort: 22, cidrListAliases: ["lightsail-connect"] },
  { protocol: "tcp", fromPort: 80, toPort: 80, ...anywhere },
  { protocol: "tcp", fromPort: 443, toPort: 443, ...anywhere },
  { protocol: "tcp", fromPort: 3478, toPort: 3478, ...anywhere },
  { protocol: "udp", fromPort: 3478, toPort: 3478, ...anywhere },
  { protocol: "udp", fromPort: 49152, toPort: 65535, ...anywhere },
];

export class RelayBox extends Construct {
  readonly instance: lightsail.CfnInstance;
  readonly address: lightsail.CfnStaticIp;

  constructor(scope: Construct, id: string, props: { relayId: string }) {
    super(scope, id);
    const { relayId } = props;
    const userData = renderRelayUserData({ id: relayId });
    this.instance = new lightsail.CfnInstance(this, "Box", {
      instanceName: `fidant-relay-${relayId}-${createHash("sha256").update(userData).digest("hex").slice(0, 8)}`,
      availabilityZone: `${Stack.of(this).region}a`,
      blueprintId: "ubuntu_24_04",
      bundleId: "micro_3_0",
      userData,
      networking: { ports },
    });

    this.address = new lightsail.CfnStaticIp(this, "Address", {
      staticIpName: `fidant-relay-${relayId}-ip`,
      attachedTo: this.instance.ref,
    });
    this.address.applyRemovalPolicy(RemovalPolicy.RETAIN);

    new CfnOutput(Stack.of(this), `Relay${relayId.charAt(0).toUpperCase()}${relayId.slice(1)}Ip`, {
      value: this.address.attrIpAddress,
    });
  }
}
