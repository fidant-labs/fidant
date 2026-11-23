import { Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

const issuer = "token.actions.githubusercontent.com";

export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const github = new iam.OidcProviderNative(this, "GitHub", {
      url: `https://${issuer}`,
      clientIds: ["sts.amazonaws.com"],
    });

    const role = new iam.Role(this, "Deploy", {
      roleName: "fidant-ci-deploy",
      assumedBy: new iam.WebIdentityPrincipal(github.oidcProviderArn, {
        StringEquals: {
          [`${issuer}:aud`]: "sts.amazonaws.com",
          // GitHub's immutable subject format: owner and repository carry their numeric IDs.
          [`${issuer}:sub`]: "repo:sigill-labs@360211033/sigill@1468787132:environment:production",
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );
  }
}
