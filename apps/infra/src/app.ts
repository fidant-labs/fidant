import type { App } from "aws-cdk-lib";
import { BoxStack } from "./box.ts";
import { CertsStack } from "./certs.ts";
import { CiStack } from "./ci.ts";
import {
  alertEmail,
  boxAddress,
  certificateIds,
  hostedZoneIds,
  mail,
  relayAddresses,
  signalName,
  signals,
  zoneNames,
} from "./config.ts";
import { DnsStack } from "./dns.ts";
import { DnssecStack } from "./dnssec.ts";
import { SignalStack } from "./signal.ts";

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
    new CiStack(app, "FidantCi", { env: { account, region: "eu-north-1" }, release: true });
    new BoxStack(app, "FidantApp", { env: { account, region: "eu-north-1" }, alertEmail });
    new CertsStack(app, "FidantPagesCerts", {
      env: { account, region: "us-east-1" },
      certificates: zoneNames.map((zone) => [zone, `www.${zone}`]),
    });
    new CertsStack(app, "FidantSignalCerts", {
      env: { account, region: "eu-north-1" },
      certificates: signals.map((signal) => [signalName(signal.id)]),
    });
    const signalCertificate = certificateIds.signal.sto;
    if (signalCertificate) {
      new SignalStack(app, "FidantSignal", {
        env: { account, region: "eu-north-1" },
        certificateId: signalCertificate,
      });
    }
  } else {
    throw new Error(`Account ${account} is neither FIDANT_DNS_ACCOUNT nor FIDANT_POC_ACCOUNT.`);
  }
}
