import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";
import {
  type DnsRecord,
  type Mail,
  mailDomain,
  mailRegion,
  primaryDomain,
  relayName,
  signalName,
  zoneNames,
} from "./config.ts";

export type DnsStackProps = StackProps & {
  mail: Mail;
  boxAddress: string;
  relayAddresses: Record<string, string>;
  signalTargets: Record<string, string>;
  certificateRecords: DnsRecord[];
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

function addSesRecords(zone: route53.IHostedZone): void {
  const bounce = `bounce.${mailDomain}`;
  new route53.MxRecord(zone, "NotifyMx", {
    zone,
    recordName: mailDomain,
    values: [{ priority: 0, hostName: "." }],
  });
  new route53.TxtRecord(zone, "NotifySpf", {
    zone,
    recordName: mailDomain,
    values: ["v=spf1 -all"],
  });
  new route53.MxRecord(zone, "BounceMx", {
    zone,
    recordName: bounce,
    values: [{ priority: 10, hostName: `feedback-smtp.${mailRegion}.amazonses.com` }],
  });
  new route53.TxtRecord(zone, "BounceSpf", {
    zone,
    recordName: bounce,
    values: ["v=spf1 include:amazonses.com -all"],
  });
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
        addSesRecords(zone);
      } else {
        addNoMail(zone);
      }

      // Caddy falls back to ZeroSSL (Sectigo); ACM needs amazon.com.
      new route53.CaaRecord(zone, "Caa", {
        zone,
        values: [
          { flag: 0, tag: route53.CaaTag.ISSUE, value: "letsencrypt.org" },
          { flag: 0, tag: route53.CaaTag.ISSUE, value: "sectigo.com" },
          { flag: 0, tag: route53.CaaTag.ISSUE, value: "amazon.com" },
          { flag: 0, tag: route53.CaaTag.ISSUEWILD, value: ";" },
        ],
      });

      for (const record of props.certificateRecords) {
        if (record.name.endsWith(`.${zoneName}.`)) {
          new route53.CnameRecord(zone, record.name, {
            zone,
            recordName: record.name,
            domainName: record.value,
          });
        }
      }

      const target = route53.RecordTarget.fromIpAddresses(props.boxAddress);
      for (const recordName of [zoneName, `www.${zoneName}`]) {
        new route53.ARecord(zone, `${recordName} A`, {
          zone,
          recordName,
          target,
          ttl: Duration.seconds(60),
        });
      }
      if (zoneName === primaryDomain) {
        const recordName = `turn.${zoneName}`;
        new route53.ARecord(zone, `${recordName} A`, { zone, recordName, target });
        for (const [id, address] of Object.entries(props.relayAddresses)) {
          const name = relayName(id);
          new route53.ARecord(zone, `${name} A`, {
            zone,
            recordName: name,
            target: route53.RecordTarget.fromIpAddresses(address),
          });
        }
        for (const [id, domainName] of Object.entries(props.signalTargets)) {
          const recordName = signalName(id);
          new route53.CnameRecord(zone, `${recordName} CNAME`, {
            zone,
            recordName,
            domainName,
            ttl: Duration.seconds(60),
          });
        }
      }
    }
  }
}
