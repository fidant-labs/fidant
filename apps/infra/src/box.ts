import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as lightsail from "aws-cdk-lib/aws-lightsail";
import type { Construct } from "constructs";
import { primaryDomain } from "./config.ts";

export class BoxStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const userData = readFileSync(
      new URL("../box/user-data.sh", import.meta.url),
      "utf8",
    ).replaceAll("@DOMAIN@", primaryDomain);
    const box = new lightsail.CfnInstance(this, "Box", {
      // A new user data replaces the instance, and CloudFormation creates the new one before deleting the old.
      instanceName: `fidant-app-${createHash("sha256").update(userData).digest("hex").slice(0, 8)}`,
      availabilityZone: `${this.region}a`,
      blueprintId: "ubuntu_24_04",
      bundleId: "micro_3_0",
      userData,
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
      staticIpName: "fidant-app-ip",
      attachedTo: box.ref,
    });

    new CfnOutput(this, "PublicIp", { value: address.attrIpAddress });
  }
}
