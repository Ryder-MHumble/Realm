#!/usr/bin/env node

/**
 * Simulate OpenClaw CLI
 *
 * Usage:
 *   npx ts-node bin/simulate-openclaw.ts create-session --name "Frontend" --cwd /path/to/project
 *   npx ts-node bin/simulate-openclaw.ts send-query --session-id <id> --query "your query"
 *   npx ts-node bin/simulate-openclaw.ts get-result --session-id <id>
 *   npx ts-node bin/simulate-openclaw.ts screenshot --url http://localhost:5173 --output screenshot.png
 */

import { program } from "commander";
import fetch from "node-fetch";
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { resolve } from "path";

const API_BASE = process.env.REALM_API || "http://localhost:3000";

interface SessionResponse {
  id: string;
  name: string;
  cwd: string;
  status: string;
  agentType: string;
}

interface DispatchResponse {
  ok: boolean;
  taskGroupId: string;
  dispatched: Array<{
    sessionId: string;
    sessionName: string;
    prompt: string;
  }>;
  error?: string;
}

// ============================================================================
// Commands
// ============================================================================

/**
 * Create a new session
 */
async function createSession(options: {
  name: string;
  cwd: string;
  agentType?: string;
}) {
  try {
    const response = await fetch(`${API_BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: options.name,
        cwd: options.cwd,
        agentType: options.agentType || "claude_code",
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      ok: boolean;
      session: SessionResponse;
    };
    const session = data.session;

    console.log("✓ Session created:");
    console.log(`  ID: ${session.id}`);
    console.log(`  Name: ${session.name}`);
    console.log(`  CWD: ${session.cwd}`);
    console.log(`  Status: ${session.status}`);
    return session;
  } catch (error) {
    console.error("✗ Failed to create session:", error);
    process.exit(1);
  }
}

/**
 * Send a query to a session via dispatch API
 */
async function sendQuery(options: {
  sessionId?: string;
  query: string;
  callbackUrl?: string;
}) {
  try {
    const payload: Record<string, unknown> = {
      message: options.query,
    };

    if (options.sessionId) {
      payload.sessionId = options.sessionId;
    }

    if (options.callbackUrl) {
      payload.callbackUrl = options.callbackUrl;
    }

    const response = await fetch(`${API_BASE}/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const result = (await response.json()) as DispatchResponse;

    if (!result.ok) {
      throw new Error(result.error || "Dispatch failed");
    }

    console.log("✓ Query dispatched:");
    console.log(`  Task Group ID: ${result.taskGroupId}`);
    console.log(`  Dispatched to ${result.dispatched.length} session(s):`);
    for (const task of result.dispatched) {
      console.log(`    - ${task.sessionName} (${task.sessionId})`);
      console.log(`      Prompt: ${task.prompt.slice(0, 100)}...`);
    }

    return result;
  } catch (error) {
    console.error("✗ Failed to send query:", error);
    process.exit(1);
  }
}

/**
 * Get session result (poll until complete)
 */
async function getResult(options: {
  sessionId: string;
  timeout?: number;
  pollInterval?: number;
}) {
  const timeout = options.timeout || 60000; // 60 seconds default
  const pollInterval = options.pollInterval || 2000; // 2 seconds
  const startTime = Date.now();

  try {
    while (Date.now() - startTime < timeout) {
      const response = await fetch(`${API_BASE}/sessions/${options.sessionId}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        ok: boolean;
        session: SessionResponse & { lastResponse?: string };
      };
      const session = data.session;

      console.log(
        `[${new Date().toLocaleTimeString()}] Status: ${session.status}`,
      );

      if (session.status === "stopped" || session.status === "completed") {
        console.log("✓ Session completed:");
        console.log(`  Status: ${session.status}`);
        if (session.lastResponse) {
          console.log(`  Response: ${session.lastResponse}`);
        }
        return session;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Timeout waiting for session result (${timeout}ms)`);
  } catch (error) {
    console.error("✗ Failed to get result:", error);
    process.exit(1);
  }
}

/**
 * Take a screenshot of a URL using Playwright
 */
async function takeScreenshot(options: {
  url: string;
  output: string;
  width?: number;
  height?: number;
  waitFor?: string;
}) {
  let browser;
  try {
    console.log(`📸 Taking screenshot of ${options.url}...`);

    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: {
        width: options.width || 1280,
        height: options.height || 720,
      },
    });

    await page.goto(options.url, { waitUntil: "networkidle" });

    if (options.waitFor) {
      console.log(`⏳ Waiting for selector: ${options.waitFor}`);
      await page.waitForSelector(options.waitFor, { timeout: 10000 });
    }

    const outputPath = resolve(options.output);
    await page.screenshot({ path: outputPath, fullPage: false });

    console.log(`✓ Screenshot saved to: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error("✗ Failed to take screenshot:", error);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * List all sessions
 */
async function listSessions() {
  try {
    const response = await fetch(`${API_BASE}/sessions`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      ok: boolean;
      sessions: SessionResponse[];
    };
    const sessions = data.sessions || [];

    if (sessions.length === 0) {
      console.log("No sessions found");
      return;
    }

    console.log(`Found ${sessions.length} session(s):\n`);
    for (const session of sessions) {
      console.log(`  ID: ${session.id}`);
      console.log(`  Name: ${session.name}`);
      console.log(`  CWD: ${session.cwd}`);
      console.log(`  Status: ${session.status}`);
      console.log(`  Agent: ${session.agentType}`);
      console.log("");
    }
  } catch (error) {
    console.error("✗ Ft sessions:", error);
    process.exit(1);
  }
}

/**
 * Full workflow: create session → send query → wait for result → screenshot
 */
async function workflow(options: {
  name: string;
  cwd: string;
  query: string;
  screenshotUrl?: string;
  screenshotOutput?: string;
  timeout?: number;
}) {
  try {
    console.log("🚀 Starting workflow...\n");

    // Step 1: Create session
    console.log("Step 1: Creating session...");
    const session = await createSession({
      name: options.name,
      cwd: options.cwd,
    });
    console.log("");

    // Step 2: Send query
    console.log("Step 2: Sending query...");
    const dispatch = await sendQuery({
      sessionId: session.id,
      query: options.query,
    });
    console.log("");

    // Step 3: Wait for result
    console.log("Step 3: Waiting for result...");
    const result = await getResult({
      sessionId: session.id,
      timeout: options.timeout,
    });
    console.log("");

    // Step 4: Screenshot (optional)
    if (options.screenshotUrl && options.screenshotOutput) {
      console.log("Step 4: Taking screenshot...");
      await takeScreenshot({
        url: options.screenshotUrl,
        output: options.screenshotOutput,
      });
      console.log("");
    }

    console.log("✓ Workflow completed successfully!");
    return { session, dispatch, result };
  } catch (error) {
    console.error("✗ Workflow failed:", error);
    process.exit(1);
  }
}

// ============================================================================
// CLI Setup
// ============================================================================

program
  .name("simulate-openclaw")
  .description("Simulate OpenClaw integration with Realm")
  .version("1.0.0");

program
  .command("create-session")
  .description("Create a new session")
  .requiredOption("--name <name>", "Session name")
  .requiredOption("--cwd <path>", "Working directory")
  .option("--agent-type <type>", "Agent type (default: claude_code)")
  .action((options) => {
    createSession({
      name: options.name,
      cwd: options.cwd,
      agentType: options.agentType,
    });
  });

program
  .command("send-query")
  .description("Send a query to a session")
  .requiredOption("--query <query>", "Query to send")
  .option("--session-id <id>", "Target session ID (optional)")
  .option("--callback-url <url>", "Callback URL for results")
  .action((options) => {
    sendQuery({
      sessionId: options.sessionId,
      query: options.query,
      callbackUrl: options.callbackUrl,
    });
  });

program
  .command("get-result")
  .description("Get result from a session")
  .requiredOption("--session-id <id>", "Session ID")
  .option("--timeout <ms>", "Timeout in milliseconds (default: 60000)")
  .option(
    "--poll-interval <ms>",
    "Poll interval in milliseconds (default: 2000)",
  )
  .action((options) => {
    getResult({
      sessionId: options.sessionId,
      timeout: options.timeout ? parseInt(options.timeout) : undefined,
      pollInterval: options.pollInterval
        ? parseInt(options.pollInterval)
        : undefined,
    });
  });

program
  .command("screenshot")
  .description("Take a screenshot of a URL")
  .requiredOption("--url <url>", "URL to screenshot")
  .requiredOption("--output <path>", "Output file path")
  .option("--width <px>", "Viewport width (default: 1280)")
  .option("--height <px>", "Viewport height (default: 720)")
  .option("--wait-for <selector>", "CSS selector to wait for")
  .action((options) => {
    takeScreenshot({
      url: options.url,
      output: options.output,
      width: options.width ? parseInt(options.width) : undefined,
      height: options.height ? parseInt(options.height) : undefined,
      waitFor: options.waitFor,
    });
  });

program
  .command("list-sessions")
  .description("List all sessions")
  .action(() => {
    listSessions();
  });

program
  .command("workflow")
  .description("Run full workflow: create → query → wait → screenshot")
  .requiredOption("--name <name>", "Session name")
  .requiredOption("--cwd <path>", "Working directory")
  .requiredOption("--query <query>", "Query to send")
  .option("--screenshot-url <url>", "URL to screenshot after completion")
  .option("--screenshot-output <path>", "Screenshot output path")
  .option("--timeout <ms>", "Timeout in milliseconds (default: 60000)")
  .action((options) => {
    workflow({
      name: options.name,
      cwd: options.cwd,
      query: options.query,
      screenshotUrl: options.screenshotUrl,
      screenshotOutput: options.screenshotOutput,
      timeout: options.timeout ? parseInt(options.timeout) : undefined,
    });
  });

program.parse(process.argv);
