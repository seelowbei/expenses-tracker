import type { Db } from "./db/client";
import type { User } from "./db/schema";
import type { Bindings } from "./env";

/** Outbound HTTP used for Google (OAuth + Drive). Injected so tests never hit the network. */
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AppDeps {
  fetch: Fetcher;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: {
    db: Db;
    deps: AppDeps;
    user: User;
  };
}
