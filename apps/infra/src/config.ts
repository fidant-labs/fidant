export const primaryDomain = "fidant.se";
export const mailDomain = `notify.${primaryDomain}`;
export const mailRegion = "eu-north-1";
export const mailFrom = `noreply@${mailDomain}`;
export const zoneNames = ["fidant.se", "fidant.eu", "fidant.org"];
export const siteNames = zoneNames.flatMap((zone) => [zone, `www.${zone}`]);
export const relays: readonly { id: string }[] = [{ id: "sto" }];

export function relayName(id: string): string {
  return `${id}.relay.${primaryDomain}`;
}

export const signals: readonly { id: string }[] = [{ id: "sto" }];

export function signalName(id: string): string {
  return `${id}.signal.${primaryDomain}`;
}

export const imageRepository = "fidant-signal";
export const signalCluster = "fidant";
export const signalService = "fidant-signal";
export const releaseRoleName = "fidant-release";
export const releaseSessionSeconds = 7200;

export function pagesBucket(account: string): string {
  return `fidant-pages-${account}`;
}

// Raise to make a new relay master; the task restarts with it.
export const relayMasterGeneration = 1;

// Copied by hand from ACM's certificate ARNs; FidantSignal joins the app once signal.sto is set.
export const certificateIds: { pages: Record<string, string>; signal: Record<string, string> } = {
  pages: {},
  signal: {},
};

export type DnsRecord = { name: string; value: string };

export type Mail = {
  apexTxt: string[];
  mx: { priority: number; hostName: string }[];
  cnames: DnsRecord[];
  dmarc: string | undefined;
};

export const mail: Mail = {
  apexTxt: [
    "protonmail-verification=14191306dac563a6cf145d0c0777d212920f3bf6",
    "v=spf1 include:_spf.protonmail.ch ~all",
    "google-site-verification=j_NhK4gVOu5Zuhu5RISrTo5KEJ2fXd_SFm09d2rQjOs",
  ],
  mx: [
    { priority: 10, hostName: "mail.protonmail.ch" },
    { priority: 20, hostName: "mailsec.protonmail.ch" },
  ],
  cnames: [
    {
      name: "protonmail._domainkey",
      value:
        "protonmail.domainkey.dhkoy2kpqzgitcjo5lp2rla56inbsysez2ptt23kic7qovs46e27q.domains.proton.ch.",
    },
    {
      name: "protonmail2._domainkey",
      value:
        "protonmail2.domainkey.dhkoy2kpqzgitcjo5lp2rla56inbsysez2ptt23kic7qovs46e27q.domains.proton.ch.",
    },
    {
      name: "protonmail3._domainkey",
      value:
        "protonmail3.domainkey.dhkoy2kpqzgitcjo5lp2rla56inbsysez2ptt23kic7qovs46e27q.domains.proton.ch.",
    },
    // Copied by hand from the Dkim outputs of FidantApp.
    {
      name: "34qpeb7n2xavgzsxnenyhgkjd5kt75c5._domainkey.notify",
      value: "34qpeb7n2xavgzsxnenyhgkjd5kt75c5.dkim.amazonses.com.",
    },
    {
      name: "efohmshcde4wtw42tjq3dvuvknf2cozj._domainkey.notify",
      value: "efohmshcde4wtw42tjq3dvuvknf2cozj.dkim.amazonses.com.",
    },
    {
      name: "em3mbshffy5n5xqfhm4q2hgtdlfzd5ia._domainkey.notify",
      value: "em3mbshffy5n5xqfhm4q2hgtdlfzd5ia.dkim.amazonses.com.",
    },
  ],
  dmarc: "v=DMARC1; p=reject",
};

// Copied by hand from the PublicIp output of FidantApp, which deploys to another account.
export const boxAddress = "16.192.25.20";

// Copied by hand from FidantApp's `Relay<Id>Ip` outputs, the way `boxAddress` is.
export const relayAddresses: Record<string, string> = { sto: "13.51.1.111" };

// Copied by hand from `aws route53 list-hosted-zones --profile fidant-dns`; FidantDnssec signs these.
export const hostedZoneIds: Record<string, string> = {
  "fidant.se": "Z09335241R9IEYU9VDLYT",
  "fidant.eu": "Z09323213U4PW8PVU0GWR",
  "fidant.org": "Z09257402SNQGKKFL536D",
};

export const alertEmail = "budget-alert@fidant.se";

export const boxAllowanceBytes = 2_000_000_000_000;
export const overageUsdPerGb = 0.09;
export const relayOverageBudgetUsd = 20;
