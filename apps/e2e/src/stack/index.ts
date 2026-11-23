import { server } from "./server.ts";
import type { RunningService, Service } from "./service.ts";

export interface Stack {
  baseURL: string;
  stop(): Promise<void>;
}

// Services start in this order and stop in reverse. Later services (database, storage, relay)
// get their own module next to server.ts and go into this list before the services that need them.
const services: Service[] = [server];

/** Starts every service of the local stack. If one fails, the ones already running are stopped. */
export async function startStack(): Promise<Stack> {
  const running: RunningService[] = [];
  const stop = async () => {
    for (const service of running.toReversed()) await service.stop();
  };
  try {
    for (const service of services) running.push(await service.start());
  } catch (error) {
    await stop();
    throw error;
  }
  const web = running.find((service) => service.name === "server");
  if (!web) throw new Error("The stack has no server.");
  return { baseURL: web.url, stop };
}
