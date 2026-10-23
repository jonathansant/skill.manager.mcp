#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, resolveConfigPath, resolveInstallDir, selectProfiles } from "./config.js";
import { log } from "./log.js";
import { mirrorOnChange, mirrorSkills, type MirrorOptions, type MirrorResult } from "./mirror.js";
import { SkillRegistry } from "./registry.js";
import { createServer } from "./server.js";
import { discoverSkills } from "./skills.js";

const USAGE = `skill-manager-mcp — serve git-backed agent skills over MCP

Usage:
  skill-manager-mcp [serve] [options]   Run the MCP server on stdio (default)
  skill-manager-mcp list [options]      Sync once and print the skills this agent would see
  skill-manager-mcp sync [options]      Sync once, copy skills into the install dir, and exit
  skill-manager-mcp validate [dir]      Validate SKILL.md files in a skills repo (for CI); exits 1 on errors
  skill-manager-mcp init [options]      Write a starter config file (to --config or the default location)

Options:
  -c, --config <file>      Config file (default: $SKILL_MANAGER_CONFIG or ~/.config/skill-manager-mcp/config.yaml)
  -a, --agent <name>       Expose the profiles assigned to this agent in the config ($SKILL_MANAGER_AGENT)
  -p, --profiles <a,b>     Expose these profiles (combined with --agent) ($SKILL_MANAGER_PROFILES)
  -i, --install-dir <dir>  Also copy skills into this native skills directory, e.g. ~/.claude/skills
                           ($SKILL_MANAGER_INSTALL_DIR, or the agent's installDir in the config)
      --cache-dir <dir>    Where checkouts are kept (default: ~/.cache/skill-manager-mcp)
  -v, --version            Print the version
  -h, --help               Show this help
`;

function version(): string {
  try {
    const pkg = new URL("../package.json", import.meta.url);
    return JSON.parse(readFileSync(pkg, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      agent: { type: "string", short: "a" },
      profiles: { type: "string", short: "p" },
      "install-dir": { type: "string", short: "i" },
      "cache-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const command = positionals[0] ?? "serve";

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version) {
    console.log(version());
    return;
  }

  if (command === "validate") {
    process.exitCode = await validate(path.resolve(positionals[1] ?? "."));
    return;
  }
  if (command === "init") {
    await init(resolveConfigPath(values.config));
    return;
  }
  if (!["serve", "list", "sync"].includes(command)) {
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const config = await loadConfig(resolveConfigPath(values.config), values["cache-dir"]);
  const agent = values.agent ?? process.env.SKILL_MANAGER_AGENT;
  const profileList = (values.profiles ?? process.env.SKILL_MANAGER_PROFILES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const profiles = selectProfiles(config, { agent, profiles: profileList });
  const installDir = resolveInstallDir(config, agent, values["install-dir"]);
  const registry = new SkillRegistry(profiles, config.cacheDir);
  const mirrorOptions = (): MirrorOptions => ({
    activeProfiles: registry.status().map((p) => p.name),
    loadedProfiles: registry.status().filter((p) => p.commit).map((p) => p.name),
  });

  if (command === "list") {
    await registry.refresh();
    for (const p of registry.status()) {
      console.log(`${p.name}  ${p.repo}@${p.branch}  ${p.commit?.slice(0, 10) ?? "(not loaded)"}`);
      if (p.lastSyncError) console.log(`  sync error: ${p.lastSyncError}`);
      for (const s of registry.skills().filter((s) => s.profile === p.name)) console.log(`  - ${s.id}: ${s.description}`);
      for (const e of p.errors) console.log(`  ! ${e.file}: ${e.message}`);
    }
    if (installDir) console.log(`install dir: ${installDir}`);
    return;
  }

  if (command === "sync") {
    if (!installDir) throw new Error("sync needs an install dir: pass --install-dir or set installDir for the agent");
    await registry.refresh();
    const result = await mirrorSkills(registry.skills(), installDir, mirrorOptions());
    console.log(describeMirror(result, installDir));
    for (const s of result.skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
    for (const p of registry.status()) if (p.lastSyncError) console.log(`  ${p.name} sync error: ${p.lastSyncError}`);
    process.exitCode = registry.status().some((p) => p.lastSyncError) || result.skipped.length ? 1 : 0;
    return;
  }

  log(
    `starting with profiles: ${profiles.map((p) => p.name).join(", ")}${agent ? ` (agent ${agent})` : ""}` +
      (installDir ? `, mirroring to ${installDir}` : ""),
  );
  const server = createServer(registry, version());
  // Connect first so the client's initialize isn't held up by a slow clone; list requests wait for the first sync.
  await server.connect(new StdioServerTransport());
  void registry.start();

  if (installDir) {
    const mirror = mirrorOnChange(
      () => registry.skills(),
      mirrorOptions,
      installDir,
      (result) => {
        if (result.installed.length || result.updated.length || result.removed.length) {
          log(describeMirror(result, installDir));
        }
        for (const s of result.skipped) log(`not mirroring ${s.id}: ${s.reason}`);
      },
      (err) => log(`mirror to ${installDir} failed: ${err.message}`),
    );
    // Wait for every profile's first sync so a partial startup state isn't mirrored.
    void registry.ready.then(() => {
      mirror();
      registry.on("changed", mirror);
    });
  }

  const shutdown = () => {
    registry.stop();
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

function describeMirror(r: MirrorResult, installDir: string): string {
  const parts = [
    r.installed.length && `installed ${r.installed.join(", ")}`,
    r.updated.length && `updated ${r.updated.join(", ")}`,
    r.removed.length && `removed ${r.removed.join(", ")}`,
  ].filter(Boolean);
  return `mirrored to ${installDir}: ${parts.join("; ") || "up to date"}`;
}

async function init(configPath: string): Promise<void> {
  if (existsSync(configPath)) {
    console.log(`config already exists: ${configPath}`);
    return;
  }
  const example = await readFile(new URL("../config.example.yaml", import.meta.url), "utf8");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, example);
  console.log(`wrote ${configPath}\nedit its profiles, then add the server to your agent (see the README).`);
}

async function validate(dir: string): Promise<number> {
  const { skills, errors } = await discoverSkills(dir, "local");
  for (const s of skills) console.log(`ok    ${s.relDir}  (${s.name})`);
  for (const e of errors) console.log(`error ${e.file}: ${e.message}`);
  console.log(`\n${skills.length} valid skill(s), ${errors.length} error(s)`);
  return errors.length || skills.length === 0 ? 1 : 0;
}

main().catch((err) => {
  log((err as Error).message);
  process.exit(1);
});
