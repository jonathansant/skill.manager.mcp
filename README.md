# skill-manager-mcp

An MCP server that gives agents the skills your team keeps in git.

- **Profiles.** A profile points at a git repo of skills, and optionally a branch (default `main`) and a sub-directory.
  You can define as many profiles as you like.
- **Per-agent selection.** Each agent's MCP entry says which profiles it gets, either by naming an agent from the config
  (`--agent`) or by listing profiles (`--profiles`).
- **Always current.** The server polls each profile's branch and reloads when a new commit lands. Merge a PR that adds
  or changes a skill and every connected agent has it within one poll interval. Clients are told through MCP
  `list_changed` notifications, so they don't need restarting.

## How skills are exposed

A skill is any directory containing a `SKILL.md` with YAML frontmatter, the same format Claude Code and the Agent
SDK use:

```markdown
---
name: deploy-service
description: Deploy a backend service to production. Use when asked to ship, release or deploy.
---

1. Run `scripts/preflight.sh` ...
```

Everything else in the directory (scripts, references, templates) is bundled with the skill.

The server gives the agent:

| Kind | Name | Purpose |
| --- | --- | --- |
| Tool | `use_skill` | Loads a skill's instructions. Its description lists every available skill (name and description), so the agent can see what's on offer without an extra call. |
| Tool | `read_skill_file` | Reads a file bundled with a skill. Paths that escape the skill directory, symlinks included, are rejected. |
| Tool | `list_skills` | Shows skills grouped by profile, with repo, branch, commit, last sync, and any skills that failed to load. |
| Tool | `refresh_skills` | Pulls now instead of waiting for the next poll. |
| Prompts | one per skill | These show up as slash commands in clients that support prompts, e.g. `/mcp__skills__deploy-service` in Claude Code. |
| Resources | `skill://{profile}/{skill}/{path}` | `SKILL.md` and bundled files as MCP resources. |

If two active profiles both have a skill called `review`, they're exposed as `platform-review` and `frontend-review`.
`platform/review` also works as a reference.

## Install

Requires Node.js 20.11+ (or Bun) and `git` on the PATH. Pick one:

```bash
npx -y skill-manager-mcp@latest --version   # no install; npx fetches it
bunx skill-manager-mcp@latest --version     # same, with Bun
npm install -g skill-manager-mcp            # global install with npm
bun add -g skill-manager-mcp                # global install with Bun
```

Before the package is on npm, or to run an unreleased commit, install straight from GitHub (npm builds it on
install):

```bash
npm install -g github:jonathansant/skill.manager.mcp
```

## Update

| Installed with | How it updates |
| --- | --- |
| `npx …@latest` / `bunx …@latest` | Automatically: every agent start checks npm for the newest version. Use `@0.1.0` instead of `@latest` to pin a version. |
| `npm install -g` | `npm install -g skill-manager-mcp@latest` |
| `bun add -g` | `bun add -g skill-manager-mcp@latest` |
| GitHub | Re-run the same `npm install -g github:…` command. |

Agents start the server when they launch, so restart the agent (or reconnect the MCP server) to pick up a new global
install. `skill-manager-mcp --version` shows what's installed.

## Configure

Run `skill-manager-mcp init` to write a starter config to `~/.config/skill-manager-mcp/config.yaml` (or wherever
`--config` points), then edit its profiles. A minimal config:

```yaml
pollIntervalSeconds: 60
profiles:
  platform:
    repo: git@github.com:my-org/platform-skills.git
  frontend:
    repo: https://github.com/my-org/frontend-skills.git
    branch: main
    path: skills
agents:
  claude-code:
    profiles: [platform, frontend]
  backend-bot:
    profiles: [platform]
```

Git runs with your normal credentials (SSH agent or credential helper). Prompts are disabled, so a missing credential
shows up as a sync error instead of hanging the server.

## Adding it to an agent

Claude Code, using npx (always the latest version):

```bash
claude mcp add skills -- npx -y skill-manager-mcp@latest --agent claude-code
```

Or with a global install:

```bash
claude mcp add skills -- skill-manager-mcp --agent claude-code
```

Any agent that takes JSON config (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "skills": {
      "command": "npx",
      "args": ["-y", "skill-manager-mcp@latest", "--agent", "backend-bot"]
    }
  }
}
```

For Bun, use `"command": "bunx"` with `"args": ["skill-manager-mcp@latest", "--agent", "backend-bot"]`. With a
global install, use `"command": "skill-manager-mcp"` and drop the package name from `args`.

`@latest` asks npm for the newest version every time the agent starts, which needs network access and adds a moment
to startup. Pin a version if you'd rather upgrade on purpose.

Ways to choose profiles, which can be combined:

- `--agent <name>` / `SKILL_MANAGER_AGENT`: the profiles listed under `agents.<name>` in the config.
- `--profiles a,b` / `SKILL_MANAGER_PROFILES`: these profiles, added to the agent's profiles.
- Neither: all profiles.

Other options: `--config <file>` / `SKILL_MANAGER_CONFIG`, and `--cache-dir <dir>` / `SKILL_MANAGER_CACHE_DIR`.

## Native skills mode (optional)

Agents with their own skills system, such as Claude Code, only trigger skills automatically when they're in their
skills directory. Give the agent an `installDir` and the server also copies its skills there, keeping the copies in
step with git as it polls:

```yaml
agents:
  claude-code:
    profiles: [platform, frontend]
    installDir: ~/.claude/skills      # or a project's .claude/skills
```

`--install-dir <dir>` or `SKILL_MANAGER_INSTALL_DIR` sets it from the command line instead, overriding the config.

- Each skill is copied to `<installDir>/<skill id>`. If a profile-qualified id is used (e.g. `platform-review`), the
  copy's frontmatter `name` is rewritten to match, so the agent sees two distinct skills.
- The server records the folders it created in `<installDir>/.skill-manager.json`. It only ever changes or deletes
  those. If a folder with the same name already exists and isn't one of its own, such as a skill you wrote by hand,
  it's left alone and the clash is logged.
- A skill that's removed from git, or whose profile is dropped from the agent, is deleted from the install dir. If a
  profile can't load at all (first start while offline), its copies are kept.
- Copies are written to a staging folder and then renamed into place, so the agent never sees a half-written skill.
  A lock stops several server processes writing to the same directory at once. Point each install dir at a single
  profile set, though: two agents with different profiles sharing one directory would keep removing each other's
  skills.
- The copies persist after the server stops, so the agent keeps the last synced skills when the MCP server isn't
  running. To refresh without an agent running, use `skill-manager-mcp sync` (for example from cron).

The MCP tools stay available in this mode. The agent will then see each skill twice, natively and in the `use_skill`
catalog, which is harmless but uses some extra context.

## CLI

```bash
skill-manager-mcp list --agent claude-code   # sync once and print what that agent would see
skill-manager-mcp sync --agent claude-code   # sync once, copy skills into the agent's installDir, exit
skill-manager-mcp validate ./skills          # check every SKILL.md; exits 1 on errors
```

`validate` is meant for CI on skills repos, so a broken skill is caught in the PR instead of after merge. A GitHub
Actions step could look like this:

```yaml
- run: npx --yes skill-manager-mcp@latest validate .
```

## How syncing works

- Each profile gets a shallow checkout under `~/.cache/skill-manager-mcp/repos/<profile>-<hash>`. It's treated as a
  read-only mirror: each poll fetches the branch, hard-resets to it and cleans, so local edits there are discarded.
- Every agent starts its own server process, and processes using the same profile share one checkout. A lock file
  makes sure only one of them runs git on a checkout at a time.
- Each process reloads whenever the checkout's commit differs from what it last loaded, even if another process did
  the pull.
- If a pull fails (offline, auth expired), the last good skills keep being served and the error shows up in
  `list_skills`. If the server starts offline, it serves whatever checkout is already on disk.
- A skill with invalid frontmatter is skipped and reported. The rest of the profile still loads.
- `use_skill` returns the skill's absolute base directory, so an agent on the same machine can run bundled scripts
  directly.

## Development

```bash
npm install       # also builds dist/ (prepare script)
npm test          # unit tests plus end-to-end tests against throwaway local git repos
npm run dev -- list --config ~/.config/skill-manager-mcp/config.yaml
npm pack          # build the tarball that would be published, to try installs locally
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the tests on Node 20, 22 and 24 on Linux and macOS. It
also packs the tarball and checks that the CLI starts after `npm install -g`, `npx` and `bun add -g`.

## Releasing

Releases are run by [.github/workflows/release.yml](.github/workflows/release.yml). From GitHub:

1. Go to **Actions → Release → Run workflow**, on `main`.
2. Pick a bump (`patch`, `minor`, `major`, or a `pre*` one for a beta), or type an exact version.

The workflow then:

1. **Tests and tags:** runs the typecheck and tests, bumps `package.json` and `package-lock.json`, commits
   `chore(release): X.Y.Z`, tags `vX.Y.Z`, and pushes the commit and tag together.
2. **Builds and publishes:** checks out the tag, builds, re-runs the tests, packs the tarball and checks the CLI starts
   from it. It then publishes to npm with provenance. Pre-releases (`1.2.0-beta.0`) go to the `next` dist-tag, so
   `@latest` never points at one.
3. **Releases:** creates the GitHub release with generated notes and the tarball attached (marked as a pre-release
   when it is one).

If something fails after the tag is pushed, use **Re-run failed jobs**. A version that's already on npm, or a release
that already exists, is detected and skipped.

You can still release from your machine: `npm version patch && git push --follow-tags`. Pushing the tag runs only the
build, publish and release part.

### One-time setup

- **npm credentials:** either add an `NPM_TOKEN` repository secret (an npm automation or granular token with publish
  rights), or set up trusted publishing for this repo and `release.yml` on npmjs.com. Trusted publishing needs the
  package to exist on npm already, so do the first release with the token or a manual `npm publish`.
- **Branch protection:** if `main` is protected against direct pushes, the default `GITHUB_TOKEN` can't push the
  version commit. Add a `RELEASE_TOKEN` secret with a token that's allowed to bypass protection, and the workflow will
  use it. A tag pushed with that token also starts the tag-triggered run. That run finds everything already published
  and does nothing.
- **Actions permissions:** under Settings → Actions → General → Workflow permissions, allow read and write.
