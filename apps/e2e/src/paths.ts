import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const e2eDir = join(repoRoot, "apps", "e2e");
export const observationsDir = join(e2eDir, "observations");
/** Logs and state that belong to the whole run rather than to one test. */
export const runDir = join(observationsDir, "run");
/** The server's stdout (strict JSONL) and stderr (free text), for the whole run. */
export const serverStdoutLog = join(runDir, "server.stdout.log");
export const serverStderrLog = join(runDir, "server.stderr.log");
/** The local server's PID, rewritten when it restarts (`restartServer()` in src/stack/server.ts). */
export const serverPidFile = join(runDir, "server.pid");
/** What the server service saw happen to the server, such as an unexpected exit. */
export const stackEventsLog = join(runDir, "stack-events.log");
/** coturn's own verbose log, for the whole run. */
export const coturnLog = join(runDir, "coturn.log");
/** Mailpit's output (errors only), for the whole run. */
export const mailpitLog = join(runDir, "mailpit.log");
/** Every packet to and from coturn, in the network scenarios only (networks/compose.yaml). */
export const coturnPcap = join(runDir, "coturn.pcap");

/** The box container's journal (sigill, caddy, coturn) and /var/log/syslog, network scenarios only. */
export const boxJournal = join(runDir, "box-journal.jsonl");
export const boxSyslog = join(runDir, "box-syslog.log");
/** The signaling image's container log, stdout and stderr, network scenarios only. */
export const signalLog = join(runDir, "signal.log");

/**
 * Every file the harness writes directly in observations/run/, and how the leak checks read it:
 * `lines` as a log scanned line by line, `binary` as raw bytes, `ignored` not at all. The per-test
 * scan reads what each grew by during the test, the run-level sweep the whole file. The sweep fails
 * on any file in observations/ that is neither here nor a per-test record or saved mail
 * (`src/sweep.ts`). Server stdout, found by its file name, also gets the allowlist check.
 */
export type RunSource =
  | { path: string; read: "lines" | "binary" }
  | { path: string; read: "ignored"; reason: string };
export const runSources: readonly RunSource[] = [
  { path: serverStdoutLog, read: "lines" },
  { path: serverStderrLog, read: "lines" },
  { path: coturnLog, read: "lines" },
  { path: mailpitLog, read: "lines" },
  { path: stackEventsLog, read: "lines" },
  { path: boxJournal, read: "lines" },
  { path: boxSyslog, read: "lines" },
  { path: signalLog, read: "lines" },
  { path: coturnPcap, read: "binary" },
  { path: serverPidFile, read: "ignored", reason: "a process ID the harness writes itself" },
];

/** Empties observations/ so a run only holds its own files. */
export async function resetObservations(): Promise<void> {
  await rm(observationsDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
}
