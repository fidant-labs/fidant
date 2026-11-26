import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseRoleName } from "../../infra/src/ci.ts";
import { imageRepository, signalCluster, signalService } from "../../infra/src/config.ts";

const workflow = readFileSync(
  new URL("../../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

function run(name: string): string {
  const start = workflow.indexOf(`- name: ${name}\n`);
  assert.ok(start > 0, name);
  const script = workflow.slice(start).match(/\n( +)run: \|\n((?:\1 +.*\n|\n)+)/)?.[2];
  assert.ok(script, name);
  const indent = script.length - script.trimStart().length;
  return script
    .split("\n")
    .map((line) => line.slice(indent))
    .join("\n");
}

const imageInputs = workflow.match(/\n +IMAGE_INPUTS: (.+)\n/)?.[1]?.split(" ") ?? [];

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function bash(script: string, cwd: string, extra: Record<string, string>) {
  return spawnSync("/bin/bash", ["-e", "-c", script], {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
  });
}

function git(cwd: string, ...args: string[]): string {
  const { status, stdout } = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
  assert.equal(status, 0, args.join(" "));
  return stdout.trim();
}

function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the build job releases only a commit on main's first-parent history", () => {
  withDir((dir) => {
    const src = join(dir, "src");
    const work = join(dir, "work");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    git(src, "commit", "-q", "--allow-empty", "-m", "a");
    git(src, "checkout", "-q", "-b", "feature");
    git(src, "commit", "-q", "--allow-empty", "-m", "b");
    const side = git(src, "rev-parse", "HEAD");
    git(src, "checkout", "-q", "main");
    git(src, "merge", "-q", "--no-ff", "-m", "m", "feature");
    const tip = git(src, "rev-parse", "HEAD");
    git(dir, "clone", "-q", src, work);
    const check = (sha: string) => {
      const { status, stdout } = bash(run("Check the commit is on main"), work, { SHA: sha });
      return { status, said: stdout.trim() };
    };

    assert.deepEqual(check(tip), { status: 0, said: "" });
    assert.deepEqual(check(side), { status: 1, said: `::error::refused ${side}: not on main` });
    assert.deepEqual(check(""), { status: 1, said: "::error::unexpected commit" });
    git(src, "branch", "-m", "main", "trunk");
    git(work, "fetch", "-q", "--prune", "origin");
    assert.deepEqual(check(tip), {
      status: 1,
      said: `::error::could not check ${tip} against main`,
    });
  });
});

test("the image key changes with each image input and with nothing else", () => {
  withDir((dir) => {
    const repo = join(dir, "repo");
    const output = join(dir, "output");
    for (const path of [...imageInputs, "apps/web"]) {
      mkdirSync(join(repo, path), { recursive: true });
      writeFileSync(join(repo, path, "f"), "0");
    }
    git(repo, "init", "-q");
    const commit = () => {
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "--allow-empty", "-m", "c");
    };
    const key = () => {
      writeFileSync(output, "");
      const { status } = bash(run("Key the image inputs"), repo, {
        IMAGE_INPUTS: imageInputs.join(" "),
        GITHUB_OUTPUT: output,
      });
      return { failed: status !== 0, output: readFileSync(output, "utf8") };
    };
    commit();
    let last = key();
    assert.match(last.output, /^key=[0-9a-f]{64}\n$/);
    writeFileSync(join(repo, "apps/web/f"), "1");
    commit();
    assert.deepEqual(key(), last);
    for (const path of imageInputs) {
      writeFileSync(join(repo, path, "f"), "1");
      commit();
      const next = key();
      assert.equal(next.failed, false, path);
      assert.notEqual(next.output, last.output, path);
      last = next;
    }
    git(repo, "rm", "-q", "-r", "packages/protocol");
    commit();
    assert.deepEqual(key(), { failed: true, output: "" });
  });
});

test("the image key covers every file the image is built from", () => {
  const allowed = readFileSync(
    new URL("../../server/Dockerfile.dockerignore", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.startsWith("!"))
    .map((line) => line.slice(1));
  assert.ok(allowed.length > 0);
  for (const path of [
    ...allowed,
    "apps/server/Dockerfile",
    "apps/server/Dockerfile.dockerignore",
  ]) {
    assert.ok(
      imageInputs.some((input) => path === input || path.startsWith(`${input}/`)),
      path,
    );
  }
});

test("the release workflow pins its actions and keeps credentials away from repository code", () => {
  for (const action of workflow.match(/uses: \S+/g) ?? []) {
    assert.match(action, /@[0-9a-f]{40}$/);
  }
  for (const [, , script] of workflow.matchAll(/\n( +)run: \|\n((?:\1 +.*\n|\n)+)/g)) {
    assert.match(script ?? "", /^ *set -euo pipefail\n/);
    assert.doesNotMatch(script ?? "", /\$\{\{/);
  }
  const buildAt = workflow.indexOf("\n  build:\n");
  const releaseAt = workflow.indexOf("\n  release:\n");
  assert.ok(buildAt > 0 && releaseAt > buildAt);
  const build = workflow.slice(buildAt, releaseAt);
  const release = workflow.slice(releaseAt);
  assert.match(workflow.slice(0, buildAt), /\npermissions: \{\}\n/);
  assert.match(build, /\n {4}permissions:\n {6}contents: read\n {4}\S/);
  assert.match(release, /\n {4}permissions:\n {6}id-token: write\n {4}\S/);
  assert.doesNotMatch(build, /id-token|secrets\./);
  assert.doesNotMatch(release, /checkout|pnpm|node /);
  assert.match(release, /\n {4}environment: app\n/);
});

test("the release workflow names what the infra names", () => {
  for (const text of [
    `repo=${imageRepository}\n`,
    `--cluster ${signalCluster} --services ${signalService}`,
    `--cluster ${signalCluster} --service ${signalService}`,
    `:role/${releaseRoleName}\n`,
    "aws-region: eu-north-1",
  ]) {
    assert.ok(workflow.includes(text), text);
  }
});

test("the release job refuses a run that is not production's tip before it gets credentials, and keeps its session longer than its waits", () => {
  const release = workflow.slice(workflow.indexOf("\n  release:\n"));
  const check = release.indexOf("- name: Check the commit is production's tip\n");
  const credentials = release.indexOf("uses: aws-actions/configure-aws-credentials@");
  assert.ok(check > 0 && check < credentials);
  const seconds = [...run("Push the image, move live and redeploy").matchAll(/SECONDS \+ (\d+)/g)];
  const settles = [
    ...run("Push the image, move live and redeploy").matchAll(/^ *settled (\d+)$/gm),
  ];
  const waits = [...seconds, ...settles].map(([, n]) => Number(n));
  assert.equal(waits.length, 3);
  const session = Number(release.match(/role-duration-seconds: (\d+)/)?.[1]);
  const timeout = Number(release.match(/\n {4}timeout-minutes: (\d+)/)?.[1]) * 60;
  assert.ok(waits.reduce((a, b) => a + b) < timeout);
  assert.ok(timeout < session);
});

function tipCheck(sha: string, remote: string) {
  let result: { status: number | null; stdout: string } | undefined;
  withDir((dir) => {
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin", "git"),
      `#!/bin/sh\n[ "$*" = "ls-remote https://github.com/o/r refs/heads/production" ] || exit 2\n${remote}\n`,
      { mode: 0o755 },
    );
    const { status, stdout } = bash(run("Check the commit is production's tip"), dir, {
      PATH: `${dir}/bin:${process.env.PATH}`,
      GITHUB_REPOSITORY: "o/r",
      SHA: sha,
    });
    result = { status, stdout: stdout.trim() };
  });
  assert.ok(result);
  return result;
}

test("a release run for any commit but production's tip refuses", () => {
  const tip = "a".repeat(40);
  const older = "c".repeat(40);
  assert.deepEqual(tipCheck(tip, `printf '${tip}\\trefs/heads/production\\n'`), {
    status: 0,
    stdout: "",
  });
  assert.deepEqual(tipCheck(older, `printf '${tip}\\trefs/heads/production\\n'`), {
    status: 1,
    stdout: `::error::refused ${older}: production is at ${tip}, and only its newest release runs`,
  });
  for (const remote of ["exit 1", "true"]) {
    assert.deepEqual(tipCheck(tip, remote), {
      status: 1,
      stdout: "::error::could not read production's tip",
    });
  }
  assert.deepEqual(tipCheck("", "true"), { status: 1, stdout: "::error::unexpected commit" });
});

const fake = `
const fs = require("node:fs");
const tool = require("node:path").basename(process.argv[1]);
const args = process.argv.slice(2);
const said = args.join(" ");
const input = tool === "docker" && args[0] === "login" ? fs.readFileSync(0, "utf8") : "";
const state = JSON.parse(fs.readFileSync(process.env.STATE, "utf8"));
const at = (flag) => args[args.indexOf(flag) + 1];
const finish = (call, out, error) => {
  state.calls.push(call);
  fs.writeFileSync(process.env.STATE, JSON.stringify(state));
  if (error) {
    fs.writeSync(2, "An error occurred (" + error + ") when calling the operation: test\\n");
    process.exit(254);
  }
  if (out !== undefined) fs.writeSync(1, typeof out === "string" ? out : JSON.stringify(out));
  process.exit(0);
};
const ecs = (answer) => (answer?.startsWith?.("!") ? [undefined, answer.slice(1)] : [answer]);
const registry = "123456789012.dkr.ecr.eu-north-1.amazonaws.com";
if (tool === "aws" && /^ecr batch-get-image --repository-name fidant-signal --image-ids \\S+ --output json$/.test(said)) {
  const id = at("--image-ids");
  const digest = id.startsWith("imageTag=") ? state.tags[id.slice(9)] : id.slice(12);
  finish("batch-get-image " + id, state.images.includes(digest)
    ? { images: [{ imageId: { imageDigest: digest }, imageManifest: "manifest:" + digest, imageManifestMediaType: "application/vnd.oci.image.manifest.v1+json" }], failures: [] }
    : { images: [], failures: [{ imageId: {}, failureCode: "ImageNotFound" }] });
} else if (tool === "aws" && /^ecr put-image --repository-name fidant-signal --image-tag \\S+ --image-manifest manifest:\\S+ --image-manifest-media-type application\\/vnd\\.oci\\.image\\.manifest\\.v1\\+json$/.test(said)) {
  const tag = at("--image-tag");
  const digest = at("--image-manifest").slice(9);
  const call = "put-image " + tag + " " + digest;
  if (state.lost?.[tag]) {
    state.tags[tag] = state.lost[tag];
    delete state.lost[tag];
    finish(call, undefined, "ImageTagAlreadyExistsException");
  }
  if (state.tags[tag] === digest) finish(call, undefined, "ImageAlreadyExistsException");
  if (state.tags[tag] && tag !== "live") finish(call, undefined, "ImageTagAlreadyExistsException");
  state.tags[tag] = digest;
  finish(call, "{}");
} else if (tool === "aws" && said === "ecr get-login-password --region eu-north-1") {
  finish("get-login-password", "password");
} else if (tool === "aws" && said === "ecs describe-services --cluster fidant --services fidant-signal --output json") {
  const answer = state.services.length > 1 ? state.services.shift() : state.services[0];
  finish("describe-services", ...ecs(answer));
} else if (tool === "aws" && said === "ecs update-service --cluster fidant --service fidant-signal --force-new-deployment --output json") {
  finish("update-service", ...ecs(state.update));
} else if (tool === "docker" && said === "load -i " + process.env.RUNNER_TEMP + "/image/image.tar") {
  finish("docker load");
} else if (tool === "docker" && said === "login --username AWS --password-stdin " + registry) {
  if (input !== "password") finish("docker login without the password");
  finish("docker login");
} else if (tool === "docker" && said === "tag fidant-signal:build " + registry + "/fidant-signal:" + process.env.SHA) {
  finish("docker tag");
} else if (tool === "docker" && said === "push --quiet " + registry + "/fidant-signal:" + process.env.SHA) {
  state.images.push("sha256:new");
  state.tags[process.env.SHA] = "sha256:new";
  finish("docker push");
} else {
  finish("unexpected: " + tool + " " + said, undefined, "Unexpected");
}
`;

const sha = "a".repeat(40);
const key = "b".repeat(64);

type Deployment = [id: string, status: string, rolloutState: string];
const service = (...deployments: Deployment[]) => ({
  services: [
    {
      status: "ACTIVE",
      deployments: deployments.map(([id, status, rolloutState]) => ({ id, status, rolloutState })),
    },
  ],
  failures: [],
});
const steady = service(["ecs-svc/1", "PRIMARY", "COMPLETED"]);
const rolling = service(
  ["ecs-svc/2", "PRIMARY", "IN_PROGRESS"],
  ["ecs-svc/1", "ACTIVE", "COMPLETED"],
);
const started = { service: rolling.services[0] };

function release(start: {
  tags: Record<string, string>;
  services?: unknown[];
  update?: unknown;
  lost?: Record<string, string>;
  expire?: boolean;
  stop?: boolean;
}) {
  let result:
    | {
        status: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        calls: string[];
        tags: Record<string, string>;
      }
    | undefined;
  withDir((dir) => {
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "image"));
    writeFileSync(join(dir, "image", "image.tar"), "");
    for (const tool of ["aws", "docker"]) {
      writeFileSync(join(dir, "bin", tool), `#!${process.execPath}\n${fake}`, { mode: 0o755 });
    }
    writeFileSync(
      join(dir, "bin", "sleep"),
      start.stop ? "#!/bin/sh\nkill -TERM $PPID\n" : "#!/bin/sh\n",
      {
        mode: 0o755,
      },
    );
    const state = join(dir, "state.json");
    const images = [...new Set(Object.values(start.tags))];
    writeFileSync(state, JSON.stringify({ calls: [], images, services: [], ...start }));
    const script = run("Push the image, move live and redeploy");
    const { status, signal, stdout } = bash(
      start.expire ? script.replace(/\$\(\(SECONDS \+ [^)]+\)\)/g, "$SECONDS") : script,
      dir,
      {
        PATH: `${dir}/bin:${process.env.PATH}`,
        STATE: state,
        RUNNER_TEMP: dir,
        SHA: sha,
        KEY: key,
        ACCOUNT: "123456789012",
      },
    );
    const end = JSON.parse(readFileSync(state, "utf8"));
    result = { status, signal, stdout, calls: end.calls, tags: end.tags };
  });
  assert.ok(result);
  return result;
}

test("a release whose image inputs already have their image, which live names, changes nothing", () => {
  const { status, calls, tags } = release({
    tags: { [`inputs-${key}`]: "sha256:new", live: "sha256:new" },
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    `batch-get-image imageTag=inputs-${key}`,
    "batch-get-image imageTag=live",
  ]);
  assert.deepEqual(tags, { [`inputs-${key}`]: "sha256:new", live: "sha256:new" });
});

test("a new image is pushed and tagged, and with no service live moves and nothing deploys", () => {
  const missing = {
    services: [],
    failures: [
      {
        arn: "arn:aws:ecs:eu-north-1:123456789012:service/fidant/fidant-signal",
        reason: "MISSING",
      },
    ],
  };
  const { status, calls, tags } = release({ tags: {}, services: [missing] });
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    `batch-get-image imageTag=inputs-${key}`,
    `batch-get-image imageTag=${sha}`,
    "docker load",
    "get-login-password",
    "docker login",
    "docker tag",
    "docker push",
    `batch-get-image imageTag=${sha}`,
    `put-image inputs-${key} sha256:new`,
    `batch-get-image imageTag=inputs-${key}`,
    "batch-get-image imageTag=live",
    `batch-get-image imageTag=failed-${key}`,
    "describe-services",
    "batch-get-image imageDigest=sha256:new",
    "put-image live sha256:new",
  ]);
  assert.deepEqual(tags, {
    [sha]: "sha256:new",
    [`inputs-${key}`]: "sha256:new",
    live: "sha256:new",
  });
});

const before = { [`inputs-${key}`]: "sha256:new", live: "sha256:old" };
const moved = [
  `batch-get-image imageTag=inputs-${key}`,
  "batch-get-image imageTag=live",
  `batch-get-image imageTag=failed-${key}`,
  "describe-services",
  "describe-services",
  "batch-get-image imageDigest=sha256:new",
  "put-image live sha256:new",
  "update-service",
];

test("with no cluster live moves and nothing deploys, and a refused check moves nothing", () => {
  const noCluster = release({ tags: before, services: ["!ClusterNotFoundException"] });
  assert.equal(noCluster.status, 0);
  assert.deepEqual(noCluster.calls, [
    ...moved.slice(0, 4),
    "batch-get-image imageDigest=sha256:new",
    "put-image live sha256:new",
  ]);

  const denied = release({ tags: before, services: ["!AccessDeniedException"] });
  assert.equal(denied.status, 1);
  assert.deepEqual(denied.calls, moved.slice(0, 4));
  assert.deepEqual(denied.tags, before);
});

test("a deployment that completes leaves live on the new image", () => {
  const done = service(["ecs-svc/2", "PRIMARY", "COMPLETED"]);
  const { status, calls, tags } = release({
    tags: before,
    services: [steady, steady, rolling, done],
    update: started,
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, [...moved, "describe-services", "describe-services"]);
  assert.deepEqual(tags, { ...before, live: "sha256:new" });
});

const failed = service(["ecs-svc/3", "PRIMARY", "IN_PROGRESS"], ["ecs-svc/2", "ACTIVE", "FAILED"]);
const back = service(["ecs-svc/3", "PRIMARY", "COMPLETED"]);
const marked = { ...before, [`failed-${key}`]: "sha256:new" };
const markFailed = ["batch-get-image imageDigest=sha256:new", `put-image failed-${key} sha256:new`];

test("a deployment that fails moves live back to the image the service went back to, tags the new image failed-<key>, and fails", () => {
  const { status, stdout, calls, tags } = release({
    tags: before,
    services: [steady, steady, rolling, failed, back],
    update: started,
  });
  assert.equal(status, 1);
  assert.deepEqual(calls, [
    ...moved,
    "describe-services",
    "describe-services",
    "describe-services",
    "batch-get-image imageDigest=sha256:old",
    "put-image live sha256:old",
    ...markFailed,
  ]);
  assert.deepEqual(tags, marked);
  assert.match(stdout, /::error::the new task failed its health check/);
});

test("a deployment that cannot start moves live back, leaves the image untagged as failed, and fails", () => {
  const { status, stdout, calls, tags } = release({
    tags: before,
    services: [steady],
    update: "!AccessDeniedException",
  });
  assert.equal(status, 1);
  assert.deepEqual(calls, [
    ...moved,
    "batch-get-image imageDigest=sha256:old",
    "put-image live sha256:old",
  ]);
  assert.deepEqual(tags, before);
  assert.match(stdout, /::error::could not start a deployment/);
});

test("a later release with the same image inputs moves nothing, starts no deployment and warns, and other inputs still deploy", () => {
  const first = release({
    tags: before,
    services: [steady, steady, rolling, failed, back],
    update: started,
  });
  assert.equal(first.status, 1);
  const again = release({ tags: first.tags as Record<string, string>, services: [steady] });
  assert.equal(again.status, 0);
  assert.deepEqual(again.calls, moved.slice(0, 3));
  assert.deepEqual(again.tags, marked);
  assert.match(
    again.stdout,
    new RegExp(
      `^::warning::the server image for these inputs failed before and is not deployed: sha256:new is tagged failed-${key}\\.`,
      "m",
    ),
  );

  const other = "c".repeat(64);
  const earlier = {
    [`inputs-${other}`]: "sha256:bad",
    [`failed-${other}`]: "sha256:bad",
    ...before,
  };
  const done = service(["ecs-svc/2", "PRIMARY", "COMPLETED"]);
  const next = release({
    tags: earlier,
    services: [steady, steady, rolling, done],
    update: started,
  });
  assert.equal(next.status, 0);
  assert.deepEqual(next.calls, [...moved, "describe-services", "describe-services"]);
  assert.deepEqual(next.tags, { ...earlier, live: "sha256:new" });
});

test("a failed-<key> tag that is already there counts only when it names the image that failed", () => {
  const rolledBack = {
    tags: before,
    services: [steady, steady, rolling, failed, back],
    update: started,
  };
  const same = release({ ...rolledBack, lost: { [`failed-${key}`]: "sha256:new" } });
  assert.equal(same.status, 1);
  assert.deepEqual(same.calls.slice(-3), [...markFailed, `batch-get-image imageTag=failed-${key}`]);
  assert.deepEqual(same.tags, marked);
  assert.match(same.stdout, /::error::the new task failed its health check/);

  const another = release({ ...rolledBack, lost: { [`failed-${key}`]: "sha256:old" } });
  assert.equal(another.status, 1);
  assert.deepEqual(another.calls.slice(-3), [
    ...markFailed,
    `batch-get-image imageTag=failed-${key}`,
  ]);
  assert.deepEqual(another.tags, { ...before, [`failed-${key}`]: "sha256:old" });
  assert.match(another.stdout, /::error::the new task failed its health check/);
});

const noFailedTag = (tags: object) => assert.ok(!(`failed-${key}` in tags));
const serviceReplaced = service(["ecs-svc/9", "PRIMARY", "COMPLETED"]);

test("a release that stops after live moved puts live back, so the next release with the same inputs deploys", () => {
  const stopped = release({
    tags: before,
    services: [steady, steady, "!ThrottlingException"],
    update: started,
  });
  assert.notEqual(stopped.status, 0);
  assert.deepEqual(stopped.tags, before);
  assert.match(stopped.stdout, /::error::the release stopped before the service ran sha256:new/);

  const done = service(["ecs-svc/2", "PRIMARY", "COMPLETED"]);
  const again = release({
    tags: stopped.tags,
    services: [steady, steady, rolling, done],
    update: started,
  });
  assert.equal(again.status, 0);
  assert.ok(again.calls.includes("update-service"));
  assert.deepEqual(again.tags, { ...before, live: "sha256:new" });
});

test("a deployment that does not finish in time puts live back and tags nothing failed", () => {
  const { status, stdout, tags } = release({
    tags: before,
    services: [steady, steady, rolling],
    update: started,
    expire: true,
  });
  assert.equal(status, 1);
  assert.match(stdout, /::error::the deployment did not finish in time/);
  assert.deepEqual(tags, before);
});

test("a deployment that left the list puts live back and tags nothing failed", () => {
  const { status, stdout, tags } = release({
    tags: before,
    services: [steady, steady, serviceReplaced],
    update: started,
  });
  assert.equal(status, 1);
  assert.match(stdout, /::error::the deployment left the service's list before it finished/);
  assert.deepEqual(tags, before);
  noFailedTag(tags);
});

test("a rollback that does not settle in time puts live back and tags nothing failed", () => {
  const { status, stdout, tags } = release({
    tags: before,
    services: [steady, steady, failed, failed],
    update: started,
    expire: true,
  });
  assert.equal(status, 1);
  assert.match(stdout, /::error::the service did not settle in time/);
  assert.deepEqual(tags, before);
});

test("a service that does not settle in time before live moves changes nothing", () => {
  const { status, stdout, calls, tags } = release({
    tags: before,
    services: [rolling],
    expire: true,
  });
  assert.equal(status, 1);
  assert.match(stdout, /::error::the service did not settle in time/);
  assert.ok(!calls.includes("update-service"));
  assert.deepEqual(tags, before);
});

test("a release that is stopped by SIGTERM while it waits puts live back", () => {
  const { signal, tags } = release({
    tags: before,
    services: [steady, steady, rolling],
    update: started,
    stop: true,
  });
  assert.equal(signal, "SIGTERM");
  assert.deepEqual(tags, before);
});

test("an image whose commit tag is there but whose inputs tag is not is tagged without a docker load", () => {
  const missing = { services: [], failures: [{ reason: "MISSING" }] };
  const { status, calls, tags } = release({ tags: { [sha]: "sha256:new" }, services: [missing] });
  assert.equal(status, 0);
  assert.ok(!calls.some((call) => call.startsWith("docker")));
  assert.deepEqual(tags, {
    [sha]: "sha256:new",
    [`inputs-${key}`]: "sha256:new",
    live: "sha256:new",
  });
});

test("an inputs tag that already names another image fails the release", () => {
  const { status, calls, tags } = release({
    tags: { [sha]: "sha256:new", other: "sha256:other" },
    lost: { [`inputs-${key}`]: "sha256:other" },
  });
  assert.equal(status, 1);
  assert.ok(!calls.includes("describe-services"));
  assert.ok(!("live" in tags));
});
