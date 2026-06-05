import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyImplementationTargetWithConfig,
  defaultDomainSkillsConfig,
  discoverLocalSkills,
  hasDomainSkillEvidenceForSkills,
  missingDomainSkillMessage,
  relevantSkillsForDomain,
  skillNameFromSkillReadPath,
  writeTargetsForPreToolUse,
} from "../src/domain-skills.js";
import { writeFileEnsured } from "../src/fs.js";
import type { SessionState, Task } from "../src/task.js";

async function seedSkills(root: string): Promise<void> {
  await writeFileEnsured(
    path.join(root, ".claude", "skills", "react-ui", "SKILL.md"),
    "---\ndescription: React UI component development\n---\n",
  );
  await writeFileEnsured(
    path.join(root, ".claude", "skills", "api-server", "SKILL.md"),
    "---\ndescription: API server and backend routes\n---\n",
  );
  await writeFileEnsured(
    path.join(root, ".claude", "skills", "project-conventions", "SKILL.md"),
    "---\ndescription: Project-specific coding conventions\n---\n",
  );
  await writeFileEnsured(path.join(root, ".claude", "skills", "mewoflow", "SKILL.md"), "---\ndescription: workflow\n---\n");
  await writeFileEnsured(path.join(root, ".claude", "skills", "grill-me", "SKILL.md"), "---\ndescription: grill workflow\n---\n");
}

function emptySession(): SessionState {
  return {
    planApprovals: {},
    archiveApprovals: {},
    specDecisions: {},
    readFiles: [],
    searchTools: [],
    skillUses: [],
    commands: [],
    implementationDomains: {},
  };
}

function implementTask(): Task {
  return {
    id: "2026-06-05-login-bug",
    title: "Login bug",
    type: "standard",
    taskRole: "standard",
    childTaskIds: [],
    gate: "implement",
    reviewed: false,
    created_at: "2026-06-05T00:00:00.000Z",
    updated_at: "2026-06-05T00:00:00.000Z",
    overrides: [],
    reworks: [],
    deferredRiskApprovals: [],
  };
}

describe("domain-skills", () => {
  it("discovers project-local skills and excludes workflow-only names from relevance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-domain-"));
    await seedSkills(root);

    const skills = await discoverLocalSkills(root);
    const projectSkills = skills.filter((skill) => skill.source === "project");
    expect(projectSkills.map((skill) => skill.name).sort()).toEqual([
      "api-server",
      "grill-me",
      "mewoflow",
      "project-conventions",
      "react-ui",
    ]);

    const config = defaultDomainSkillsConfig();
    const frontend = relevantSkillsForDomain("frontend", projectSkills, config).map((skill) => skill.name);
    const backend = relevantSkillsForDomain("backend", projectSkills, config).map((skill) => skill.name);

    expect(frontend).toContain("react-ui");
    expect(frontend).toContain("project-conventions");
    expect(frontend).not.toContain("mewoflow");
    expect(frontend).not.toContain("grill-me");

    expect(backend).toContain("api-server");
    expect(backend).toContain("project-conventions");
    expect(backend).not.toContain("mewoflow");
    expect(backend).not.toContain("react-ui");
  });

  it("classifies frontend and backend write targets from path heuristics", () => {
    const config = defaultDomainSkillsConfig();

    expect(classifyImplementationTargetWithConfig("src/components/Button.tsx", config)).toBe("frontend");
    expect(classifyImplementationTargetWithConfig("src/server/routes/auth.ts", config)).toBe("backend");
    expect(classifyImplementationTargetWithConfig("src/auth.ts", config)).toBe("backend");
    expect(classifyImplementationTargetWithConfig("src/hooks.ts", config)).toBe("backend");
    expect(classifyImplementationTargetWithConfig("README.md", config)).toBeNull();
  });

  it("ignores invalid custom path pattern regexes during classification", () => {
    expect(
      classifyImplementationTargetWithConfig("src/components/Button.tsx", {
        frontend: { pathPatterns: ["["], pathKeywords: ["components"] },
        backend: { pathPatterns: ["("], pathKeywords: ["server"] },
      }),
    ).toBe("frontend");
  });

  it("extracts write targets from bash redirection commands", () => {
    const targets = writeTargetsForPreToolUse("Bash", "", 'echo "ok" > README.md && echo "x" > src/server/routes/auth.ts');
    expect(targets).toContain("README.md");
    expect(targets).toContain("src/server/routes/auth.ts");
  });

  it("extracts write targets from common shell and PowerShell write commands", () => {
    expect(writeTargetsForPreToolUse("Bash", "", "touch src/components/Button.tsx")).toContain("src/components/Button.tsx");
    expect(writeTargetsForPreToolUse("Bash", "", "echo ok | tee src/server/routes/auth.ts")).toContain("src/server/routes/auth.ts");
    expect(writeTargetsForPreToolUse("Bash", "", "cp template.tsx src/components/Button.tsx")).toContain("src/components/Button.tsx");
    expect(writeTargetsForPreToolUse("Bash", "", "mv tmp.ts src/server/routes/auth.ts")).toContain("src/server/routes/auth.ts");
    expect(writeTargetsForPreToolUse("Bash", "", "Set-Content src/server/routes/auth.ts ok")).toContain("src/server/routes/auth.ts");
    expect(writeTargetsForPreToolUse("Bash", "", "Out-File -FilePath src/components/Button.tsx")).toContain("src/components/Button.tsx");
    expect(writeTargetsForPreToolUse("Bash", "", "New-Item -Path src/components/Button.tsx")).toContain("src/components/Button.tsx");
  });

  it("detects skill evidence only from current implement gate skill usage", () => {
    const task = implementTask();
    const skills = [
      { name: "react-ui", relativePath: ".claude/skills/react-ui", description: "react ui", source: "project" as const },
    ];

    const withoutEvidence = hasDomainSkillEvidenceForSkills(emptySession(), task, skills);
    expect(withoutEvidence).toBe(false);

    const withRead: SessionState = {
      ...emptySession(),
      readFiles: [".claude/skills/react-ui/SKILL.md"],
    };
    expect(hasDomainSkillEvidenceForSkills(withRead, task, skills)).toBe(false);

    const wrongGateUse: SessionState = {
      ...emptySession(),
      skillUses: [{ skill: "react-ui", at: "2026-06-05T00:00:00.000Z", gate: "plan", taskId: task.id }],
    };
    expect(hasDomainSkillEvidenceForSkills(wrongGateUse, task, skills)).toBe(false);

    const otherTaskUse: SessionState = {
      ...emptySession(),
      skillUses: [{ skill: "react-ui", at: "2026-06-05T00:00:00.000Z", gate: "implement", taskId: "other-task" }],
    };
    expect(hasDomainSkillEvidenceForSkills(otherTaskUse, task, skills)).toBe(false);

    const withSkillUse: SessionState = {
      ...emptySession(),
      skillUses: [{ skill: "react-ui", at: "2026-06-05T00:00:00.000Z", gate: "implement", taskId: task.id }],
    };
    expect(hasDomainSkillEvidenceForSkills(withSkillUse, task, skills)).toBe(true);
  });

  it("builds discovery-oriented deny messages without hardcoded skill paths", () => {
    const message = missingDomainSkillMessage("frontend", "src/components/Button.tsx", ["react-ui", "project-conventions"]);

    expect(message).toContain("frontend implementation edit blocked");
    expect(message).toContain("discover relevant local skills");
    expect(message).toContain(".claude/skills/");
    expect(message).toContain("~/.claude/skills/");
    expect(message).toContain("react-ui");
    expect(message).not.toContain("frontend-dev");
  });

  it("parses skill names from SKILL.md read paths", () => {
    expect(skillNameFromSkillReadPath(".claude/skills/react-ui/SKILL.md")).toBe("react-ui");
    expect(skillNameFromSkillReadPath("C:/repo/.claude/skills/api-server/SKILL.md")).toBe("api-server");
    expect(skillNameFromSkillReadPath("src/components/Button.tsx")).toBeNull();
  });
});
