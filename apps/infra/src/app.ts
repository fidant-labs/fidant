import type { App } from "aws-cdk-lib";
import { BoxStack } from "./box.ts";
import { CiStack } from "./ci.ts";
import { boxAddress, certificateValidation, distributionDomain, mail } from "./config.ts";
import { DnsStack } from "./dns.ts";
import { SiteStack } from "./site.ts";

export function addStacks(app: App, env: Record<string, string | undefined>): void {
  const account = env.CDK_DEFAULT_ACCOUNT;
  if (!account) {
    throw new Error(
      "No AWS account: sign in with `aws sso login --sso-session fidant` and pass --profile.",
    );
  }
  const dnsAccount = env.FIDANT_DNS_ACCOUNT;
  const pocAccount = env.FIDANT_POC_ACCOUNT;
  if (!dnsAccount || !pocAccount) {
    throw new Error("Set FIDANT_DNS_ACCOUNT and FIDANT_POC_ACCOUNT in apps/infra/.env.");
  }

  if (account === dnsAccount) {
    new DnsStack(app, "FidantDns", {
      env: { account, region: "eu-north-1" },
      terminationProtection: true,
      mail,
      certificateValidation,
      distributionDomain,
      boxAddress,
    });
    new CiStack(app, "FidantCi", { env: { account, region: "eu-north-1" } });
  } else if (account === pocAccount) {
    new SiteStack(app, "FidantSite", { env: { account, region: "us-east-1" } });
    // IAM is global; us-east-1 is where this account is already bootstrapped.
    new CiStack(app, "FidantCi", { env: { account, region: "us-east-1" } });
    new BoxStack(app, "FidantApp", { env: { account, region: "eu-north-1" } });
  } else {
    throw new Error(`Account ${account} is neither FIDANT_DNS_ACCOUNT nor FIDANT_POC_ACCOUNT.`);
  }
}
