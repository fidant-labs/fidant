/** One process of the local stack, such as the server or, later, a database. */
export interface Service {
  name: string;
  /** `env` holds what the services started before this one hand on, such as TURN_URLS. */
  start(env: Readonly<Record<string, string>>): Promise<RunningService>;
}

export interface RunningService {
  name: string;
  /**
   * The origin the service listens on, for example `https://localhost:51234`. Only services the
   * browser may reach over HTTP have one: it goes into the request allowlist.
   */
  url?: string;
  /** Other origins the browser may reach through this service, such as a name it maps to it. */
  origins?: string[];
  port?: number;
  /** Environment for the services that start after this one. */
  env?: Record<string, string>;
  stop(): Promise<void>;
}
