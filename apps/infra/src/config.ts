export const primaryDomain = "fidant.se";
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
  apexTxt: ["protonmail-verification=14191306dac563a6cf145d0c0777d212920f3bf6"],
  mx: [],
  cnames: [],
  dmarc: undefined,
};

// Copied by hand from FidantCertificate and FidantSite, which deploy to another account.
export const certificateValidation: DnsRecord[] = [];
export const distributionDomain: string | undefined = undefined;
