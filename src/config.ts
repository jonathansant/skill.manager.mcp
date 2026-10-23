import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const NAME = /^[a-z0-9][a-z0-9._-]*$/i;

const ProfileSchema = z.object({
  /** Git URL (https, ssh) or a local path to a git repository. */
  repo: z.string().min(1),
  /** Branch (or tag) to track. */
  branch: z.string().min(1).default("main"),
  /** Sub-directory inside the repo that contains the skills. */
  path: z.string().default("."),
  /** Overrides the global poll interval for this profile. */
  pollIntervalSeconds: z.number().int().positive().optional(),
  description: z.string().optional(),
});

const AgentSchema = z.object({
  profiles: z.array(z.string()).min(1),
  /** Also copy this agent's skills into a native skills directory, e.g. ~/.claude/skills. */
  installDir: z.string().optional(),
});

const ConfigSchema = z
  .object({
    pollIntervalSeconds: z.number().int().positive().default(60),
    cacheDir: z.string().optional(),
    profiles: z.record(z.string().regex(NAME, "profile names must be alphanumeric with . _ -"), ProfileSchema),
    agents: z.record(z.string(), AgentSchema).default({}),
  })
  .superRefine((cfg, ctx) => {
    if (Object.keys(cfg.profiles).length === 0) {
      ctx.addIssue({ code: "custom", path: ["profiles"], message: "at least one profile is required" });
    }
    for (const [agent, def] of Object.entries(cfg.agents)) {
      for (const p of def.profiles) {
        if (!cfg.profiles[p]) {
          ctx.addIssue({ code: "custom", path: ["agents", agent, "profiles"], message: `unknown profile "${p}"` });
        }
      }
    }
  });

export type ProfileConfig = z.infer<typeof ProfileSchema>;
export type Config = z.infer<typeof ConfigSchema> & { cacheDir: string; configPath: string };

export interface Profile extends ProfileConfig {
  name: string;
  pollIntervalSeconds: number;
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function looksLikeRemote(repo: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || /^[^/\\]+@[^:]+:/.test(repo);
}

export function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "skill-manager-mcp", "config.yaml");
}

export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(base, "skill-manager-mcp");
}

/** Resolves the config path from (in order) an explicit value, $SKILL_MANAGER_CONFIG, then the default location. */
export function resolveConfigPath(explicit?: string): string {
  const p = explicit ?? process.env.SKILL_MANAGER_CONFIG ?? defaultConfigPath();
  return path.resolve(expandHome(p));
}

export async function loadConfig(configPath: string, cacheDirOverride?: string): Promise<Config> {
  if (!existsSync(configPath)) {
    throw new Error(`config file not found: ${configPath} (pass --config or set SKILL_MANAGER_CONFIG)`);
  }
  const raw = await readFile(configPath, "utf8");
  const data = configPath.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  const result = ConfigSchema.safeParse(data ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`invalid config ${configPath}:\n${issues}`);
  }
  const cfg = result.data;
  const configDir = path.dirname(configPath);

  // Local repo paths are resolved relative to the config file so configs can be checked in alongside skills.
  for (const profile of Object.values(cfg.profiles)) {
    if (!looksLikeRemote(profile.repo)) {
      profile.repo = path.resolve(configDir, expandHome(profile.repo));
    }
  }

  for (const agent of Object.values(cfg.agents)) {
    if (agent.installDir) agent.installDir = path.resolve(configDir, expandHome(agent.installDir));
  }

  const cacheDir = cacheDirOverride ?? process.env.SKILL_MANAGER_CACHE_DIR ?? cfg.cacheDir;
  return {
    ...cfg,
    cacheDir: cacheDir ? path.resolve(configDir, expandHome(cacheDir)) : defaultCacheDir(),
    configPath,
  };
}

/**
 * Picks the profiles this server instance exposes. Profiles named explicitly and profiles assigned to the
 * agent are combined; with neither, every profile is active.
 */
export function selectProfiles(cfg: Config, opts: { agent?: string; profiles?: string[] }): Profile[] {
  const names = new Set<string>();
  if (opts.agent) {
    const agent = cfg.agents[opts.agent];
    if (!agent) {
      const known = Object.keys(cfg.agents).join(", ") || "none defined";
      throw new Error(`unknown agent "${opts.agent}" (known: ${known})`);
    }
    agent.profiles.forEach((p) => names.add(p));
  }
  for (const p of opts.profiles ?? []) {
    if (!cfg.profiles[p]) {
      throw new Error(`unknown profile "${p}" (known: ${Object.keys(cfg.profiles).join(", ")})`);
    }
    names.add(p);
  }
  if (names.size === 0) {
    Object.keys(cfg.profiles).forEach((p) => names.add(p));
  }
  return [...names].map((name) => {
    const p = cfg.profiles[name]!;
    return { ...p, name, pollIntervalSeconds: p.pollIntervalSeconds ?? cfg.pollIntervalSeconds };
  });
}

/** The native skills directory to mirror into: an explicit value, then $SKILL_MANAGER_INSTALL_DIR, then the agent's. */
export function resolveInstallDir(cfg: Config, agent: string | undefined, explicit?: string): string | undefined {
  const dir = explicit ?? process.env.SKILL_MANAGER_INSTALL_DIR;
  if (dir) return path.resolve(expandHome(dir));
  return agent ? cfg.agents[agent]?.installDir : undefined;
}
