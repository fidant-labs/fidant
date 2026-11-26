import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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
  const uses = workflow.match(/uses: \S+/g) ?? [];
  assert.equal(uses.length, 4);
  for (const action of uses) {
    assert.match(action, /@[0-9a-f]{40}$/);
  }
  const scripts = [...workflow.matchAll(/\n( +)run: \|\n((?:\1 +.*\n|\n)+)/g)];
  assert.equal(scripts.length, 4);
  for (const [, , script] of scripts) {
    assert.doesNotMatch(script ?? "", /\$\{\{/);
  }
  const buildAt = workflow.indexOf("\n  build:\n");
  const releaseAt = workflow.indexOf("\n  release:\n");
  assert.ok(buildAt > 0 && releaseAt > buildAt);
  const build = workflow.slice(buildAt, releaseAt);
  const release = workflow.slice(releaseAt);
  assert.doesNotMatch(build, /id-token|secrets\./);
  assert.doesNotMatch(release, /checkout|pnpm|node /);
  assert.match(release, /\n {4}environment: app\n/);
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

function release(start: { tags: Record<string, string>; services?: unknown[]; update?: unknown }) {
  let result: { status: number | null; stdout: string; calls: string[]; tags: object } | undefined;
  withDir((dir) => {
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "image"));
    writeFileSync(join(dir, "image", "image.tar"), "");
    for (const tool of ["aws", "docker"]) {
      writeFileSync(join(dir, "bin", tool), `#!${process.execPath}\n${fake}`, { mode: 0o755 });
    }
    writeFileSync(join(dir, "bin", "sleep"), "#!/bin/sh\n", { mode: 0o755 });
    const state = join(dir, "state.json");
    const images = [...new Set(Object.values(start.tags))];
    writeFileSync(state, JSON.stringify({ calls: [], images, services: [], ...start }));
    const { status, stdout } = bash(run("Push the image, move live and redeploy"), dir, {
      PATH: `${dir}/bin:${process.env.PATH}`,
      STATE: state,
      RUNNER_TEMP: dir,
      SHA: sha,
      KEY: key,
      ACCOUNT: "123456789012",
    });
    const end = JSON.parse(readFileSync(state, "utf8"));
    result = { status, stdout, calls: end.calls, tags: end.tags };
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
    ...moved.slice(0, 3),
    "batch-get-image imageDigest=sha256:new",
    "put-image live sha256:new",
  ]);

  const denied = release({ tags: before, services: ["!AccessDeniedException"] });
  assert.equal(denied.status, 1);
  assert.deepEqual(denied.calls, moved.slice(0, 3));
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

test("a deployment that fails moves live back to the image the service went back to, and fails", () => {
  const failed = service(
    ["ecs-svc/3", "PRIMARY", "IN_PROGRESS"],
    ["ecs-svc/2", "ACTIVE", "FAILED"],
  );
  const back = service(["ecs-svc/3", "PRIMARY", "COMPLETED"]);
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
  ]);
  assert.deepEqual(tags, before);
  assert.match(stdout, /::error::the new task failed its health check/);
});

test("a deployment that cannot start moves live back, and fails", () => {
  const { status, calls, tags } = release({
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
});
