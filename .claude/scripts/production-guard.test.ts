import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./production-guard.sh", import.meta.url));

function guard(command: string): number | null {
  return spawnSync("bash", [script], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
  }).status;
}

test("blocks commands that update the production branch", () => {
  for (const command of [
    "git push origin +main:production",
    "git push origin :production",
    "git push origin HEAD:refs/heads/production",
    "git push origin production",
    "git push origin +production",
    "git push origin origin/main:production",
    'git push origin "+main:production"',
    "git -C /tmp/x push origin main:production",
    "git push --delete origin production",
    "git push origin \\\nmain:production",
    "cd /tmp && git push origin main:production",
    "git push origin main:production>/dev/null",
    "gh api -X PATCH repos/sigill-labs/sigill/git/refs/heads/production -f sha=abc -F force=false",
    "gh api -X DELETE repos/sigill-labs/sigill/git/refs/heads/production",
    "gh api --method=PATCH repos/sigill-labs/sigill/git/refs/heads/production -f sha=abc",
    "gh api repos/sigill-labs/sigill/git/refs -f ref=refs/heads/production -f sha=abc",
  ]) {
    assert.equal(guard(command), 2, command);
  }
});

test("allows commands that leave the production branch alone", () => {
  for (const command of [
    'git push -u origin sig-169-promote-branch && gh pr create --title "SIG-169: Deploy the app from a production branch"',
    "git push origin fix-production-docs",
    "git push origin main:production-docs",
    "git push origin refs/heads/production/x",
    "gh api repos/sigill-labs/sigill/git/refs/heads/production",
    "gh api repos/sigill-labs/sigill/git/refs/heads/production --jq .object.sha",
    "gh api -X GET repos/sigill-labs/sigill/git/refs/heads/production",
    "gh api repos/sigill-labs/sigill/environments/production",
    'git commit -m "docs: agents never push production"',
    "git log --oneline origin/production..origin/main",
    "git ls-remote origin refs/heads/production",
    "git fetch origin production",
    "git stash push -m production",
    "",
  ]) {
    assert.equal(guard(command), 0, command);
  }
});
