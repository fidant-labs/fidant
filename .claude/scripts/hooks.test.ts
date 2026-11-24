import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const scripts = import.meta.dirname;
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

let root: string;
let repo: string;

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env }).toString();

function hook(script: string, command: string, cwd = root, extraEnv: object = {}) {
  const input = JSON.stringify({ cwd, tool_input: { command } });
  const r = spawnSync("bash", [join(scripts, script)], {
    input,
    env: { ...env, ...extraEnv },
  });
  return { code: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "sigill-hooks-"));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(root, "origin.git")], { env });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  git("remote", "add", "origin", join(root, "origin.git"));
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("push", "-q", "-u", "origin", "main");
  git("remote", "set-head", "origin", "main");
  git("checkout", "-q", "-b", "sig-12-thing");
  mkdirSync(join(repo, "sub"));
  execFileSync("bash", ["-c", "printf 'a\\nb\\n' > sub/f.txt"], { cwd: repo });
  git("add", ".");
  git("commit", "-q", "-m", "change");
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("review gate", () => {
  const gate = (command: string, cwd = root) => hook("review-gate.sh", command, cwd);

  test("ignores commands that do not create a pull request", () => {
    for (const c of ["ls", 'echo "gh pr create"', "git log --grep='gh pr create'", "gh pr view"]) {
      assert.equal(gate(`cd ${repo} && ${c}`).code, 0, c);
    }
  });

  test("blocks every way to run gh pr create before a mark", () => {
    for (const c of [
      "gh pr create",
      "gh -R o/r pr create",
      "gh --repo=o/r pr create",
      "if gh pr create; then :; fi",
      "! gh pr create",
      "nohup gh pr create",
      "FOO=1 timeout 5 gh pr create",
    ]) {
      const r = gate(`cd ${repo} && ${c}`);
      assert.equal(r.code, 2, c);
      assert.match(r.err, /no clean review/, c);
    }
  });

  test("blocks a cd target it cannot resolve", () => {
    assert.match(gate("cd $WT && gh pr create").err, /cannot resolve/);
  });

  test("passes after a mark, also with colour and relative diff config", () => {
    execFileSync("bash", [join(scripts, "review-gate.sh"), "mark"], { cwd: repo, env });
    assert.equal(gate(`cd ${repo} && gh pr create`).code, 0);
    assert.equal(gate(`cd "${repo}" && gh pr create --head sig-12-thing`).code, 0);
    assert.equal(gate("gh pr create --head me:sig-12-thing", repo).code, 0);
    git("config", "color.ui", "always");
    git("config", "diff.relative", "true");
    try {
      assert.equal(gate("gh pr create", join(repo, "sub")).code, 0);
    } finally {
      git("config", "--unset", "color.ui");
      git("config", "--unset", "diff.relative");
    }
  });

  test("blocks when --head names another branch", () => {
    const r = gate(`cd ${repo} && gh pr create --base main --head sig-99-other`);
    assert.equal(r.code, 2);
    assert.match(r.err, /--head sig-99-other is not the checked-out branch/);
  });

  test("blocks without jq instead of passing", () => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(execFileSync("bash", ["-c", "command -v cat"]).toString().trim(), join(bin, "cat"));
    const run = (command: string) =>
      spawnSync("/bin/bash", [join(scripts, "review-gate.sh")], {
        input: JSON.stringify({ cwd: repo, tool_input: { command } }),
        env: { PATH: bin },
      });
    assert.equal(run("gh pr create").status, 2);
    assert.equal(run("ls").status, 0);
  });
});

describe("behind-main hook", () => {
  test("checks the cd or git -C target, not the session folder", () => {
    git("checkout", "-q", "main");
    git("commit", "-q", "--allow-empty", "-m", "newer");
    git("push", "-q", "origin", "main");
    git("checkout", "-q", "sig-12-thing");
    for (const c of [`cd ${repo} && git push`, `git -C ${repo} push -u origin x`]) {
      assert.match(hook("behind-main.sh", c).out, /behind origin\/main/, c);
    }
    assert.equal(hook("behind-main.sh", `cd ${repo} && echo git push`).out, "");
  });
});

describe("Linear reminder", () => {
  const remind = (command: string) => hook("linear-reminder.sh", command).out;

  test("names the issue of the branch the pull request is for", () => {
    assert.match(remind(`cd ${repo} && gh pr create`), /SIG-12/);
    assert.match(remind(`cd ${repo} && gh pr create --head sig-34-x`), /SIG-34/);
  });

  test("does not ask for Done while auto-merge is only queued", () => {
    assert.match(remind("gh pr merge 5 --auto --squash"), /only queued/);
    assert.match(remind("gh pr merge 5 --squash"), /to Done\./);
  });

  test("ignores the phrase inside an argument", () => {
    assert.equal(remind('git commit -m "gh pr merge later"'), "");
  });
});
