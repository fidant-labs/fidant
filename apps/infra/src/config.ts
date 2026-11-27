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
// Names, not IDs: before any rename, deploy FidantCi trusting only the new path (apps/infra/AGENTS.md).
export const releaseWorkflow = "fidant-labs/fidant/.github/workflows/release-jobs.yml";

export function pagesBucket(account: string): string {
  return `fidant-pages-${account}`;
}

// Raise to make a new relay master; the task restarts with it.
export const relayMasterGeneration = 1;

// Copied by hand from ACM's certificate ARNs.
export const certificateIds: { pages: Record<string, string>; signal: Record<string, string> } = {
  pages: {
    "fidant.se": "11748fd1-b51a-4368-bdf7-27fd30a1d526",
    "fidant.eu": "a0d54a8d-5907-494c-b89f-0181240252fa",
    "fidant.org": "768aa32e-631e-4ae0-a65b-e960835ec45d",
  },
  signal: { sto: "ebce34f6-e758-4771-af75-7fd7be208c9b" },
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

// Copied by hand from FidantSignal's LoadBalancerDnsName output.
export const signalTargets: Record<string, string> = {
  sto: "fidant-signal-1565593186.eu-north-1.elb.amazonaws.com",
};

// Copied by hand from `aws route53 list-hosted-zones --profile fidant-dns`; FidantDnssec signs these.
export const hostedZoneIds: Record<string, string> = {
  "fidant.se": "Z09335241R9IEYU9VDLYT",
  "fidant.eu": "Z09323213U4PW8PVU0GWR",
  "fidant.org": "Z09257402SNQGKKFL536D",
};

// Copied by hand from `aws acm describe-certificate`, under DomainValidationOptions[].ResourceRecord.
export const certificateRecords: DnsRecord[] = [
  {
    name: "_937db4927b3b55bae071f79808a4e888.fidant.se.",
    value: "_d912ee8c3adf9e6a9550c2ffb8ede4c7.wzccmgtwzk.acm-validations.aws.",
  },
  {
    name: "_6f08bf588a8e42f84be6d9a39f80b3c8.www.fidant.se.",
    value: "_0296af4596dfb5955ca959f527f41ba7.wzccmgtwzk.acm-validations.aws.",
  },
  {
    name: "_cf5a75a2f79bf19fc053d89d4d1d9bd9.fidant.eu.",
    value: "_7acbd12d240f29bb664c1c9f90b1f38e.wzccmgtwzk.acm-validations.aws.",
  },
  {
    name: "_a6c8c3b2e7c9f12d38890ef70aef6e27.www.fidant.eu.",
    value: "_c41ea245bdf156bdd8df6cbbbad6abad.wzccmgtwzk.acm-validations.aws.",
  },
  {
    name: "_062cc81580f28b524f642e66900610df.fidant.org.",
    value: "_0f22f3345a5b685d958aa644726e57a3.wzccmgtwzk.acm-validations.aws.",
  },
  {
    name: "_a568c88b528b8f7cf72a2beea55a36e2.www.fidant.org.",
    value: "_8b294111155dcd659581ad2c02003c36.wzccmgtwzk.acm-validations.aws.",
  },
  {
    name: "_3422cc2f70c992f75faae58aa426f45a.sto.signal.fidant.se.",
    value: "_0473ccf35b4cb81b45ff8ac067ac3e74.wzccmgtwzk.acm-validations.aws.",
  },
];

export const alertEmail = "budget-alert@fidant.se";

export const boxAllowanceBytes = 2_000_000_000_000;
export const overageUsdPerGb = 0.09;
export const relayOverageBudgetUsd = 20;
