import type { App } from "aws-cdk-lib";
import { BoxStack } from "./box.ts";
import { CiStack } from "./ci.ts";
import { alertEmail, boxAddress, hostedZoneIds, mail, relayAddresses } from "./config.ts";
import { DnsStack } from "./dns.ts";
import { DnssecStack } from "./dnssec.ts";

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
      boxAddress,
      relayAddresses,
    });
    new CiStack(app, "FidantCi", { env: { account, region: "eu-north-1" } });
    new DnssecStack(app, "FidantDnssec", {
      env: { account, region: "us-east-1" },
      terminationProtection: true,
      hostedZoneIds,
      alertEmail,
    });
  } else if (account === pocAccount) {
    new CiStack(app, "FidantCi", { env: { account, region: "eu-north-1" } });
    new BoxStack(app, "FidantApp", { env: { account, region: "eu-north-1" }, alertEmail });
  } else {
    throw new Error(`Account ${account} is neither FIDANT_DNS_ACCOUNT nor FIDANT_POC_ACCOUNT.`);
  }
}
