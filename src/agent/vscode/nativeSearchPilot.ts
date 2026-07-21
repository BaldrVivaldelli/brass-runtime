import type { RuntimeBoundaryDiagnosticsOptions } from "../../core/runtime/boundaryDiagnostics";
import type { AgentHost } from "../core/types";
import { NativeServiceClient } from "../native/client";
import type { NativeServiceEvent, NativeServiceTransportFactory } from "../native/protocol";
import {
  NativeSearchPilot,
  type NativeSearchPilotMode,
} from "../native/searchPilot";
import {
  createNodeNativeServiceTransport,
  type NodeNativeServiceTransportOptions,
} from "../node/nativeServiceProcess";

export type MakeVsCodeNativeSearchPilotOptions = {
  readonly host: Pick<AgentHost, "workspace" | "lifecycle">;
  readonly clientBuild: string;
  readonly mode?: NativeSearchPilotMode;
  readonly isWorkspaceTrusted?: () => boolean | Promise<boolean>;
  readonly transportFactory?: NativeServiceTransportFactory;
  readonly process?: NodeNativeServiceTransportOptions;
  readonly diagnostics?: RuntimeBoundaryDiagnosticsOptions;
  readonly onEvent?: (event: NativeServiceEvent) => void;
  readonly restartBackoffMs?: number;
};

/**
 * Extension-host composition for the promoted read-only native search path.
 * It owns no VS Code import: the host supplies current trust/lifecycle and the
 * Node extension host owns the private child process. The default `auto` mode
 * is native-first and keeps the deterministic TypeScript reversal path.
 */
export function makeVsCodeNativeSearchPilot(
  options: MakeVsCodeNativeSearchPilotOptions,
): NativeSearchPilot {
  const workspace = options.host.workspace;
  if (!workspace) throw new Error("VS Code native search requires AgentHost.workspace");
  const client = new NativeServiceClient({
    workspaceId: workspace.id,
    clientBuild: options.clientBuild,
    transportFactory: options.transportFactory
      ?? (() => createNodeNativeServiceTransport(options.process)),
    diagnostics: options.diagnostics,
    onEvent: options.onEvent,
  });
  const pilot = new NativeSearchPilot({
    client,
    mode: options.mode ?? "auto",
    isWorkspaceTrusted: options.isWorkspaceTrusted ?? (() => workspace.trusted),
    diagnostics: options.diagnostics,
    restartBackoffMs: options.restartBackoffMs,
  });
  options.host.lifecycle?.onShutdown(() => {
    void pilot.shutdown().catch(() => undefined);
  });
  return pilot;
}
