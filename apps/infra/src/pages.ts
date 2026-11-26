import { fileURLToPath } from "node:url";
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as pricingplanmanager from "aws-cdk-lib/aws-pricingplanmanager";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import { pagesBucket, primaryDomain, signalName, signals, zoneNames } from "./config.ts";

export const edgeFunctionFile = fileURLToPath(new URL("../edge/site.js", import.meta.url));

export type PagesStackProps = StackProps & { certificateIds: Record<string, string> };

export class PagesStack extends Stack {
  constructor(scope: Construct, id: string, props: PagesStackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "Pages", {
      bucketName: pagesBucket(this.account),
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    for (const zone of zoneNames) {
      const name = zone.replace(/(^|\.)(\w)/g, (_, _dot, letter: string) => letter.toUpperCase());
      const site = zone === primaryDomain;
      // A distribution on a flat-rate plan can share neither its function nor its web ACL.
      const edge = new cloudfront.Function(this, `${name}Function`, {
        code: cloudfront.FunctionCode.fromFile({ filePath: edgeFunctionFile }),
        runtime: cloudfront.FunctionRuntime.JS_2_0,
      });
      const firewall = new wafv2.CfnWebACL(this, `${name}Firewall`, {
        scope: "CLOUDFRONT",
        defaultAction: { allow: {} },
        rules: [],
        visibilityConfig: {
          sampledRequestsEnabled: false,
          cloudWatchMetricsEnabled: false,
          metricName: `${name}Firewall`,
        },
      });
      const viewerRequest = {
        function: edge,
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
      };
      const distribution = new cloudfront.Distribution(this, `${name}Distribution`, {
        domainNames: [zone, `www.${zone}`],
        certificate: acm.Certificate.fromCertificateArn(
          this,
          `${name}Certificate`,
          this.formatArn({
            service: "acm",
            resource: "certificate",
            resourceName: props.certificateIds[zone] ?? "",
          }),
        ),
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        enableIpv6: false,
        webAclId: firewall.attrArn,
        ...(site && { defaultRootObject: "pages/index.html" }),
        defaultBehavior: site
          ? {
              origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {
                originAccessLevels: [cloudfront.AccessLevel.READ, cloudfront.AccessLevel.LIST],
              }),
              viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
              cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
              compress: true,
              functionAssociations: [
                viewerRequest,
                { function: edge, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE },
              ],
            }
          : {
              // Never contacted: the function redirects every request on these names.
              origin: new origins.HttpOrigin(primaryDomain),
              viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
              cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
              functionAssociations: [viewerRequest],
            },
        ...(site && {
          additionalBehaviors: {
            "/relay-secret/*": {
              origin: new origins.HttpOrigin(signalName(signals[0]?.id ?? ""), {
                protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
              }),
              viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
              cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            },
          },
        }),
      });
      new pricingplanmanager.CfnSubscription(this, `${name}Plan`, {
        planFamily: "CloudFront",
        planTier: "FREE",
        usageLevel: "DEFAULT",
        resourceArns: [distribution.distributionArn, firewall.attrArn],
      });
      new CfnOutput(this, `${name}DistributionName`, {
        value: distribution.distributionDomainName,
      });
    }
  }
}
