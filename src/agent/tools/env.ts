import { asyncSync, type Async } from "../../core/types/asyncEffect";
import type { AgentEnv } from "../core/types";

export const service = <K extends keyof AgentEnv>(key: K): Async<AgentEnv, never, AgentEnv[K]> =>
    asyncSync((env: AgentEnv) => env[key]) as any;
