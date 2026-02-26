/**
 * ZeroClawAdapter — Agent adapter for ZeroClaw instances.
 *
 * ZeroClaw is an ultra-lightweight Rust-based AI agent runtime (~3.4MB binary)
 * with 13 pluggable traits for providers, channels, memory, tools, etc.
 *
 * Integration:
 * - Local: run ZeroClaw binary directly
 * - Docker: docker run with the Rust binary
 * - Gateway: remote ZeroClaw instance via HTTP API
 */

import { spawn } from "child_process";
import type {
  CreateSessionRequest,
  LaunchModeConfig,
} from "../../shared/types.js";
import { BaseClawAdapter, type ProcessHandle } from "./BaseClawAdapter.js";

export class ZeroClawAdapter extends BaseClawAdapter {
  readonly agentType = "zeroclaw" as const;

  constructor(logFn?: (...args: unknown[]) => void) {
    super(logFn);
  }

  protected getLabel(): string {
    return "ZeroClaw";
  }

  getCapabilities(): string[] {
    return [
      "tool_use",
      "multi_provider",
      "multi_channel",
      "edge_deployment",
      "low_memory",
      "sandboxed_execution",
      "tunnel_support",
    ];
  }

  protected async launchLocal(
    id: string,
    config: CreateSessionRequest,
    launchMode: LaunchModeConfig,
    env: Record<string, string>,
  ): Promise<ProcessHandle> {
    const binaryPath = launchMode.binaryPath || "zeroclaw";
    const cwd = config.cwd || process.cwd();

    const args: string[] = [];
    // Pass provider from LLM env if available
    if (env.LLM_PROVIDER) args.push("--provider", env.LLM_PROVIDER);
    if (env.LLM_MODEL) args.push("--model", env.LLM_MODEL);

    const child = spawn(binaryPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.attachEventCapture(id, child);

    return {
      kind: "process",
      process: child,
      kill: () => child.kill("SIGTERM"),
    };
  }

  protected async launchDocker(
    id: string,
    config: CreateSessionRequest,
    launchMode: LaunchModeConfig,
    env: Record<string, string>,
  ): Promise<ProcessHandle> {
    const image = launchMode.dockerImage || "zeroclaw:latest";
    const containerName = `zeroclaw-${id.slice(0, 8)}`;

    const cmd = launchMode.useAppleContainer ? "container" : "docker";
    const args = ["run", "--rm", "--name", containerName];

    for (const [k, v] of Object.entries(env)) {
      args.push("-e", `${k}=${v}`);
    }

    if (launchMode.dockerVolumes) {
      for (const vol of launchMode.dockerVolumes) {
        args.push("-v", vol);
      }
    }

    args.push(image);

    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.attachEventCapture(id, child);

    return {
      kind: "docker",
      process: child,
      containerId: containerName,
      kill: () => {
        try {
          spawn(cmd, ["stop", containerName], { stdio: "ignore" });
        } catch {
          child.kill("SIGTERM");
        }
      },
    };
  }

  protected async launchGateway(
    id: string,
    config: CreateSessionRequest,
    launchMode: LaunchModeConfig,
  ): Promise<ProcessHandle> {
    const gatewayUrl = launchMode.gatewayUrl;
    if (!gatewayUrl) throw new Error("Gateway URL required for gateway mode");

    const resp = await fetch(`${gatewayUrl}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(launchMode.gatewayToken ? { Authorization: `Bearer ${launchMode.gatewayToken}` } : {}),
      },
      body: JSON.stringify({
        agentType: "zeroclaw",
        name: config.name,
        config: config.agentConfig,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Gateway returned ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json() as { sessionId?: string; endpoint?: string };
    const endpoint = data.endpoint || `${gatewayUrl}/sessions/${data.sessionId || id}`;

    return {
      kind: "gateway",
      gatewayEndpoint: endpoint,
      gatewayToken: launchMode.gatewayToken,
      kill: () => {
        fetch(endpoint, {
          method: "DELETE",
          headers: launchMode.gatewayToken ? { Authorization: `Bearer ${launchMode.gatewayToken}` } : {},
        }).catch(() => {});
      },
    };
  }
}
