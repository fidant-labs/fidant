export const primaryDomain = "fidant.se";
export const mailDomain = `notify.${primaryDomain}`;
export const mailFrom = `noreply@${mailDomain}`;
export const zoneNames = ["fidant.se", "fidant.eu", "fidant.org"];
export const siteNames = zoneNames.flatMap((zone) => [zone, `www.${zone}`]);

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
  ],
  dmarc: "v=DMARC1; p=reject",
};

// Copied by hand from the PublicIp output of FidantApp, which deploys to another account.
export const boxAddress = "16.192.25.20";

// Copied by hand from `aws route53 list-hosted-zones --profile fidant-dns`; FidantDnssec signs these.
export const hostedZoneIds: Record<string, string> = {
  "fidant.se": "Z09335241R9IEYU9VDLYT",
  "fidant.eu": "Z09323213U4PW8PVU0GWR",
  "fidant.org": "Z09257402SNQGKKFL536D",
};

export const alertEmail = "budget-alert@fidant.se";

export const relayCapBytes = 1_800_000_000_000;
export const relayWarnBytes = 1_440_000_000_000;
