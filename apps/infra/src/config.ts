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

// Copied by hand from FidantSite, which deploys to another account.
export const certificateValidation: DnsRecord[] = [
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
];
export const distributionDomain: string | undefined = undefined;
