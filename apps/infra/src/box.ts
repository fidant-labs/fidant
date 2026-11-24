import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as lightsail from "aws-cdk-lib/aws-lightsail";
import type { Construct } from "constructs";
import { boxAddress, primaryDomain, siteNames } from "./config.ts";

const root = new URL("../../../", import.meta.url);
const nodeMajor = readFileSync(new URL(".node-version", root), "utf8").trim();
const pnpmVersion = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
).packageManager.replace(/^pnpm@/, "");

export class BoxStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const turnserverConf = readFileSync(new URL("../box/turnserver.conf", import.meta.url), "utf8");
    const userData = readFileSync(new URL("../box/user-data.sh", import.meta.url), "utf8")
      .replaceAll("@TURNSERVER_CONF@", turnserverConf.trimEnd())
      .replaceAll("@NODE_MAJOR@", nodeMajor)
      .replaceAll("@PNPM_VERSION@", pnpmVersion)
      .replaceAll("@REDIRECT_NAMES@", siteNames.filter((name) => name !== primaryDomain).join(", "))
      .replaceAll("@DOMAIN@", primaryDomain)
      .replaceAll("@BOX_ADDRESS@", boxAddress);
    const box = new lightsail.CfnInstance(this, "Box", {
      // Lightsail updates user data in place without re-running it; a new name forces a fresh box.
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
          {
            protocol: "tcp",
            fromPort: 3478,
            toPort: 3478,
            cidrs: ["0.0.0.0/0"],
            ipv6Cidrs: ["::/0"],
          },
          {
            protocol: "udp",
            fromPort: 3478,
            toPort: 3478,
            cidrs: ["0.0.0.0/0"],
            ipv6Cidrs: ["::/0"],
          },
          {
            protocol: "udp",
            fromPort: 49152,
            toPort: 65535,
            cidrs: ["0.0.0.0/0"],
            ipv6Cidrs: ["::/0"],
          },
        ],
      },
    });

    const address = new lightsail.CfnStaticIp(this, "Address", {
      staticIpName: "fidant-app-ip",
      attachedTo: box.ref,
    });
    address.applyRemovalPolicy(RemovalPolicy.RETAIN);

    new CfnOutput(this, "PublicIp", { value: address.attrIpAddress });
  }
}
