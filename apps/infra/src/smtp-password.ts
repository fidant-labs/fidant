import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export function smtpPassword(secretAccessKey: string, region: string): string {
  let key: Buffer = Buffer.from(`AWS4${secretAccessKey}`);
  for (const message of ["11111111", region, "ses", "aws4_request", "SendRawEmail"]) {
    key = createHmac("sha256", key).update(message).digest();
  }
  return Buffer.concat([Buffer.from([4]), key]).toString("base64");
}

if (import.meta.main) {
  let accessKey: { AccessKeyId?: unknown; SecretAccessKey?: unknown } | undefined;
  try {
    accessKey = JSON.parse(readFileSync(0, "utf8")).AccessKey;
  } catch {
    // JSON.parse's message quotes the input, which may hold the secret key.
  }
  const id = accessKey?.AccessKeyId;
  const secret = accessKey?.SecretAccessKey;
  if (typeof id !== "string" || !/^AKIA[A-Z2-7]{16}$/.test(id) || typeof secret !== "string") {
    console.error("Pipe in the output of `aws iam create-access-key --output json`.");
    process.exit(1);
  }
  console.log(`SMTP user name: ${id}\nSMTP password: ${smtpPassword(secret, "eu-north-1")}`);
}
