import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./production-guard.sh", import.meta.url));

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function guard(command: string, cwd?: string): number | null {
  return spawnSync("bash", [script], {
    env,
    input: JSON.stringify({ tool_input: { command }, cwd }),
  }).status;
}

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});
const git = (dir: string, ...args: string[]) => {
  const result = spawnSync(
    "git",
    ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { env },
  );
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
};
function makeRepo(withProduction: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "production-guard-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "--allow-empty", "-qm", "x");
  if (withProduction) {
    git(dir, "branch", "production");
    git(dir, "tag", "production");
  }
  return dir;
}

test("blocks commands that update the production branch", () => {
  for (const command of [
    "git push origin +main:production",
    "git push origin :production",
    "git push origin HEAD:refs/heads/production",
    "git push origin production",
    "git push origin main:heads/production",
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
    "gh api --method=PATCH repos/sigill-labs/sigill/git/refs/heads/production",
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
    "git push origin refs/heads/production-x",
    "gh api repos/sigill-labs/sigill/git/refs/heads/production",
    "gh api repos/sigill-labs/sigill/git/refs/heads/production --jq .object.sha",
    "gh api -X GET repos/sigill-labs/sigill/git/refs/heads/production",
    "gh api -X PUT repos/sigill-labs/sigill/environments/production",
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

test("blocks every push from a repository that has a local production branch", () => {
  const withProd = makeRepo(true);
  const withoutProd = makeRepo(false);
  const elsewhere = mkdtempSync(join(tmpdir(), "production-guard-"));
  dirs.push(elsewhere);
  const expect = (command: string, cwd: string, status: number) =>
    assert.equal(guard(command, cwd), status, command);

  for (const command of [
    "git push",
    "git push origin HEAD",
    "git push -u origin some-branch",
    "git push origin --branches",
    "git push origin :",
  ]) {
    expect(command, withProd, 2);
  }
  git(withProd, "checkout", "-q", "production");
  expect("git push", withProd, 2);
  git(withProd, "checkout", "-q", "main");

  for (const command of ["git push", "git push -u origin some-branch", "git push origin --all"]) {
    expect(command, withoutProd, 0);
  }
  expect("git push --mirror origin", withoutProd, 2);

  for (const command of [
    "git checkout production && git merge --ff-only origin/main && git push",
    "git switch -c production && git push",
    "git fetch origin production:production && git push",
  ]) {
    expect(command, withoutProd, 2);
  }
  expect(
    "git log --oneline refs/remotes/origin/production..refs/remotes/origin/main && git push -u origin some-branch",
    withoutProd,
    0,
  );
  expect('cd "$(git rev-parse --show-toplevel)" && git push --all', withProd, 2);
  expect("cd nonexist; git push --all", withProd, 2);

  expect(`git -C ${withProd} push`, elsewhere, 2);
  expect(`cd ${withProd} && git push`, elsewhere, 2);
  expect(`git -C ${withoutProd} push`, elsewhere, 0);
});
