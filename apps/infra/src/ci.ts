import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import {
  imageRepository,
  pagesBucket,
  releaseRoleName,
  releaseSessionSeconds,
  signalCluster,
  signalService,
} from "./config.ts";

const issuer = "token.actions.githubusercontent.com";

export type CiStackProps = StackProps & { release?: boolean };

export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
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
          [`${issuer}:sub`]: "repo:fidant-labs@360211033/fidant@1468787132:environment:production",
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );

    if (props.release) {
      const release = new iam.Role(this, "Release", {
        roleName: releaseRoleName,
        maxSessionDuration: Duration.seconds(releaseSessionSeconds),
        assumedBy: new iam.WebIdentityPrincipal(github.oidcProviderArn, {
          StringEquals: {
            [`${issuer}:aud`]: "sts.amazonaws.com",
            [`${issuer}:sub`]: "repo:fidant-labs@360211033/fidant@1468787132:environment:app",
          },
        }),
      });
      for (const statement of [
        // ECR's GetAuthorizationToken takes no resource ARN, so only "*" matches it.
        new iam.PolicyStatement({ actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }),
        new iam.PolicyStatement({
          actions: [
            "ecr:BatchCheckLayerAvailability",
            "ecr:InitiateLayerUpload",
            "ecr:UploadLayerPart",
            "ecr:CompleteLayerUpload",
            "ecr:PutImage",
            "ecr:BatchGetImage",
          ],
          resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/${imageRepository}`],
        }),
        new iam.PolicyStatement({
          actions: ["ecs:DescribeServices", "ecs:UpdateService"],
          resources: [
            `arn:aws:ecs:${this.region}:${this.account}:service/${signalCluster}/${signalService}`,
          ],
        }),
        new iam.PolicyStatement({
          // A Deny on "true" refuses exec without refusing a request that leaves the key out.
          effect: iam.Effect.DENY,
          actions: ["ecs:UpdateService"],
          resources: ["*"],
          conditions: { StringEquals: { "ecs:enable-execute-command": "true" } },
        }),
        new iam.PolicyStatement({
          actions: ["s3:PutObject"],
          resources: [`arn:aws:s3:::${pagesBucket(this.account)}/*`],
          conditions: { StringEquals: { "s3:ResourceAccount": this.account } },
        }),
        new iam.PolicyStatement({
          actions: ["cloudformation:DescribeStacks"],
          resources: [
            `arn:aws:cloudformation:${this.region}:${this.account}:stack/FidantSignal/*`,
            `arn:aws:cloudformation:us-east-1:${this.account}:stack/FidantPages/*`,
          ],
        }),
      ]) {
        release.addToPolicy(statement);
      }
    }
  }
}
