import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { smtpPassword } from "./smtp-password.ts";

// AWS's documented example key pair; the password is what AWS's published Python script prints.
const accessKeyId = "AKIAIOSFODNN7EXAMPLE";
const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const password = "BPfy85A/4ChxYc0s4mIG5bpIlvRl5AP1uupODe8KaHpf"; // gitleaks:allow (from AWS's example key)

const run = (input: string) =>
  spawnSync(process.execPath, [fileURLToPath(new URL("./smtp-password.ts", import.meta.url))], {
    input,
    encoding: "utf8",
  });

test("derives the SES SMTP password for eu-north-1 as AWS's script does", () => {
  assert.equal(smtpPassword(secret, "eu-north-1"), password);
});

test("prints the SMTP user name and password from create-access-key, never the secret key", () => {
  const result = run(
    JSON.stringify({
      AccessKey: { UserName: "fidant-mail", AccessKeyId: accessKeyId, SecretAccessKey: secret },
    }),
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `SMTP user name: ${accessKeyId}\nSMTP password: ${password}\n`);
  assert.equal(result.stderr, "");
});

test("refuses anything else without echoing it", () => {
  for (const input of [secret, JSON.stringify({ AccessKey: { SecretAccessKey: secret } })]) {
    const result = run(input);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(secret));
  }
});
