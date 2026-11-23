import { CfnOutput, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";
import { type Mail, primaryDomain, zoneNames } from "./config.ts";

export type DnsStackProps = StackProps & {
  mail: Mail;
  boxAddress: string;
};

function addMail(zone: route53.IHostedZone, mail: Mail): void {
  if (mail.apexTxt.length > 0) {
    new route53.TxtRecord(zone, "ApexTxt", { zone, values: mail.apexTxt });
  }
  if (mail.mx.length > 0) {
    new route53.MxRecord(zone, "Mx", { zone, values: mail.mx });
  }
  for (const record of mail.cnames) {
    new route53.CnameRecord(zone, record.name, {
      zone,
      recordName: record.name,
      domainName: record.value,
    });
  }
  if (mail.dmarc !== undefined) {
    new route53.TxtRecord(zone, "Dmarc", { zone, recordName: "_dmarc", values: [mail.dmarc] });
  }
}

function addNoMail(zone: route53.IHostedZone): void {
  new route53.MxRecord(zone, "NullMx", { zone, values: [{ priority: 0, hostName: "." }] });
  new route53.TxtRecord(zone, "Spf", { zone, values: ["v=spf1 -all"] });
  new route53.TxtRecord(zone, "Dmarc", {
    zone,
    recordName: "_dmarc",
    values: ["v=DMARC1; p=reject"],
  });
}

export class DnsStack extends Stack {
  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    for (const zoneName of zoneNames) {
      const zone = new route53.PublicHostedZone(this, zoneName, { zoneName });
      zone.applyRemovalPolicy(RemovalPolicy.RETAIN);
      new CfnOutput(this, `${zoneName} name servers`, {
        value: Fn.join(" ", zone.hostedZoneNameServers ?? []),
      });

      if (zoneName === primaryDomain) {
        addMail(zone, props.mail);
      } else {
        addNoMail(zone);
      }

      const target = route53.RecordTarget.fromIpAddresses(props.boxAddress);
      for (const recordName of [zoneName, `www.${zoneName}`]) {
        new route53.ARecord(zone, `${recordName} A`, { zone, recordName, target });
      }
    }
  }
}
