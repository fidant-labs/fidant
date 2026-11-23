/** One process of the local stack, such as the server or, later, a database. */
export interface Service {
  name: string;
  start(): Promise<RunningService>;
}

export interface RunningService {
  name: string;
  /** The origin the service listens on, for example `https://localhost:51234`. */
  url: string;
  port: number;
  stop(): Promise<void>;
}
