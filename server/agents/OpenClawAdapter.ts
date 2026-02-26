/**
 * OpenClawAdapter — Agent adapter for OpenClaw instances.
 *
 * OpenClaw is an open-source autonomous AI agent (Python-based).
 * Uses messaging platforms as UI, supports multi-step task execution.
 *
 * Integration:
 * - Local: python -m openclaw (inside project dir)
 * - Docker: docker run with OpenClaw image
 * - Gateway: remote OpenClaw instance via HTTP API
 */

import { spawn } from "child_process";
import type {
  CreateSessionRequest,
  LaunchModeConfig,
} from "../../shared/types.js";
import { BaseClawAdapter, type ProcessHandle } from "./BaseClawAdapter.js";

export class OpenClawAdapter extends BaseClawAdapter {
  readonly agentType = "openclaw" as const;

  constructor(logFn?: (...args: unknown[]) => void) {
    super(logFn);
  }

  protected getLabel(): string {
    return "OpenClaw";
  }

  getCapabilities(): string[] {
    return [
      "tool_use",
      "multi_provider",
      "messaging",
      "autonomous_tasks",
      "web_browsing",
      "code_execution",
    ];
  }

  protected async launchLocal(
    id: string,
    config: CreateSessionRequest,
    launchMode: LaunchModeConfig,
    env: Record<string, string>,
  ): Promise<ProcessHandle> {
    const projectDir = launchMode.binaryPath || launchMode.projectDir || config.cwd || process.cwd();

    const child = spawn("python", ["-m", "openclaw"], {
      cwd: projectDir,
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
    const image = launchMode.dockerImage || "openclaw:latest";
    const containerName = `openclaw-${id.slice(0, 8)}`;

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
        agentType: "openclaw",
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
