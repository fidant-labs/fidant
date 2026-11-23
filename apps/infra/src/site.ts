import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { primaryDomain, siteNames } from "./config.ts";

export class CertificateStack extends Stack {
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: primaryDomain,
      subjectAlternativeNames: siteNames.filter((name) => name !== primaryDomain),
      validation: acm.CertificateValidation.fromDns(),
    });
  }
}

export type SiteStackProps = StackProps & { certificate: acm.ICertificate };

export class SiteStack extends Stack {
  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, { ...props, crossRegionReferences: true });

    const bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    const redirect = new cloudfront.Function(this, "Redirect", {
      code: cloudfront.FunctionCode.fromFile({
        filePath: fileURLToPath(new URL("redirect.js", import.meta.url)),
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "Headers", {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy:
            "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
      },
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames: siteNames,
      certificate: props.certificate,
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        functionAssociations: [
          { function: redirect, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
    });

    new s3deploy.BucketDeployment(this, "Page", {
      sources: [s3deploy.Source.asset(fileURLToPath(new URL("../site", import.meta.url)))],
      destinationBucket: bucket,
      distribution,
    });

    new CfnOutput(this, "DistributionDomain", { value: distribution.distributionDomainName });
  }
}
