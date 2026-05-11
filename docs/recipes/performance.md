# Performance Recipe

Use the profiler before and after runtime, HTTP, scheduler, layer, schedule, or
observability changes.

```bash
npm run perf -- --profile runtime-ab
npm run perf -- --profile runtime-soak
npm run perf:http:memory -- --calls 1000 --concurrency 64 --variants default-json,default-json-observed
```

Save a local baseline when the machine is stable:

```bash
npm run perf -- --profile runtime-ab --record-history --save-baseline runtime-main
npm run perf -- --profile runtime-ab --compare-baseline runtime-main --fail-on-baseline-regression
```

For memory-sensitive HTTP work, expose GC:

```bash
node --expose-gc --import tsx src/perf/cli.ts --profile http-memory --calls 100000 --concurrency 512 --delay-ms 2 --force-gc
```

Programmatic API:

```ts
import {
  comparePerfToBaseline,
  createPerfHistoryEntry,
  loadPerfBaseline,
  runBrassPerformanceProfile,
  savePerfBaseline,
} from "brass-runtime/perf";

const report = await runBrassPerformanceProfile({ http: false });
const entry = createPerfHistoryEntry("runtime", report);
await savePerfBaseline("runtime-main", entry);

const baseline = await loadPerfBaseline("runtime-main");
if (baseline) {
  console.log(comparePerfToBaseline(entry, baseline));
}
```

Treat non-GC heap deltas as allocator churn until a GC-aware run confirms
retained memory.
