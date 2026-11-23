import { readFileSync } from "node:fs";
import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as lightsail from "aws-cdk-lib/aws-lightsail";
import type { Construct } from "constructs";
import { primaryDomain } from "./config.ts";

export class BoxStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const userData = readFileSync(new URL("../box/user-data.sh", import.meta.url), "utf8");
    const box = new lightsail.CfnInstance(this, "Box", {
      instanceName: "fidant-app",
      availabilityZone: `${this.region}a`,
      blueprintId: "ubuntu_24_04",
      bundleId: "micro_3_0",
      userData: userData.replaceAll("@DOMAIN@", primaryDomain),
      networking: {
        ports: [
          { protocol: "tcp", fromPort: 80, toPort: 80, cidrs: ["0.0.0.0/0"], ipv6Cidrs: ["::/0"] },
          {
            protocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrs: ["0.0.0.0/0"],
            ipv6Cidrs: ["::/0"],
          },
          { protocol: "tcp", fromPort: 22, toPort: 22, cidrListAliases: ["lightsail-connect"] },
        ],
      },
    });

    const address = new lightsail.CfnStaticIp(this, "Address", {
      staticIpName: "fidant-app",
      attachedTo: box.instanceName,
    });
    address.addDependency(box);

    new CfnOutput(this, "PublicIp", { value: address.attrIpAddress });
  }
}
