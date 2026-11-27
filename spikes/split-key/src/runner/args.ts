// Command-line flags of the bench runner. Pure, so it is unit tested.

import { PIPELINE_CHUNK_SIZES, PIPELINE_SIZES } from "../bench/messages.ts";
import type { SinkKind } from "../bench/results.ts";

export const ENGINES = ["chromium", "firefox", "webkit"] as const;
export type Engine = (typeof ENGINES)[number];

/** The sinks automation can drive. fsa needs a save picker, so fsa-opfs stands in for it. */
export const AUTOMATABLE_SINKS = ["opfs", "fsa-opfs", "blob", "sw"] as const satisfies SinkKind[];
export type AutomatableSink = (typeof AUTOMATABLE_SINKS)[number];

export type RunnerArgs = {
  engines: Engine[];
  /** Plaintext sizes in bytes. */
  sizes: number[];
  sinks: AutomatableSink[];
  /** Chunk sizes in bytes. */
  chunks: number[];
  seed: number;
  /** Bytes per stage for the microbenchmarks, once per engine. 0 skips them. */
  microBytes: number;
  /** Where results/<date>-<engine>.json go. */
  outDir: string;
  /** Scratch space for downloads, removed per run and at the end. */
  runsDir: string;
  headed: boolean;
  build: boolean;
};

const MIB = 1024 * 1024;
const UNITS: Record<string, number> = { "": 1, B: 1, KIB: 1024, MIB, GIB: 1024 * MIB };

const VALUE_FLAGS = [
  "--engines",
  "--sizes",
  "--sinks",
  "--chunks",
  "--seed",
  "--micro",
  "--out",
  "--runs-dir",
];

export const USAGE = `Usage: pnpm --filter @fidant/spike-split-key bench:run [flags]

  --engines   chromium,firefox,webkit (default: all three)
  --sizes     plaintext sizes, e.g. 64MiB,1GiB,5GiB (default: 64MiB)
  --sinks     ${AUTOMATABLE_SINKS.join(",")} (default: all of them; fsa needs a picker)
  --chunks    48KiB,256KiB,1MiB,4MiB (default: 256KiB,1MiB)
  --seed      seed of the generated plaintext (default: 1)
  --micro     bytes per microbenchmark stage, 0 to skip (default: 256MiB)
  --out       results directory (default: spikes/split-key/results)
  --runs-dir  scratch directory for downloads (default: spikes/split-key/.runs)
  --headed    show the browser windows
  --no-build  serve the existing dist/ instead of building first`;

/** "64MiB", "48KiB", "5GiB" or a plain byte count. Units are binary. */
export function parseBytes(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([KMG]i?B|B)?$/i.exec(text.trim());
  if (!match?.[1]) {
    throw new Error(`not a size: ${text}`);
  }
  const unit = (match[2] ?? "").toUpperCase().replace(/^([KMG])B$/, "$1IB");
  const factor = UNITS[unit];
  const bytes = Number(match[1]) * (factor ?? Number.NaN);
  if (!Number.isSafeInteger(bytes)) {
    throw new Error(`not a whole number of bytes: ${text}`);
  }
  return bytes;
}

function list(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function oneOf<T extends string>(allowed: readonly T[], value: string, flag: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    const hint =
      flag === "--sinks" && value === "fsa" ? " (fsa needs a save picker; use fsa-opfs)" : "";
    throw new Error(`${flag}: unknown ${value}${hint}; expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function parseArgs(
  argv: string[],
  defaults: { outDir: string; runsDir: string },
): RunnerArgs {
  const args: RunnerArgs = {
    engines: [...ENGINES],
    sizes: [64 * MIB],
    sinks: [...AUTOMATABLE_SINKS],
    chunks: [256 * 1024, MIB],
    seed: 1,
    microBytes: 256 * MIB,
    outDir: defaults.outDir,
    runsDir: defaults.runsDir,
    headed: false,
    build: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    if (flag === "--headed") {
      args.headed = true;
      continue;
    }
    if (flag === "--no-build") {
      args.build = false;
      continue;
    }
    // pnpm passes a lone "--" through when flags follow it.
    if (flag === "--") {
      continue;
    }
    const [name, inline] = flag.split("=", 2) as [string, string | undefined];
    if (!VALUE_FLAGS.includes(name)) {
      throw new Error(`unknown flag ${name}`);
    }
    const value = inline ?? argv[++i];
    if (value === undefined) {
      throw new Error(`${name} needs a value`);
    }
    switch (name) {
      case "--engines":
        args.engines = list(value).map((item) => oneOf(ENGINES, item, name));
        break;
      case "--sizes":
        args.sizes = list(value).map(parseBytes);
        break;
      case "--sinks":
        args.sinks = list(value).map((item) => oneOf(AUTOMATABLE_SINKS, item, name));
        break;
      case "--chunks":
        args.chunks = list(value).map(parseBytes);
        break;
      case "--seed":
        args.seed = Number(value);
        break;
      case "--micro":
        args.microBytes = parseBytes(value);
        break;
      case "--out":
        args.outDir = value;
        break;
      case "--runs-dir":
        args.runsDir = value;
        break;
      default:
        throw new Error(`unknown flag ${name}`);
    }
  }
  return validate(args);
}

function validate(args: RunnerArgs): RunnerArgs {
  if (args.engines.length === 0 || args.sizes.length === 0 || args.sinks.length === 0) {
    throw new Error("--engines, --sizes and --sinks need at least one value");
  }
  for (const chunk of args.chunks) {
    if (!PIPELINE_CHUNK_SIZES.includes(chunk)) {
      throw new Error(
        `chunk size ${chunk} is not one the page offers: ${PIPELINE_CHUNK_SIZES.join(", ")}`,
      );
    }
  }
  for (const size of args.sizes) {
    // The page takes its preset sizes, or a custom size in whole MiB.
    if (!PIPELINE_SIZES.includes(size) && size % MIB !== 0) {
      throw new Error(`size ${size} must be a preset or a whole number of MiB`);
    }
  }
  if (!Number.isInteger(args.seed) || args.seed < 0 || args.seed > 0xffffffff) {
    throw new Error("--seed must be a u32");
  }
  if (args.microBytes % MIB !== 0) {
    throw new Error("--micro must be a whole number of MiB");
  }
  return args;
}

/** How long one pipeline run may take: a minute, plus half a second per MiB. */
export function runTimeoutMs(size: number): number {
  return 60_000 + Math.ceil(size / MIB) * 500;
}
