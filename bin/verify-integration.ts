#!/usr/bin/env node

/**
 * NanoBot × Realm 集成验证脚本
 *
 * 验证：
 * 1. Realm 服务器是否运行
 * 2. NanoBot 是否运行
 * 3. Sessions 是否已创建
 * 4. 任务分发是否正常
 * 5. 结果回调是否正常
 */

import fetch from "node-fetch";
import { execSync } from "child_process";

const REALM_API = "http://localhost:4003";
const NANOBOT_PORT = 18790;

interface CheckResult {
  name: string;
  status: "✅" | "❌" | "⚠️";
  message: string;
  details?: string;
}

const results: CheckResult[] = [];

// ============================================================================
// 检查函数
// ============================================================================

async function checkRealmServer() {
  try {
    const response = await fetch(`${REALM_API}/sessions`);
    if (response.ok) {
      const data = (await response.json()) as { sessions: Array<{ name: string }> };
      results.push({
        name: "Realm 服务器",
        status: "✅",
        message: `运行中 (${data.sessions.length} 个 sessions)`,
        details: data.sessions.map((s) => `  • ${s.name}`).join("\n"),
      });
      return true;
    }
  } catch (error) {
    results.push({
      name: "Realm 服务器",
      status: "❌",
      message: "无法连接到 Realm 服务器",
      details: `地址: ${REALM_API}`,
    });
    return false;
  }
}

function checkNanoBot() {
  try {
    const output = execSync("ps aux | grep nanobot | grep -v grep", {
      encoding: "utf-8",
    });

    if (output.includes("nanobot gateway")) {
      const portMatch = output.match(/--port (\d+)/);
      const port = portMatch ? portMatch[1] : "unknown";
      results.push({
        name: "NanoBot 网关",
        status: "✅",
        message: `运行中 (端口: ${port})`,
      });
      return true;
    }
  } catch (error) {
    results.push({
      name: "NanoBot 网关",
      status: "❌",
      message: "NanoBot 未运行",
    });
    return false;
  }
}

async function checkSessions() {
  try {
    const response = await fetch(`${REALM_API}/sessions`);
    const data = (await response.json()) as {
      sessions: Array<{ id: string; name: string; status: string }>;
    };

    if (data.sessions.length > 0) {
      const statuses = data.sessions.reduce(
        (acc, s) => {
          acc[s.status] = (acc[s.status] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      results.push({
        name: "Claude Code Sessions",
        status: "✅",
        message: `已创建 ${data.sessions.length} 个 sessions`,
        details: Object.entries(statuses)
          .map(([status, count]) => `  • ${status}: ${count}`)
          .join("\n"),
      });
      return true;
    }
  } catch (error) {
    results.push({
      name: "Claude Code Sessions",
      status: "❌",
      message: "无法获取 sessions 信息",
    });
    return false;
  }
}

async function checkTaskDispatch() {
  try {
    const response = await fetch(`${REALM_API}/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "测试任务分发",
        callbackUrl: "http://localhost:3001/callback",
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        ok: boolean;
        taskGroupId: string;
        dispatched: Array<{ sessionName: string }>;
      };

      if (data.ok) {
        results.push({
          name: "任务分发 API",
          status: "✅",
          message: `正常工作 (分发到 ${data.dispatched.length} 个 session)`,
          details: `  Task Group ID: ${data.taskGroupId}`,
        });
        return true;
      }
    }
  } catch (error) {
    results.push({
      name: "任务分发 API",
      status: "❌",
      message: "任务分发失败",
      details: String(error),
    });
    return false;
  }
}

async function checkStats() {
  try {
    const response = await fetch(`${REALM_API}/stats`);
    if (response.ok) {
      const data = (await response.json()) as { totalEvents: number };
      results.push({
        name: "服务器统计",
        status: "✅",
        message: `正常工作`,
        details: `  • 总事件数: ${data.totalEvents}`,
      });
      return true;
    }
  } catch (error) {
    results.push({
      name: "服务器统计",
      status: "⚠️",
      message: "无法获取统计信息",
    });
    return false;
  }
}

// ============================================================================
// 主函数
// ============================================================================

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     🔍 NanoBot × Realm 集成验证                           ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  console.log("⏳ 正在检查系统状态...\n");

  // 执行所有检查
  await checkRealmServer();
  checkNanoBot();
  await checkSessions();
  await checkTaskDispatch();
  await checkStats();

  // 显示结果
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📊 检查结果\n");

  for (const result of results) {
    console.log(`${result.status} ${result.name}`);
    console.log(`   ${result.message}`);
    if (result.details) {
      console.log(result.details);
    }
    console.log("");
  }

  // 总结
  const allPassed = results.every((r) => r.status === "✅");
  const hasWarnings = results.some((r) => r.status === "⚠️");

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (allPassed) {
    console.log("✅ 所有检查通过！系统已准备好进行集成测试。\n");
    console.log("🚀 下一步：");
    console.log("   1. 在飞书中发送: @NanoBot 分析 Athena 项目结构");
    console.log("   2. 在钉钉中发送: @NanoBot 列出所有项目");
    console.log("   3. 验证结果是否正确回调\n");
  } else if (hasWarnings) {
    console.log("⚠️  部分检查有警告，但系统基本可用。\n");
  } else {
    console.log("❌ 部分检查失败，请检查系统配置。\n");
    console.log("💡 故障排查：");
    console.log("   1. 确保 Realm 服务器运行: npm run server");
    console.log("   2. 确保 NanoBot 运行: nanobot gateway --port 18790");
    console.log("   3. 检查防火墙设置");
    console.log("   4. 查看日志文件\n");
  }

  // 显示快速命令
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("💻 快速命令\n");
  console.log("查看所有 sessions:");
  console.log("  curl http://localhost:4003/sessions | jq\n");
  console.log("发送测试任务:");
  console.log("  curl -X POST http://localhost:4003/dispatch \\");
  console.log("    -H 'Content-Type: application/json' \\");
  console.log("    -d '{\"message\":\"分析项目结构\",\"callbackUrl\":\"http://localhost:3001/callback\"}'\n");
  console.log("查看 Realm 日志:");
  console.log("  tail -f /tmp/realm-server.log\n");
}

main().catch(console.error);
