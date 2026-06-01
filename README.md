<p align="center">
  <h1 align="center">MewoFlow</h1>
</p>

<p align="center">
  <strong>让 Claude Code 按证据驱动的开发流程工作。</strong><br/>
  <sub>一个本地优先的 Claude Code workflow gate：强制 research、grill、plan、implement、verify、archive，不靠模型自觉。</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mewoflow"><img src="https://img.shields.io/npm/v/mewoflow.svg?style=flat-square&color=2563eb" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/mewoflow"><img src="https://img.shields.io/npm/dw/mewoflow?style=flat-square&color=cb3837&label=downloads" alt="npm downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-16a34a.svg?style=flat-square" alt="license" /></a>
  <img src="https://img.shields.io/badge/client-Claude%20Code-111111?style=flat-square" alt="Claude Code" />
</p>

## Why MewoFlow?

很多 AI 编码流程靠 `CLAUDE.md`、skills 或提示词约束模型，但这些规则会被上下文压缩冲淡，也可能被模型忽略。MewoFlow 把关键流程放到 Claude Code hooks 和本地状态文件里，让“必须搜索、必须澄清、必须计划、必须验证”变成可以检查的门禁。

| Capability | What it changes |
| --- | --- |
| **Claude Code hooks** | 在用户提交需求、工具调用前后、会话结束时检查当前任务状态。 |
| **Task-centered workflow** | 每个任务都有独立目录，保存 research、grill、plan、verify、archive 证据。 |
| **Search gate** | 研究阶段要求使用 Claude Code 自带 WebSearch、WebFetch、MCP 搜索，或记录用户提供来源。 |
| **Implementation gate** | 未到 `implement` 阶段前阻止代码修改；实现前要求重新读取关键上下文。 |
| **Verification gate** | 没有命令输出、关键链路证据和 review 记录，就不能声称完成。 |
| **Agent memory files** | 生成 `AGENTS.md` 和 `CLAUDE.md`，用软引导配合 hooks 硬门禁。 |

MewoFlow 只解决一个具体问题：让 Claude Code 在本地开发任务中按证据驱动的流程工作。它不做云端同步、账号系统、团队权限，也不管理任何搜索 API Key。

## Prerequisites

- Node.js >= 18
- npm
- Claude Code

## Installation

推荐直接用 `npx` 在目标项目里初始化，不需要提前安装：

```bash
npx mewoflow init
```

如果你想把 `mewoflow` 命令安装到全局环境，使用 `-g`：

```bash
npm install -g mewoflow
mewoflow init
```

`-g` 表示 global，全局安装。`@` 不是全局安装参数，它只用于 scoped package 名称，例如 `@scope/package`。MewoFlow 当前包名是 `mewoflow`，所以不需要写 `@`。

也可以把它安装到当前项目里：

```bash
npm install --save-dev mewoflow
npx mewoflow init
```

## Quick Start

在 Claude Code 项目根目录执行：

```bash
npx mewoflow init
```

初始化本身只会写入配置、hooks 和本地流程文件，不会创建任务。只有明确的开发请求才会进入 workflow。

初始化后，先在 Claude Code 里运行：

```txt
/mewoflow
```

它会检查本地 wiring、必要时重新初始化，并确认 hooks 与 skill 是否处于可工作状态。

然后向 Claude Code 提出一个需要完整流程的开发任务，例如：

```txt
修复登录 bug
```

MewoFlow 会创建任务目录，并要求 AI 按顺序推进：

```txt
research -> grill -> plan -> implement -> verify -> archive
```

当 hooks 正常触发时，Claude Code transcript 里会出现类似 `猫咪正在监控你的需求喵！`、`猫咪正在检查工具调用喵！` 的提示。没有看到提示时，先运行 `/mewoflow` 或 `mewoflow doctor` 检查 `.claude/settings.json` 的 hook wiring。

在 `research`、`grill`、`plan` 通过前，MewoFlow 会阻止脚手架、安装依赖和实现文件编辑。比如 `pnpm create next-app@latest .`、`npm install`、`pnpm add` 会被要求先完成 `research -> grill -> plan`，避免 AI 询问完需求后直接创建项目。

常用命令：

```bash
mewoflow status
mewoflow check research
mewoflow check grill
mewoflow check plan
mewoflow check implement
mewoflow check verify
mewoflow check archive
```

异常情况下可以显式跳过当前 gate，但必须写明原因：

```bash
mewoflow override <gate> --reason "说明为什么无法正常完成这个 gate"
```

## How It Works

`mewoflow init` 会生成本地流程文件，并把 hook 接入 Claude Code：

```txt
AGENTS.md
CLAUDE.md

.mewoflow/
  rules.md
  workflow.md
  journal.md
  specs/
    coding.md
    testing.md
    agent.md
  tasks/
    <date>-<task-name>/
      task.json
      research.md
      grill.md
      plan.md
      verify.md
      archive.md
  runtime/
    mewoflow-hook.cjs
    sessions/

.claude/
  settings.json
  skills/
    mewoflow/
      SKILL.md
    mewoflow-doctor/
      SKILL.md
```

Hook 职责：

| Hook | Purpose |
| --- | --- |
| `UserPromptSubmit` | 判断请求类型，创建任务，注入当前 gate，并输出猫咪监控提示。 |
| `PreToolUse` | 阻止过早改代码、脚手架和安装依赖，保护状态文件，允许写入当前任务证据。 |
| `PostToolUse` | 记录文件读取、搜索工具调用和命令执行，并输出记录提示。 |
| `Stop` | 任务未完成时阻止 AI 直接结束，并提醒继续当前 gate。 |

如果当前没有 active task，`PreToolUse` 也会阻止高风险脚手架或依赖命令，提示先用 `/mewoflow` 建立或恢复任务。普通小改动不会因此被强制拉入完整 workflow。

## Troubleshooting

### 看不到猫咪 hook 提示

1. 在 Claude Code 里运行 `/mewoflow`，让 skill 检查或重建本地 wiring。
2. 运行 `mewoflow doctor`，确认 `.claude/settings.json` 包含 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 四个 hook。
3. 如果 doctor 报 hook 缺失，重新执行 `npx mewoflow init`。

### Claude 询问后仍想直接创建项目

这通常表示 active task 没有建立，或当前 gate 还停在 `research` / `grill` / `plan`。MewoFlow 会在工具调用前拦截脚手架和依赖命令，并提示先完成：

```txt
research -> grill -> plan
```

继续方式是先补齐 `.mewoflow/tasks/<task>/research.md`、`grill.md`、`plan.md`，分别运行 `mewoflow check research`、`mewoflow check grill`、`mewoflow check plan`，进入 `implement` 后再创建项目或改代码。

## Workflow Gates

| Gate | Purpose | Evidence |
| --- | --- | --- |
| `research` | 获取最新资料和上下文 | 来源、事实、对任务的影响 |
| `grill` | 追问关键需求 | 问题、推荐答案、用户答案、决策、验收标准 |
| `plan` | 写实现计划 | 目标、范围、非目标、步骤、验证方式 |
| `implement` | 允许修改代码 | 已读取规则和任务上下文 |
| `verify` | 用证据证明结果 | 命令输出、关键链路证据、review 记录 |
| `archive` | 归档任务 | 总结、验证结果、后续事项 |

## Doctor

Claude Code 里的主入口：

```txt
/mewoflow
```

它的职责是：

- 检查 MewoFlow 是否已初始化
- 必要时重新运行 `init`
- 检查 hooks 和 skill wiring
- 告诉你当前是继续已有任务，还是等待新的开发请求

检查本地配置：

```bash
mewoflow doctor
```

检查 Claude Code 搜索链路是否被 hook 记录：

```bash
mewoflow doctor --require-search
```

初始化后也会生成 Claude Code skill：

```txt
/mewoflow
/mewoflow-doctor
```

`/mewoflow` 用来开始或恢复 MewoFlow，`/mewoflow-doctor` 会要求 Claude Code 先使用自带搜索，再运行 `npx mewoflow doctor --require-search`。

## AGENTS.md and CLAUDE.md

MewoFlow 会生成两个项目说明入口：

- `AGENTS.md`：跨 Agent 通用说明。
- `CLAUDE.md`：Claude Code 项目记忆入口，默认导入 `@AGENTS.md`。

它们是软引导，用来告诉 AI 项目采用 MewoFlow。真正阻止跳步骤的是 hooks 和 `mewoflow check`。

## How is this different from Trellis?

MewoFlow 参考了 Trellis 的文件化上下文、任务证据、hooks/commands/skills 思想，但目标更窄：

| Trellis | MewoFlow |
| --- | --- |
| 面向多 AI 编程工具和团队工作流 | 只先支持 Claude Code |
| 提供 spec、workspace、tasks、skills、sub-agents、commands、hooks 等完整体系 | 只做本地开发流程门禁 |
| 可演进为跨平台协作层 | 专注强制 research -> grill -> plan -> implement -> verify -> archive |
| 平台能力更完整 | 不做云同步、账号、团队权限、搜索 API Key 管理 |

## CLI Reference

| Command | Description |
| --- | --- |
| `mewoflow init` | 初始化 MewoFlow 文件和 Claude Code hooks。 |
| `mewoflow status` | 查看当前任务和 gate。 |
| `mewoflow doctor` | 检查本地文件、hook 配置、doctor skill 和任务状态。 |
| `mewoflow doctor --require-search` | 要求当前 session 已记录搜索工具调用。 |
| `mewoflow check <gate>` | 校验当前 gate 证据并进入下一阶段。 |
| `mewoflow override <gate> --reason "..."` | 异常情况下跳过当前 gate。 |
| `mewoflow hook <event>` | Claude Code hook 内部调用。 |

## Development

```bash
npm install
npm run verify
```

发布包预览：

```bash
npm run pack:dry
```

## License

MIT License. See [LICENSE](./LICENSE).
