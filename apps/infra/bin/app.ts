import { App } from "aws-cdk-lib";
import { certificateValidation, distributionDomain, mail } from "../src/config.ts";
import { DnsStack } from "../src/dns.ts";
import { CertificateStack, SiteStack } from "../src/site.ts";

const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account) {
  throw new Error("No AWS account: run the cdk CLI with --profile.");
}

const app = new App();
new DnsStack(app, "FidantDns", {
  env: { account, region: "eu-north-1" },
  mail,
  certificateValidation,
  distributionDomain,
});
const { certificate } = new CertificateStack(app, "FidantCertificate", {
  env: { account, region: "us-east-1" },
});
new SiteStack(app, "FidantSite", { env: { account, region: "eu-north-1" }, certificate });
