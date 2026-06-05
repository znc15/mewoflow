import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists, readTextIfExists } from "./fs.js";
import type { ImplementationDomain, SessionState, Task } from "./task.js";

export type DomainPathConfig = {
  pathPatterns?: string[];
  pathKeywords?: string[];
  pathExtensions?: string[];
  skillKeywords?: string[];
};

export type DomainSkillsConfig = {
  frontend?: DomainPathConfig;
  backend?: DomainPathConfig;
  excludeSkills?: string[];
};

export type DiscoveredSkill = {
  name: string;
  relativePath: string;
  description: string;
  source: "project" | "user";
};

const DEFAULT_WORKFLOW_SKILLS = ["mewoflow", "mewoflow-doctor", "grill-me"];

const DEFAULT_FRONTEND_SKILL_KEYWORDS = [
  "frontend",
  "front-end",
  "front end",
  "ui",
  "ux",
  "react",
  "vue",
  "svelte",
  "angular",
  "next",
  "nextjs",
  "css",
  "tailwind",
  "styled",
  "component",
  "design",
  "html",
  "webpack",
  "vite",
  "client",
  "browser",
  "shadcn",
  "layout",
  "widget",
];

const DEFAULT_BACKEND_SKILL_KEYWORDS = [
  "backend",
  "back-end",
  "back end",
  "api",
  "server",
  "nodejs",
  "node",
  "express",
  "fastify",
  "go",
  "golang",
  "php",
  "laravel",
  "symfony",
  "django",
  "flask",
  "database",
  "postgres",
  "mysql",
  "redis",
  "graphql",
  "rest",
  "microservice",
  "auth",
  "middleware",
  "route",
  "controller",
  "service",
  "repository",
  "migration",
];

const DEFAULT_FRONTEND_PATH_KEYWORDS = [
  "components",
  "component",
  "pages",
  "page",
  "views",
  "view",
  "ui",
  "frontend",
  "front-end",
  "client",
  "styles",
  "style",
  "css",
  "scss",
  "sass",
  "assets",
  "public",
  "layouts",
  "layout",
  "widgets",
  "widget",
  "hooks",
  "stories",
];

const DEFAULT_FRONTEND_PATH_EXTENSIONS = [".tsx", ".jsx", ".vue", ".svelte", ".css", ".scss", ".sass", ".less", ".html", ".htm"];

const DEFAULT_BACKEND_PATH_KEYWORDS = [
  "api",
  "server",
  "backend",
  "back-end",
  "routes",
  "route",
  "controllers",
  "controller",
  "services",
  "service",
  "middleware",
  "models",
  "model",
  "repository",
  "repositories",
  "db",
  "database",
  "migrations",
  "migration",
  "handlers",
  "handler",
  "workers",
  "worker",
  "jobs",
  "job",
];

const SCRIPT_PATH_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".mts", ".cts"]);

const DEFAULT_BACKEND_PATH_EXTENSIONS = [
  ".ts",
  ".js",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".go",
  ".php",
  ".py",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".sql",
];

const SKILL_READ_PATH_RE = /(?:^|\/)\.claude\/skills\/([^/]+)\/SKILL\.md$/i;

export async function loadDomainSkillsConfig(root: string): Promise<DomainSkillsConfig> {
  const file = path.join(root, ".mewoflow", "domain-skills.json");
  if (!(await pathExists(file))) return defaultDomainSkillsConfig();

  try {
    const raw = await readTextIfExists(file);
    if (!raw) return defaultDomainSkillsConfig();
    const parsed = JSON.parse(raw) as Partial<DomainSkillsConfig>;
    return mergeDomainSkillsConfig(defaultDomainSkillsConfig(), parsed);
  } catch {
    return defaultDomainSkillsConfig();
  }
}

export function defaultDomainSkillsConfig(): DomainSkillsConfig {
  return {
    frontend: {
      pathKeywords: DEFAULT_FRONTEND_PATH_KEYWORDS,
      pathExtensions: DEFAULT_FRONTEND_PATH_EXTENSIONS,
      skillKeywords: DEFAULT_FRONTEND_SKILL_KEYWORDS,
    },
    backend: {
      pathKeywords: DEFAULT_BACKEND_PATH_KEYWORDS,
      pathExtensions: DEFAULT_BACKEND_PATH_EXTENSIONS,
      skillKeywords: DEFAULT_BACKEND_SKILL_KEYWORDS,
    },
    excludeSkills: DEFAULT_WORKFLOW_SKILLS,
  };
}

export async function discoverLocalSkills(root: string): Promise<DiscoveredSkill[]> {
  const discovered: DiscoveredSkill[] = [];
  const seen = new Set<string>();

  const projectSkillsRoot = path.join(root, ".claude", "skills");
  await collectSkillsFromRoot(projectSkillsRoot, "project", ".claude/skills", discovered, seen);

  const userSkillsRoot = path.join(os.homedir(), ".claude", "skills");
  await collectSkillsFromRoot(userSkillsRoot, "user", ".claude/skills", discovered, seen);

  return discovered.sort((left, right) => left.name.localeCompare(right.name));
}

export function classifyImplementationTargetWithConfig(target: string, config: DomainSkillsConfig): ImplementationDomain | null {
  const normalized = target.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (!normalized || normalized === ".") return null;

  const frontendScore = pathDomainScore(normalized, config.frontend ?? defaultDomainSkillsConfig().frontend!);
  const backendScore = pathDomainScore(normalized, config.backend ?? defaultDomainSkillsConfig().backend!);

  if (frontendScore === 0 && backendScore === 0) return null;
  if (frontendScore === backendScore) {
    if (frontendScore === 0) return null;
    return preferAmbiguousDomain(normalized);
  }
  return frontendScore > backendScore ? "frontend" : "backend";
}

export function domainSkillsForLocalNames(
  domain: ImplementationDomain,
  localSkillNames: string[],
  config: DomainSkillsConfig,
): string[] {
  const skills = localSkillNames.map((name) => ({
    name,
    relativePath: `.claude/skills/${name}`,
    description: "",
    source: "project" as const,
  }));
  return relevantSkillsForDomain(domain, skills, config).map((skill) => skill.name);
}

export function relevantSkillsForDomain(
  domain: ImplementationDomain,
  skills: DiscoveredSkill[],
  config: DomainSkillsConfig,
): DiscoveredSkill[] {
  const merged = mergeDomainSkillsConfig(defaultDomainSkillsConfig(), config);
  const excluded = new Set((merged.excludeSkills ?? DEFAULT_WORKFLOW_SKILLS).map(normalizeToken));
  const domainKeywords = skillKeywordsForDomain(merged, domain);
  const otherDomain: ImplementationDomain = domain === "frontend" ? "backend" : "frontend";
  const otherDomainKeywords = skillKeywordsForDomain(merged, otherDomain);

  return skills.filter((skill) => {
    if (excluded.has(normalizeToken(skill.name))) return false;
    if (skillMatchesKeywords(skill, domainKeywords)) return true;
    if (skillMatchesKeywords(skill, otherDomainKeywords)) return false;
    return skill.source === "project" && isProjectRelatedSkill(skill, excluded);
  });
}

export function hasDomainSkillEvidence(
  session: SessionState,
  task: Task,
  domain: ImplementationDomain,
  localSkillNames: string[],
  config: DomainSkillsConfig,
): boolean {
  const candidates = new Set(
    domainSkillsForLocalNames(domain, localSkillNames, config).map((name) => normalizeToken(name)),
  );
  if (candidates.size === 0) return true;

  const usedSkills = session.skillUses.filter(
    (entry) => entry.gate === "implement" && (!entry.taskId || entry.taskId === task.id),
  );
  if (usedSkills.some((entry) => candidates.has(normalizeToken(entry.skill)))) return true;

  return false;
}

export function hasDomainSkillEvidenceForSkills(
  session: SessionState,
  task: Task,
  candidates: DiscoveredSkill[],
): boolean {
  const candidateNames = new Set(candidates.map((skill) => normalizeToken(skill.name)));
  if (candidateNames.size === 0) return true;

  const usedSkills = session.skillUses.filter(
    (entry) => entry.gate === "implement" && (!entry.taskId || entry.taskId === task.id),
  );
  if (usedSkills.some((entry) => candidateNames.has(normalizeToken(entry.skill)))) return true;

  return false;
}

export function missingDomainSkillMessage(
  domain: ImplementationDomain,
  writeTarget: string,
  candidates: string[] | DiscoveredSkill[],
): string {
  const names = candidates.map((candidate) => (typeof candidate === "string" ? candidate : candidate.name));
  const example = names[0] ? `.claude/skills/${names[0]}/SKILL.md` : ".claude/skills/<skill-name>/SKILL.md";
  const discoveredList = names.length > 0 ? names.join(", ") : "(none found yet)";

  return [
    `${domain} implementation edit blocked for ${writeTarget}.`,
    "Model domain judgment required: explicitly decide frontend/backend/none for this write target and record the reason in active task evidence or implementation notes before editing.",
    "Before editing, discover relevant local skills instead of assuming fixed built-in names.",
    "List `.claude/skills/` in this project and check `~/.claude/skills/` for global skills.",
    `Relevant ${domain} skills discovered: ${discoveredList}.`,
    `Read at least one matching SKILL.md (for example ${example}) or invoke the Skill tool for one of those skills.`,
    "Workflow-only skills (mewoflow, mewoflow-doctor, grill-me) do not satisfy this gate.",
  ].join(" ");
}

export function implementDomainSkillWarnings(
  session: SessionState,
  task: Task,
  localSkills: DiscoveredSkill[],
  config: DomainSkillsConfig,
): string[] {
  const warnings: string[] = [];
  const domains: ImplementationDomain[] = ["frontend", "backend"];

  for (const domain of domains) {
    if (!session.implementationDomains?.[domain]) continue;

    const candidates = relevantSkillsForDomain(domain, localSkills, config);
    if (candidates.length === 0) continue;
    if (hasDomainSkillEvidenceForSkills(session, task, candidates)) continue;

    const examples = candidates.slice(0, 3).map((skill) => skill.name).join(", ");
    warnings.push(
      `${domain} implementation edits were recorded without a traced read/invocation of a relevant local skill; also record the Model domain judgment (frontend/backend/none) with reason; discover skills under .claude/skills/ and read one such as ${examples} before more ${domain} edits`,
    );
  }

  return warnings;
}

export function skillNameFromSkillReadPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const match = SKILL_READ_PATH_RE.exec(normalized);
  return match?.[1] ?? null;
}

export function writeTargetsForPreToolUse(tool: string, target: string, command: string): string[] {
  const targets = new Set<string>();
  const normalizedTarget = target.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalizedTarget) targets.add(normalizedTarget);

  if (tool === "Bash" && command) {
    for (const extracted of extractWriteTargetsFromCommand(command)) {
      targets.add(extracted);
    }
  }

  return [...targets];
}

function mergeDomainSkillsConfig(base: DomainSkillsConfig, override: Partial<DomainSkillsConfig>): DomainSkillsConfig {
  return {
    frontend: mergePathConfig(base.frontend, override.frontend),
    backend: mergePathConfig(base.backend, override.backend),
    excludeSkills: override.excludeSkills ?? base.excludeSkills,
  };
}

function mergePathConfig(base: DomainPathConfig | undefined, override: DomainPathConfig | undefined): DomainPathConfig {
  return {
    pathPatterns: override?.pathPatterns ?? base?.pathPatterns,
    pathKeywords: override?.pathKeywords ?? base?.pathKeywords,
    pathExtensions: override?.pathExtensions ?? base?.pathExtensions,
    skillKeywords: override?.skillKeywords ?? base?.skillKeywords,
  };
}

function skillKeywordsForDomain(config: DomainSkillsConfig, domain: ImplementationDomain): string[] {
  const configured = stringList(config[domain]?.skillKeywords);
  return configured.length > 0 ? configured : defaultDomainSkillsConfig()[domain]!.skillKeywords!;
}

async function collectSkillsFromRoot(
  skillsRoot: string,
  source: DiscoveredSkill["source"],
  relativePrefix: string,
  discovered: DiscoveredSkill[],
  seen: Set<string>,
): Promise<void> {
  if (!(await pathExists(skillsRoot))) return;

  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const key = normalizeToken(entry.name);
    if (seen.has(key)) continue;

    const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
    if (!(await pathExists(skillFile))) continue;

    const text = (await readTextIfExists(skillFile)) ?? "";
    discovered.push({
      name: entry.name,
      relativePath: `${relativePrefix}/${entry.name}`,
      description: parseSkillDescription(text),
      source,
    });
    seen.add(key);
  }
}

function parseSkillDescription(text: string): string {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!frontmatter) return "";

  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = /^\s*description\s*:\s*(.+?)\s*$/i.exec(line);
    if (match) return match[1].replace(/^['"]|['"]$/g, "").trim();
  }
  return "";
}

function pathDomainScore(target: string, config: DomainPathConfig): number {
  let score = 0;
  const extension = path.posix.extname(target);
  const pathExtensions = stringList(config.pathExtensions).map((value) => value.toLowerCase());

  if (pathExtensions.some((value) => extension === value)) score += SCRIPT_PATH_EXTENSIONS.has(extension) ? 1 : 3;
  if (stringList(config.pathKeywords).some((keyword) => containsPathToken(target, keyword))) score += 2;
  if (stringList(config.pathPatterns).some((pattern) => safePatternMatches(pattern, target))) score += 4;
  return score;
}

function safePatternMatches(pattern: string, target: string): boolean {
  try {
    return new RegExp(pattern, "i").test(target);
  } catch {
    return false;
  }
}

function preferAmbiguousDomain(target: string): ImplementationDomain {
  const backendHints = ["server", "api", "backend", "route", "controller", "service", "middleware", "migration", "repository"];
  if (backendHints.some((hint) => containsPathToken(target, hint))) return "backend";
  const frontendHints = ["component", "components", "page", "pages", "ui", "frontend", "client", "styles", "layout"];
  if (frontendHints.some((hint) => containsPathToken(target, hint))) return "frontend";
  return target.endsWith(".ts") || target.endsWith(".js") || target.endsWith(".mjs") ? "backend" : "frontend";
}

function containsPathToken(target: string, keyword: string): boolean {
  const normalizedKeyword = keyword.toLowerCase();
  const segments = target.split("/");
  const directorySegments = path.posix.extname(segments.at(-1) ?? "") ? segments.slice(0, -1) : segments;
  return directorySegments.some((segment) => segment === normalizedKeyword || segment.includes(normalizedKeyword));
}

function isProjectRelatedSkill(skill: DiscoveredSkill, excluded: Set<string>): boolean {
  return !excluded.has(normalizeToken(skill.name));
}

function skillMatchesKeywords(skill: DiscoveredSkill, keywords: string[]): boolean {
  const haystack = [skill.name, skill.relativePath, skill.description].join(" ").toLowerCase();
  return stringList(keywords).some((keyword) => haystack.includes(keyword.toLowerCase()));
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function extractWriteTargetsFromCommand(command: string): string[] {
  const targets = new Set<string>();
  const normalized = command.replace(/\\/g, "/");

  for (const match of normalized.matchAll(/(?:^|\s)(?:\d{0,2})>>?\s+(?!&)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
    addTarget(targets, match[1] ?? match[2] ?? match[3] ?? "");
  }

  const tokens = shellTokens(normalized);
  for (const segment of commandSegments(tokens)) {
    for (const target of writeTargetsFromCommandSegment(segment)) {
      addTarget(targets, target);
    }
  }

  return [...targets];
}

function looksLikeFilePath(candidate: string): boolean {
  return /\.[a-z0-9]{1,8}$/i.test(candidate) || candidate.includes("/");
}

function addTarget(targets: Set<string>, raw: string): void {
  const candidate = normalizeCommandPath(raw);
  if (candidate && looksLikeFilePath(candidate)) targets.add(candidate);
}

function normalizeCommandPath(raw: string): string {
  return raw
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^\.\//, "")
    .replace(/[),]+$/g, "");
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  const pushCurrent = () => {
    if (current) tokens.push(current);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    const next = command[index + 1] ?? "";
    if ((char === "&" && next === "&") || (char === "|" && next === "|") || (char === ">" && next === ">")) {
      pushCurrent();
      tokens.push(`${char}${next}`);
      index += 1;
      continue;
    }

    if (char === ";" || char === "|" || char === ">") {
      pushCurrent();
      tokens.push(char);
      continue;
    }

    current += char;
  }

  pushCurrent();
  return tokens;
}

function commandSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token === "&&" || token === "||" || token === ";" || token === "|") {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function writeTargetsFromCommandSegment(tokens: string[]): string[] {
  const command = commandName(tokens[0] ?? "");
  if (!command) return [];

  if (command === "touch" || command === "mkdir") return pathArguments(tokens.slice(1));
  if (command === "tee") return pathArguments(tokens.slice(1));
  if (command === "rm" || command === "del" || command === "erase" || command === "remove-item") return pathArguments(tokens.slice(1));
  if (command === "cp" || command === "copy" || command === "copy-item" || command === "mv" || command === "move" || command === "move-item" || command === "ren" || command === "rename" || command === "rename-item") {
    const optionTargets = optionPathTargets(tokens);
    const positional = pathArguments(tokens.slice(1));
    return [...optionTargets, ...(positional.at(-1) ? [positional.at(-1)!] : [])];
  }
  if (command === "set-content" || command === "add-content" || command === "clear-content" || command === "out-file" || command === "new-item" || command === "ni") {
    const optionTargets = optionPathTargets(tokens);
    const firstPositional = firstPositionalPath(tokens.slice(1));
    return firstPositional ? [...optionTargets, firstPositional] : optionTargets;
  }

  return [];
}

function commandName(raw: string): string {
  const base = raw.split("/").at(-1) ?? raw;
  return base.toLowerCase();
}

function optionPathTargets(tokens: string[]): string[] {
  const targets: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const inline = /^-(?:path|literalpath|filepath|destination|destinationpath)[:=](.+)$/i.exec(token);
    if (inline?.[1]) targets.push(inline[1]);
    if (/^-(?:path|literalpath|filepath|destination|destinationpath)$/i.test(token) && tokens[index + 1]) {
      targets.push(tokens[index + 1]!);
      index += 1;
    }
  }
  return targets;
}

function firstPositionalPath(tokens: string[]): string | null {
  const paths = pathArguments(tokens);
  return paths[0] ?? null;
}

function pathArguments(tokens: string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === ">" || token === ">>") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      if (optionConsumesValue(token) && tokens[index + 1]) index += 1;
      continue;
    }
    const candidate = normalizeCommandPath(token);
    if (looksLikeFilePath(candidate)) paths.push(candidate);
  }
  return paths;
}

function optionConsumesValue(option: string): boolean {
  return /^-(?:path|literalpath|filepath|destination|destinationpath|value|itemtype|type|encoding)$/i.test(option);
}
