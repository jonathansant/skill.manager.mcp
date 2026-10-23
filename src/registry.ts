import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import type { Profile } from "./config.js";
import { currentCommit, syncCheckout } from "./git.js";
import { log } from "./log.js";
import { discoverSkills, type Skill, type SkillError } from "./skills.js";

export interface ExposedSkill extends Skill {
  /** Name the agent uses: the bare skill name, or `<profile>-<name>` when two active profiles share a name. */
  id: string;
}

export interface ProfileStatus {
  name: string;
  repo: string;
  branch: string;
  path: string;
  checkoutDir: string;
  commit?: string;
  lastSyncAt?: Date;
  lastSyncError?: string;
  skillCount: number;
  errors: SkillError[];
}

interface ProfileState {
  profile: Profile;
  checkoutDir: string;
  commit?: string;
  lastSyncAt?: Date;
  lastSyncError?: string;
  skills: Skill[];
  errors: SkillError[];
  timer?: NodeJS.Timeout;
  inFlight?: Promise<void>;
}

export interface SkillRegistryEvents {
  changed: [];
}

/**
 * Keeps one checkout per active profile in sync with its remote branch and holds the skills found in it. Emits
 * `changed` whenever the set of exposed skills may have changed (a new commit was loaded).
 */
export class SkillRegistry extends EventEmitter<SkillRegistryEvents> {
  private readonly states: ProfileState[];
  private exposed: ExposedSkill[] = [];
  private stopped = false;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;

  constructor(profiles: Profile[], cacheDir: string) {
    super();
    this.states = profiles.map((profile) => ({
      profile,
      checkoutDir: path.join(cacheDir, "repos", checkoutKey(profile)),
      skills: [],
      errors: [],
    }));
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
  }

  /** Performs the initial sync of every profile, then keeps polling on each profile's interval. */
  async start(): Promise<void> {
    await Promise.all(this.states.map((s) => this.sync(s)));
    this.resolveReady();
    for (const s of this.states) this.schedule(s);
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.states) clearTimeout(s.timer);
  }

  /** Syncs all profiles immediately (used by the refresh tool). */
  async refresh(): Promise<void> {
    await Promise.all(this.states.map((s) => this.sync(s)));
  }

  skills(): ExposedSkill[] {
    return this.exposed;
  }

  status(): ProfileStatus[] {
    return this.states.map((s) => ({
      name: s.profile.name,
      repo: s.profile.repo,
      branch: s.profile.branch,
      path: s.profile.path,
      checkoutDir: s.checkoutDir,
      commit: s.commit,
      lastSyncAt: s.lastSyncAt,
      lastSyncError: s.lastSyncError,
      skillCount: s.skills.length,
      errors: s.errors,
    }));
  }

  /** Looks a skill up by its exposed id, or by `profile/name` / `profile:name`. */
  resolve(ref: string): ExposedSkill {
    const key = ref.trim();
    const byId = this.exposed.find((s) => s.id === key);
    if (byId) return byId;
    const qualified = /^([^/:]+)[/:](.+)$/.exec(key);
    if (qualified) {
      const hit = this.exposed.find((s) => s.profile === qualified[1] && s.name === qualified[2]);
      if (hit) return hit;
    }
    const byName = this.exposed.filter((s) => s.name === key);
    if (byName.length > 1) {
      throw new Error(`skill "${key}" exists in several profiles; use one of: ${byName.map((s) => s.id).join(", ")}`);
    }
    if (byName[0]) return byName[0];
    const known = this.exposed.map((s) => s.id).join(", ") || "none";
    throw new Error(`unknown skill "${key}" (available: ${known})`);
  }

  private schedule(s: ProfileState): void {
    if (this.stopped) return;
    s.timer = setTimeout(async () => {
      await this.sync(s);
      this.schedule(s);
    }, s.profile.pollIntervalSeconds * 1000);
    s.timer.unref();
  }

  private sync(s: ProfileState): Promise<void> {
    // Coalesce overlapping syncs (poll timer + manual refresh) into one.
    s.inFlight ??= this.doSync(s).finally(() => (s.inFlight = undefined));
    return s.inFlight;
  }

  private async doSync(s: ProfileState): Promise<void> {
    const { profile } = s;
    let commit: string | undefined;
    try {
      commit = await syncCheckout(profile.repo, profile.branch, s.checkoutDir);
      s.lastSyncError = undefined;
    } catch (err) {
      s.lastSyncError = (err as Error).message;
      log(`profile "${profile.name}": sync failed: ${s.lastSyncError}`);
      // Offline at startup: fall back to whatever checkout is already on disk from a previous run.
      if (s.commit !== undefined) return;
      commit = await currentCommit(s.checkoutDir);
      if (!commit) return;
    } finally {
      s.lastSyncAt = new Date();
    }
    // Compare against what this process loaded, not the pre-fetch HEAD: another server process sharing the
    // checkout may already have advanced it.
    if (commit === s.commit) return;

    const root = path.resolve(s.checkoutDir, profile.path);
    const { skills, errors } = await discoverSkills(root, profile.name);
    s.skills = skills;
    s.errors = errors;
    s.commit = commit;
    for (const e of errors) log(`profile "${profile.name}": skipped ${e.file}: ${e.message}`);
    log(`profile "${profile.name}": loaded ${skills.length} skill(s) at ${commit.slice(0, 10)} (${profile.branch})`);
    this.rebuild();
  }

  private rebuild(): void {
    const all = this.states.flatMap((s) => s.skills);
    const counts = new Map<string, number>();
    for (const s of all) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
    this.exposed = all
      .map((s) => ({ ...s, id: counts.get(s.name)! > 1 ? `${s.profile}-${s.name}` : s.name }))
      .sort((a, b) => a.id.localeCompare(b.id));
    this.emit("changed");
  }
}

function checkoutKey(profile: Profile): string {
  const hash = createHash("sha256").update(`${profile.repo}\0${profile.branch}`).digest("hex").slice(0, 10);
  return `${profile.name}-${hash}`;
}
