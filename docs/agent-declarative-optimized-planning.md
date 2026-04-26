# Declarative optimized planning roadmap

This note tracks the design goal:

> Keep the user-facing layer declarative and flexible, but internally convert
> work into optimized plans that execute with batches, compact memory, and the
> least practical overhead.

## Does Brass Agent do this today?

Partially.

Brass Agent already has several pieces of the model:

- declarative user requests through CLI goals, VS Code chat, presets, and batch
  files,
- `AgentAction -> Observation` execution through explicit capabilities,
- bounded context discovery before planning,
- compact protocol/events for editor integrations,
- sequential batch runs for multi-goal workflows,
- patch quality loops and rollback safety,
- project intelligence for mixed stacks.

However, the current agent still uses a mostly sequential decision loop. It does
not yet compile user intent into a first-class optimized plan IR, batch tool
calls aggressively, maintain a compact long-lived memory model, or minimize
runtime overhead through cost-aware scheduling.

## What is missing for the full design?

### 1. A first-class plan IR

Introduce an internal representation such as:

```ts
type AgentPlan = {
  readonly id: string;
  readonly goal: string;
  readonly steps: readonly PlanStep[];
  readonly budgets: PlanBudgets;
};

type PlanStep =
  | { readonly type: "read"; readonly paths: readonly string[] }
  | { readonly type: "search"; readonly queries: readonly string[] }
  | { readonly type: "validate"; readonly commands: readonly string[][] }
  | { readonly type: "llm"; readonly purpose: "plan" | "patch" | "explain" }
  | { readonly type: "patch"; readonly mode: "propose" | "apply" | "rollback" };
```

The user keeps writing natural requests, but the agent compiles them into a
small, inspectable, optimizable plan before execution.

### 2. Plan optimization passes

Before execution, run optimization passes:

- deduplicate repeated reads/searches,
- merge compatible searches,
- avoid reading files already in compact memory,
- skip validation commands that are irrelevant to the goal,
- cap expensive operations by budget,
- split independent work into parallel or batched groups.

### 3. Batched tool execution

Add tool-level batching:

- `fs.readFiles(paths)` instead of repeated single reads,
- `fs.existsMany(paths)` for marker discovery,
- `search.batch(queries)` with shared `rg` invocation when possible,
- validation command groups with explicit ordering and concurrency rules.

The public agent API can remain declarative while the executor runs fewer tool
calls internally.

### 4. Compact memory

Separate memory into layers:

```txt
working memory     current run, exact observations
compact memory     summaries, file digests, validation summaries
persistent memory  optional workspace-local cache, never required
```

The LLM should receive compact summaries first, exact contents only when needed.
This reduces token usage, repeated file reads, and noisy follow-up prompts.

### 5. Cost and overhead budgets

Every plan should carry budgets:

```txt
max tool calls
max files read
max bytes read
max search queries
max validation commands
max LLM calls
max wall-clock time
```

The planner and executor can then prefer lower-overhead plans and explain when a
budget prevented more exploration.

### 6. Runtime lanes and scheduling

Use the runtime more directly for optimized execution lanes:

```txt
FS lane          bounded concurrency
Search lane      low concurrency, deduped
LLM lane         strict concurrency, retry/backoff
Validation lane  serial by default
Patch lane       exclusive
```

This matches the original brass-runtime idea: a coding agent is a concurrent,
cancelable, observable effect program.

## Suggested implementation path

1. `P49`: introduce `AgentPlan` and log/preview plans without changing behavior.
2. `P50`: compile current `decideNextAction` flow into a simple sequential plan.
3. `P51`: add plan optimization passes for dedupe and budget caps.
4. `P52`: add batched FS/exists/search tools.
5. `P53`: add compact memory summaries for files, validation output, and patches.
6. `P54`: add lane-based executor with bounded concurrency.
7. `P55`: expose a VS Code “Plan Preview” so users can see what the agent is
   about to do before it runs.

## Short answer

Brass Agent currently supports the declarative UX and some compact/batch pieces,
but it is not yet a fully optimized internal planner. To get there, the next big
step is to introduce a first-class `AgentPlan` IR and then optimize/execute that
plan with batching, compact memory, budgets, and runtime lanes.
