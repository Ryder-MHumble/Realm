#!/usr/bin/env node

/**
 * Auto-discover projects and create sessions
 *
 * Usage:
 *   npx tsx bin/auto-discover-projects.ts [--scan-dir /path/to/scan] [--create-sessions]
 */

import { program } from "commander";
import { readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import fetch from "node-fetch";

const API_BASE = process.env.REALM_API || "http://localhost:4003";

interface ProjectInfo {
  path: string;
  name: string;
  type: string; // 'typescript', 'python', 'go', 'rust', 'flutter', 'other'
  hasGit: boolean;
  hasPackageJson: boolean;
  hasPyproject: boolean;
  hasGoMod: boolean;
  hasCargoToml: boolean;
}

// ============================================================================
// Project Detection
// ============================================================================

function detectProjectType(projectPath: string): string {
  try {
    const files = readdirSync(projectPath);

    if (files.includes("package.json")) return "typescript";
    if (files.includes("pyproject.toml") || files.includes("setup.py"))
      return "python";
    if (files.includes("go.mod")) return "go";
    if (files.includes("Cargo.toml")) return "rust";
    if (files.includes("pubspec.yaml")) return "flutter";

    return "other";
  } catch {
    return "other";
  }
}

function scanDirectory(scanDir: string): ProjectInfo[] {
  const projects: ProjectInfo[] = [];

  try {
    const entries = readdirSync(scanDir);

    for (const entry of entries) {
      // Skip hidden directories and common non-project directories
      if (entry.startsWith(".") || entry === "node_modules") continue;

      const fullPath = resolve(scanDir, entry);

      try {
        const stat = statSync(fullPath);
        if (!stat.isDirectory()) continue;

        const files = readdirSync(fullPath);
        const hasGit = files.includes(".git");
        const hasPackageJson = files.includes("package.json");
        const hasPyproject =
          files.includes("pyproject.toml") || files.includes("setup.py");
        const hasGoMod = files.includes("go.mod");
        const hasCargoToml = files.includes("Cargo.toml");

        // Only include directories that look like projects
        if (hasGit || hasPackageJson || hasPyproject || hasGoMod || hasCargoToml) {
          projects.push({
            path: fullPath,
            name: entry,
            type: detectProjectType(fullPath),
            hasGit,
            hasPackageJson,
            hasPyproject,
            hasGoMod,
            hasCargoToml,
          });
        }
      } catch {
        // Skip directories we can't read
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${scanDir}:`, error);
  }

  return projects;
}

// ============================================================================
// Session Creation
// ============================================================================

async function createSession(
  projectPath: string,
  projectName: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: projectName,
        cwd: projectPath,
        agentType: "claude_code",
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      ok: boolean;
      session: { id: string };
    };
    return data.session.id;
  } catch (error) {
    console.error(`Failed to create session for ${projectName}:`, error);
    return null;
  }
}

// ============================================================================
// Main Commands
// ============================================================================

async function scanProjects(scanDir: string) {
  console.log(`\n🔍 Scanning directory: ${scanDir}\n`);

  const projects = scanDirectory(scanDir);

  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }

  console.log(`Found ${projects.length} project(s):\n`);

  for (const project of projects) {
    const tags = [];
    if (project.hasGit) tags.push("git");
    if (project.hasPackageJson) tags.push("npm");
    if (project.hasPyproject) tags.push("python");
    if (project.hasGoMod) tags.push("go");
    if (project.hasCargoToml) tags.push("rust");

    console.log(`  📁 ${project.name}`);
    console.log(`     Path: ${project.path}`);
    console.log(`     Type: ${project.type}`);
    console.log(`     Tags: ${tags.join(", ")}`);
    console.log("");
  }

  return projects;
}

async function createSessionsForProjects(
  scanDir: string,
  dryRun: boolean = false,
) {
  console.log(`\n🚀 Creating sessions for projects in: ${scanDir}\n`);

  const projects = scanDirectory(scanDir);

  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }

  console.log(`Found ${projects.length} project(s). Creating sessions...\n`);

  const results = [];

  for (const project of projects) {
    console.log(`📝 Creating session for: ${project.name}`);

    if (dryRun) {
      console.log(`   [DRY RUN] Would create session at: ${project.path}`);
      results.push({
        project: project.name,
        status: "dry-run",
        sessionId: null,
      });
    } else {
      const sessionId = await createSession(project.path, project.name);
      if (sessionId) {
        console.log(`   ✅ Session created: ${sessionId}`);
        results.push({
          project: project.name,
          status: "created",
          sessionId,
        });
      } else {
        console.log(`   ❌ Failed to create session`);
        results.push({
          project: project.name,
          status: "failed",
          sessionId: null,
        });
      }
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 Summary:");
  console.log("=".repeat(60));

  const created = results.filter((r) => r.status === "created").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const dryRuns = results.filter((r) => r.status === "dry-run").length;

  console.log(`  Created: ${created}`);
  console.log(`  Failed: ${failed}`);
  if (dryRuns > 0) console.log(`  Dry runs: ${dryRuns}`);

  console.log("\nDetailed results:");
  for (const result of results) {
    const icon =
      result.status === "created"
        ? "✅"
        : result.status === "failed"
          ? "❌"
          : "📋";
    console.log(
      `  ${icon} ${result.project}: ${result.sessionId || result.status}`,
    );
  }
}

// ============================================================================
// CLI Setup
// ============================================================================

program
  .name("auto-discover-projects")
  .description("Auto-discover projects and create sessions")
  .version("1.0.0");

program
  .command("scan")
  .description("Scan directory for projects")
  .option(
    "--scan-dir <path>",
    "Directory to scan",
    resolve(homedir(), "Desktop/My Projects"),
  )
  .action((options) => {
    scanProjects(options.scanDir);
  });

program
  .command("create")
  .description("Create sessions for all discovered projects")
  .option(
    "--scan-dir <path>",
    "Directory to scan",
    resolve(homedir(), "Desktop/My Projects"),
  )
  .option("--dry-run", "Show what would be created without creating")
  .action((options) => {
    createSessionsForProjects(options.scanDir, options.dryRun);
  });

program.parse(process.argv);
