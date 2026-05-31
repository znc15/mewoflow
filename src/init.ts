import path from "node:path";
import { pathExists, readTextIfExists, writeFileEnsured } from "./fs.js";

type ClaudeHook = Record<string, unknown> & {
  type?: string;
  command?: string;
};

type ClaudeHookGroup = Record<string, unknown> & {
  matcher?: string;
  hooks?: ClaudeHook[];
};

type ClaudeSettings = Record<string, unknown> & {
  hooks?: Record<string, ClaudeHookGroup[]>;
};

export async function initProject(root = process.cwd()): Promise<void> {
  await writeFileIfMissing(path.join(root, ".mewoflow", "rules.md"), rulesTemplate());
  await writeFileIfMissing(path.join(root, ".mewoflow", "workflow.md"), workflowTemplate());
  await writeFileIfMissing(path.join(root, ".mewoflow", "journal.md"), journalTemplate());
  await writeFileIfMissing(path.join(root, ".mewoflow", "specs", "coding.md"), codingSpecTemplate());
  await writeFileIfMissing(path.join(root, ".mewoflow", "specs", "testing.md"), testingSpecTemplate());
  await writeFileIfMissing(path.join(root, ".mewoflow", "specs", "agent.md"), agentSpecTemplate());
  await writeFileEnsured(path.join(root, ".mewoflow", "tasks", ".gitkeep"), "");
  await writeFileEnsured(path.join(root, ".mewoflow", "runtime", "sessions", ".gitkeep"), "");
  await writeFileEnsured(path.join(root, ".mewoflow", "runtime", "mewoflow-hook.cjs"), hookShimTemplate());
  await writeFileIfMissing(path.join(root, ".claude", "skills", "mewoflow-doctor", "SKILL.md"), doctorSkillTemplate());
  await writeMergedClaudeSettings(path.join(root, ".claude", "settings.json"));
}

async function writeFileIfMissing(file: string, content: string): Promise<void> {
  if (await pathExists(file)) return;
  await writeFileEnsured(file, content);
}

async function writeMergedClaudeSettings(file: string): Promise<void> {
  const settings = await readClaudeSettings(file);
  const rawHooks = isRecord(settings.hooks) ? settings.hooks : {};
  const hooks: Record<string, ClaudeHookGroup[]> = {};

  for (const [event, groups] of Object.entries(rawHooks)) {
    hooks[event] = Array.isArray(groups) ? (groups as ClaudeHookGroup[]) : [];
  }

  for (const [event, desiredGroups] of Object.entries(mewoflowHooks())) {
    const current = hooks[event] ?? [];
    hooks[event] = desiredGroups.reduce((groups, desiredGroup) => mergeHookGroup(groups, desiredGroup), current);
  }

  await writeFileEnsured(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
}

async function readClaudeSettings(file: string): Promise<ClaudeSettings> {
  const text = await readTextIfExists(file);
  if (!text) return {};

  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? (parsed as ClaudeSettings) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot merge invalid Claude Code settings at ${file}: ${message}`);
  }
}

function mergeHookGroup(existingGroups: ClaudeHookGroup[], desiredGroup: ClaudeHookGroup): ClaudeHookGroup[] {
  const desiredHooks = Array.isArray(desiredGroup.hooks) ? desiredGroup.hooks : [];
  if (desiredHooks.every((hook) => hookExists(existingGroups, hook))) return existingGroups;

  const matcher = typeof desiredGroup.matcher === "string" ? desiredGroup.matcher : "*";
  const groups = [...existingGroups];
  const targetIndex = groups.findIndex((group) => group.matcher === matcher);

  if (targetIndex === -1) return [...groups, desiredGroup];

  const target = groups[targetIndex] ?? { matcher };
  const hooks = Array.isArray(target.hooks) ? [...target.hooks] : [];
  for (const hook of desiredHooks) {
    if (!hookExists(groups, hook)) hooks.push(hook);
  }
  groups[targetIndex] = { ...target, matcher, hooks };
  return groups;
}

function hookExists(groups: ClaudeHookGroup[], desiredHook: ClaudeHook): boolean {
  return groups.some((group) => {
    const hooks = Array.isArray(group.hooks) ? group.hooks : [];
    return hooks.some((hook) => hook.type === desiredHook.type && hook.command === desiredHook.command);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rulesTemplate(): string {
  return `# MewoFlow Rules\n\n- Follow the active task gate.\n- Standard and epic tasks must complete: research -> grill -> plan -> implement -> verify -> archive.\n- Use Claude Code WebSearch/WebFetch/MCP or user-provided sources during research.\n- Read this file plus task research/grill/plan before editing.\n- Do not claim completion without verify evidence.\n`;
}

function workflowTemplate(): string {
  return `# MewoFlow Workflow\n\nnone -> research -> grill -> plan -> implement -> verify -> archive -> done\n`;
}

function journalTemplate(): string {
  return `# MewoFlow Journal\n\nTask archive summaries are appended here when \`mewoflow check archive\` passes.\n`;
}

function codingSpecTemplate(): string {
  return `# Coding Spec\n\nKeep this file short. Add project-specific coding conventions that AI agents must read before implementation.\n`;
}

function testingSpecTemplate(): string {
  return `# Testing Spec\n\nKeep this file short. Add project-specific testing commands, critical paths, and evidence requirements.\n`;
}

function agentSpecTemplate(): string {
  return `# Agent Spec\n\nKeep this file short. Add project-specific AI workflow expectations, review rules, and known pitfalls.\n`;
}

function hookShimTemplate(): string {
  return `#!/usr/bin/env node\nconst { spawnSync } = require("node:child_process");\nconst result = spawnSync("npx", ["mewoflow", "hook", ...process.argv.slice(2)], { stdio: "inherit", shell: true });\nprocess.exit(result.status ?? 1);\n`;
}

function doctorSkillTemplate(): string {
  return `---\ndescription: Run MewoFlow doctor with a forced search-backed health check. Use when the user asks to check whether MewoFlow hooks, workflow files, and search evidence are working.\ndisable-model-invocation: true\n---\n\n# MewoFlow Doctor\n\nRun this skill when the user invokes \`/mewoflow-doctor\` or asks to check whether MewoFlow is working.\n\n## Required flow\n\n1. Use Claude Code WebSearch first. Search for current Claude Code hooks or custom skills documentation so the session records search evidence.\n2. Run:\n\n\`\`\`bash\nmewoflow doctor --require-search\n\`\`\`\n\n3. Report PASS/WARN/FAIL items exactly.\n4. If the doctor fails, explain the smallest next fix. Do not claim MewoFlow is healthy unless the command exits successfully.\n`;
}

function mewoflowHooks(): Record<string, ClaudeHookGroup[]> {
  const command = 'node ".mewoflow/runtime/mewoflow-hook.cjs"';
  return {
    UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: `${command} user-prompt-submit` }] }],
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${command} pre-tool-use` }] }],
    PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${command} post-tool-use` }] }],
    Stop: [{ matcher: "*", hooks: [{ type: "command", command: `${command} stop` }] }],
  };
}
