import { server } from "./server.ts";
import type { RunningService, Service } from "./service.ts";

export interface Stack {
  baseURL: string;
  /** The origin of every running service. The browser may reach these and nothing else. */
  origins: string[];
  stop(): Promise<void>;
}

// Services start in this order and stop in reverse. Later services (database, storage, relay)
// get their own module next to server.ts and go into this list before the services that need them.
const defaultServices: readonly Service[] = [server];

/**
 * Starts every service of the local stack. If one fails, the ones already running are stopped
 * and the error is rethrown.
 */
export async function startStack(services: readonly Service[] = defaultServices): Promise<Stack> {
  const running: RunningService[] = [];
  const stop = async () => {
    for (const service of running.toReversed()) {
      await service.stop();
    }
  };
  try {
    for (const service of services) {
      running.push(await service.start());
    }
  } catch (error) {
    await stop();
    throw error;
  }
  const web = running.find((service) => service.name === "server");
  if (!web) {
    throw new Error("The stack has no server.");
  }
  return { baseURL: web.url, origins: running.map((service) => new URL(service.url).origin), stop };
}
