import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const scripts = import.meta.dirname;
// HOME is the temp dir and inherited GIT_* variables are dropped: the pre-push hook runs this
// test inside git, and GIT_DIR and friends would point every command at the wrong repo.
const root = mkdtempSync(join(tmpdir(), "fidant-hooks-"));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  HOME: root,
  CLAUDE_PROJECT_DIR: root,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

let repo: string;

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env }).toString();

function hook(script: string, command: string, cwd = root) {
  const input = JSON.stringify({ cwd, tool_input: { command } });
  const r = spawnSync("bash", [join(scripts, script)], {
    input,
    env,
  });
  return { code: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
}

before(() => {
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(root, "origin.git")], { env });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  git("remote", "add", "origin", join(root, "origin.git"));
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("push", "-q", "-u", "origin", "main");
  git("remote", "set-head", "origin", "main");
  git("checkout", "-q", "-b", "fid-12-thing");
  mkdirSync(join(repo, "sub"));
  execFileSync("bash", ["-c", "printf 'a\\nb\\n' > sub/f.txt"], { cwd: repo });
  git("add", ".");
  git("commit", "-q", "-m", "change");
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("review gate", () => {
  const gate = (command: string, cwd = root) => hook("review-gate.sh", command, cwd);

  test("ignores commands that do not create a pull request", () => {
    for (const c of ["ls", "gh pr view", 'git commit -m "through the approach, renew"']) {
      assert.equal(gate(`cd ${repo} && ${c}`).code, 0, c);
    }
  });

  test("blocks gh pr create in any shape it cannot follow, before looking for a mark", () => {
    const other = mkdtempSync(join(root, "other-"));
    for (const c of [
      'echo "gh pr create"',
      "git log --grep='gh pr create'",
      'bash -c "gh pr create --fill"',
      "/opt/homebrew/bin/gh pr create",
      'FOO="a b" gh pr create',
      "env -u X gh pr create",
      "gh -Ro/r pr create",
      "sudo gh pr create",
      "xargs gh pr create",
      "eval gh pr create",
      `pushd ${repo} && gh pr create`,
      `if cd ${repo}; then gh pr create; fi`,
      `cd ${repo} & gh pr create`,
      `cd ${repo} || gh pr create`,
      `cd ${repo} && (cd ${other}); gh pr create`,
      `cd ${repo} && git push && gh pr create`,
      `cd ${repo} && gh pr create; cd ${other} && gh pr create`,
    ]) {
      const r = gate(c, repo);
      assert.equal(r.code, 2, c);
      assert.match(r.err, /cannot tell which branch/, c);
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
    assert.match(gate(`cd ${repo}/missing && gh pr create`).err, /cannot resolve/);
  });

  test("passes after a mark, also with colour and relative diff config", () => {
    execFileSync("bash", [join(scripts, "review-gate.sh"), "mark"], { cwd: repo, env });
    assert.equal(gate(`cd ${repo} && gh pr create`).code, 0);
    assert.equal(gate(`cd "${repo}" && gh pr create --head fid-12-thing`).code, 0);
    assert.equal(gate("gh pr create -Hfid-12-thing", repo).code, 0);
    git("config", "color.ui", "always");
    git("config", "diff.relative", "true");
    try {
      assert.equal(gate("gh pr create", join(repo, "sub")).code, 0);
    } finally {
      git("config", "--unset", "color.ui");
      git("config", "--unset", "diff.relative");
    }
  });

  test("passes a marked branch for gh pr commands that create nothing", () => {
    for (const c of [
      "gh pr list --search new",
      "gh pr comment 5 --body 'new findings'",
      "git commit -m 'gh pr: create new flow'",
      "gh pr create --title 'a b' --head fid-12-thing",
      "gh pr create --title x --body-file body.md",
    ]) {
      const r = gate(`cd ${repo} && ${c}`);
      assert.equal(r.code, 0, `${c}: ${r.err}`);
    }
  });

  test("blocks a body that mentions the command or --head, and points at --body-file", () => {
    for (const c of [
      "gh pr create --title x --body 'gh pr create is now gated'",
      "gh pr create --title x --body 'use -H to pick'",
      "gh pr create --body-file - <<EOF\nuse --head foo\nEOF",
    ]) {
      const r = gate(`cd ${repo} && ${c}`);
      assert.equal(r.code, 2, c);
      assert.match(r.err, /--body-file/, c);
    }
  });

  test("blocks when --head names another branch", () => {
    const r = gate(`cd ${repo} && gh pr create --base main --head fid-99-other`);
    assert.equal(r.code, 2);
    assert.match(r.err, /--head 'fid-99-other' is not the checked-out branch/);
  });

  test("blocks a --head that quoting, heredocs or continuations hide from the argument cut", () => {
    for (const c of [
      "gh pr create --title 'a; b' --head other",
      "gh pr create --body 'Q&A' --head other",
      "gh pr create --body-file - --head other <<'EOF'\nbody\nEOF",
      "gh pr create \\\n  --head other",
      "gh pr create -Hother",
      "gh pr create -dH other",
      "gh pr create -wHother",
      'gh pr create "--head" other',
      "gh pr create '-H' other",
      "gh pr create --head fid-12-thing --head other",
      "gh pr create --title 'a b' --head other",
      "gh pr create --body 'x y' -H other --body 'p q'",
      "gh pr create --head",
      "gh pr create --head me:fid-12-thing",
      "gh pr create $'--head' other",
      "gh pr create {--head,other}",
      'gh pr "create" --head other',
      "gh pr cre\\ate --head other",
    ]) {
      const r = gate(`cd ${repo} && ${c}`);
      assert.equal(r.code, 2, c);
      assert.match(r.err, /not the checked-out branch/, c);
    }
  });

  test("blocks a hidden --head or second create that escaped quotes or bash -c could hide", () => {
    for (const c of [
      "gh pr create --title 'Don'\\''t x' --head other --body 'c d'",
      "gh pr create --title $'it\\'s a' --head other --body 'c d'",
      'gh pr create --title "Fix \\"x" --head other --body "y z"',
      "gh pr create --title it\\'s --head other --body 'a b'",
      'gh pr create && bash -c "gh pr create --head other"',
      'gh pr create; sh -c "cd /tmp && gh pr create --fill"',
      'gh pr create && bash -c -- "gh pr create --head other"',
    ]) {
      assert.equal(gate(`cd ${repo} && ${c}`).code, 2, c);
    }
  });

  test("blocks gh pr new and -R between pr and the subcommand", () => {
    rmSync(join(repo, ".git", "deep-review-clean"));
    for (const c of [
      "gh pr new",
      "gh pr   new",
      "gh pr\tnew",
      "gh pr -R o/r create",
      "gh -R o/r pr --repo=o/r new",
    ]) {
      assert.match(gate(`cd ${repo} && ${c}`).err, /no clean review/, c);
    }
  });

  test("blocks a real gh pr create after a heredoc", () => {
    const r = gate(`cd ${repo}\ncat > f <<'EOF'\ntext\nEOF\ngh pr create`);
    assert.equal(r.code, 2);
  });

  test("blocks a real create after a heredoc start it cannot close", () => {
    for (const c of [
      'git commit -m "docs: explain <<EOF parsing"\ngh pr create',
      "cat > f <<EOF-BODY\nx\nEOF-BODY\ngh pr create",
      `cat > f <<EOF-BODY\nx\nEOF-BODY\ncd ${repo} && gh pr create`,
      "cat > f <<END.\nx\nEND.\ngh pr create",
      "echo $((a<<b))\ngh pr create",
      "x=\"$(cat <<'EOF'\nbody\nEOF)\"\ngh pr create",
      'git commit -qm "docs: explain <<EOF parsing"\ngh pr create --body-file - <<EOF\nbody\nEOF',
    ]) {
      assert.equal(gate(`cd ${repo}\n${c}`).code, 2, c);
    }
  });

  test("fails closed when command.sh cannot be loaded", () => {
    const dir = mkdtempSync(join(root, "alone-"));
    copyFileSync(join(scripts, "review-gate.sh"), join(dir, "review-gate.sh"));
    const r = spawnSync("bash", [join(dir, "review-gate.sh")], {
      input: JSON.stringify({ cwd: repo, tool_input: { command: "gh pr create" } }),
      env,
    });
    assert.equal(r.status, 2);
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
    for (const c of [
      "gh pr new",
      "gh pr\t new",
      "gh  pr   create",
      "gh pr -R o/r create",
      "gh pr --repo=o/r new",
      "gh pr\tcreate",
      'gh pr "create"',
    ]) {
      assert.equal(run(c).status, 2, c);
    }
    assert.equal(run("ls").status, 0);
  });
});

describe("behind-main hook", () => {
  test("checks the cd or git -C target, not the session folder", () => {
    git("checkout", "-q", "main");
    git("commit", "-q", "--allow-empty", "-m", "newer");
    git("push", "-q", "origin", "main");
    git("checkout", "-q", "fid-12-thing");
    for (const c of [`cd ${repo} && git push`, `git -C ${repo} push -u origin x`]) {
      assert.match(hook("behind-main.sh", c).out, /behind origin\/main/, c);
    }
    assert.equal(hook("behind-main.sh", `cd ${repo} && echo git push`).out, "");
    assert.match(hook("behind-main.sh", `cd ${repo} && gh pr new`).out, /behind origin\/main/);
  });

  test("does not enter or fetch in a target outside CLAUDE_PROJECT_DIR", () => {
    const marker = join(root, "ssh-ran");
    const script = join(root, "evil-ssh.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const evil = join(mkdtempSync(join(tmpdir(), "fidant-evil-")), "repo");
    try {
      execFileSync("git", ["clone", "-q", repo, evil], { env });
      execFileSync("git", ["-C", evil, "config", "core.sshCommand", script], { env });
      execFileSync("git", ["-C", evil, "remote", "set-url", "origin", "ssh://host/x"], { env });
      for (const c of [`cd ${evil} && git push`, `git -C ${evil} push`]) {
        assert.equal(hook("behind-main.sh", c).out, "", c);
      }
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(join(evil, ".."), { recursive: true, force: true });
    }
  });

  test("does nothing without CLAUDE_PROJECT_DIR", () => {
    const e = { ...env } as Record<string, string | undefined>;
    delete e.CLAUDE_PROJECT_DIR;
    const r = spawnSync("bash", [join(scripts, "behind-main.sh")], {
      input: JSON.stringify({ cwd: repo, tool_input: { command: "git push" } }),
      env: e,
    });
    assert.equal(r.stdout.toString(), "");
  });
});

describe("Linear reminder", () => {
  const remind = (command: string) => hook("linear-reminder.sh", command).out;

  test("names the issue of the branch the pull request is for", () => {
    assert.match(remind(`cd ${repo} && gh pr create`), /FID-12/);
    assert.match(remind(`cd ${repo} && gh pr create --head fid-56-x`), /FID-56/);
  });

  test("does not ask for Done while auto-merge is only queued", () => {
    assert.match(remind("gh pr merge 5 --auto --squash"), /only queued/);
    assert.match(remind("gh pr merge 5 --auto --squash"), /FID key/);
    assert.match(remind("gh pr merge 5 --squash"), /FID key/);
    assert.match(remind("gh pr merge 5 --squash"), /to Done\./);
  });

  test("handles gh pr new, and gives no reminder for --disable-auto", () => {
    assert.match(remind(`cd ${repo} && gh pr new`), /FID-12/);
    assert.equal(remind("gh pr merge 5 --disable-auto"), "");
  });

  test("ignores the phrase inside an argument", () => {
    assert.equal(remind('git commit -m "gh pr merge later"'), "");
  });
});

describe("session-title.sh", () => {
  const titles = () => join(root, ".claude", "session-titles");
  const run = (session_id: string) => {
    const r = spawnSync("bash", [join(scripts, "session-title.sh")], {
      input: JSON.stringify({ session_id, prompt: "hi" }),
      env,
    });
    return { code: r.status, out: r.stdout.toString() };
  };

  test("applies a queued title once, then removes it", () => {
    mkdirSync(titles(), { recursive: true });
    writeFileSync(join(titles(), "abc-123"), "FID 82 - A title");
    const first = run("abc-123");
    assert.equal(first.code, 0);
    assert.equal(JSON.parse(first.out).hookSpecificOutput.sessionTitle, "FID 82 - A title");
    assert.equal(existsSync(join(titles(), "abc-123")), false);
    assert.deepEqual(run("abc-123"), { code: 0, out: "" });
  });

  test("ignores a session id that would leave the titles directory", () => {
    writeFileSync(join(root, ".claude", "x"), "outside");
    assert.deepEqual(run("../x"), { code: 0, out: "" });
    assert.equal(existsSync(join(root, ".claude", "x")), true);
  });
});
