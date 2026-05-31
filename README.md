# MewoFlow

![Status](https://img.shields.io/badge/status-v0.2.1-green)
![Runtime](https://img.shields.io/badge/node-%3E%3D18-339933)
![Client](https://img.shields.io/badge/client-Claude%20Code-111111)
![License](https://img.shields.io/badge/license-MIT-blue)

MewoFlow 是一个面向 Claude Code 的本地开发流程门禁工具。它通过 Claude Code Hooks 和项目内状态文件，把"先研究、再澄清、再计划、再实现、再验证、最后归档"的流程固定下来，减少 AI 跳步骤、忘规则、没验证就声称完成的问题。

> 当前版本：`v0.2.1`。本地优先，仅支持 Claude Code。

---

## 目录

- [项目介绍](#项目介绍)
  - [为什么需要 MewoFlow？](#为什么需要-mewoflow)
  - [核心特性](#核心特性)
  - [工作流](#工作流)
  - [工作原理](#工作原理)
  - [Agent 说明文件](#agent-说明文件)
  - [门禁文件格式](#门禁文件格式)
  - [和 Trellis 的关系与差异](#和-trellis-的关系与差异)
  - [当前限制](#当前限制)
  - [路线图](#路线图)
  - [许可证](#许可证)
- [安装方法](#安装方法)
  - [环境要求](#环境要求)
  - [安装](#安装)
  - [本地开发](#本地开发)
  - [发布预览](#发布预览)
- [使用教程](#使用教程)
  - [快速开始](#快速开始)
  - [一键健康检查](#一键健康检查)
  - [CLI 参考](#cli-参考)
  - [本地文件与版本管理](#本地文件与版本管理)
  - [故障排查](#故障排查)

---

## 项目介绍

### 为什么需要 MewoFlow？

只靠提示词或 skill 很容易失效：上下文压缩后规则可能消失，模型可能直接开始写代码，或者在没有证据的情况下说任务已经完成。MewoFlow 把关键流程放到模型上下文之外，用本地文件和 hook 进行约束。

MewoFlow 的目标不是做一个复杂平台，而是解决一个具体问题：**让 AI 在本地开发任务中按证据驱动的流程工作**。

适合进入完整流程的请求：

- 修复登录 bug。
- 新增支付、音乐系统、agent、API 接入等功能。
- 改动架构、依赖、测试或关键业务链路。

不适合进入完整流程的请求：

- 改一个颜色。
- 修一个 typo。
- 调整单个文案或简单样式。

### 核心特性

- **Claude Code Hooks 接入**：初始化后写入本地 hook 配置。
- **任务自动分类**：区分 `simple`、`standard`、`epic` 请求。
- **研究门禁**：要求使用 Claude Code 自带 WebSearch、WebFetch、MCP 搜索工具，或明确记录用户提供资料。
- **澄清门禁**：记录追问、推荐答案、用户回答、最终决策和验收标准。
- **计划门禁**：实现前必须写清目标、范围、非目标、步骤和验证方式。
- **实现门禁**：未到 `implement` 阶段前阻止代码修改；进入实现前要求重新读取关键上下文。
- **验证门禁**：没有命令输出、关键链路证据和 review 记录，不允许进入完成状态。
- **归档门禁**：按日期和任务名保存任务证据，并把归档摘要追加到本地 journal。
- **一键健康检查**：提供 `mewoflow doctor` 和 Claude Code 命令 `/mewoflow-doctor` 检查 hook、流程文件和搜索证据。
- **Agent 说明入口**：生成 `AGENTS.md` 和 `CLAUDE.md`，用软引导配合 hooks 硬门禁。
- **轻量本地规范**：初始化 `.mewoflow/specs/`，用于放置小而稳定的项目规范，避免上下文压缩后丢失。
- **本地优先**：不做云端同步、不做团队权限、不管理第三方搜索 API Key。

### 工作流

对 `standard` 和 `epic` 任务，MewoFlow 要求完整走完：

```txt
research -> grill -> plan -> implement -> verify -> archive
```

| Gate | 目的 | 通过条件 |
|---|---|---|
| `research` | 先获取最新资料和上下文 | 有来源、有事实、有对任务影响分析 |
| `grill` | 追问关键需求 | 有问题、推荐答案、用户答案、决策和验收标准 |
| `plan` | 写实现计划 | 有目标、范围、非目标、步骤和验证方式 |
| `implement` | 允许修改代码 | 已读取规则和任务上下文 |
| `verify` | 用证据证明结果 | 有命令输出或关键链路证据，并有 review 记录 |
| `archive` | 归档任务 | 有总结、验证结果和后续事项，并追加到 journal |

`override` 只用于异常情况，不应该作为常规流程。

### 工作原理

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
    2026-05-31-task-name/
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
    mewoflow-doctor/
      SKILL.md
```

各 hook 的职责：

| Hook | 作用 |
|---|---|
| `UserPromptSubmit` | 判断请求类型，创建任务，注入当前 gate。 |
| `PreToolUse` | 阻止受保护状态文件被直接修改，阻止过早改代码；允许写入当前任务的证据 Markdown。 |
| `PostToolUse` | 记录文件读取、搜索工具调用和命令执行。 |
| `Stop` | 任务未完成时阻止 AI 直接结束。 |

任务状态保存在 `task.json`，人类可读的证据保存在 Markdown 文件中。AI 应该先写证据文件，再用 CLI 推进 gate。

### Agent 说明文件

`mewoflow init` 会在项目根目录生成两个面向 AI 编程工具的说明文件：

- `AGENTS.md`：跨 Agent 通用说明，描述 MewoFlow 的完整流程、证据要求和常用命令。
- `CLAUDE.md`：Claude Code 项目记忆入口，默认通过 `@AGENTS.md` 引用通用说明。

`CLAUDE.md` 默认内容会以这一行开头：

```md
@AGENTS.md
```

这两个文件的定位是**软引导**：让 Claude Code 和其他可能读取 `AGENTS.md` 的工具更容易知道项目使用 MewoFlow。真正阻止跳步骤、没搜索就计划、没验证就完成的部分仍然由 Claude Code hooks 和 `mewoflow check` 做硬门禁。

### 门禁文件格式

#### `research.md`

```md
# Research

## Search Evidence
- Tool Used: WebSearch / WebFetch / MCP / user-provided-source

## Sources
| Source | Type | Why It Matters |
|---|---|---|

## Current Facts

## Impact On This Task

## Unknowns
```

#### `grill.md`

```md
# Grill

## Q1
Question:
Recommended Answer:
User Answer:
Decision:

## Locked Decisions

## Acceptance Criteria

## Open Questions
- None
```

#### `plan.md`

```md
# Plan

## Goal

## Scope

## Non-goals

## Steps

## Verification
```

#### `verify.md`

```md
# Verify

## Result
- passed

## Commands Run
| Command | Result | Evidence |
|---|---|---|

## Critical Path
| Path | Result | Evidence |
|---|---|---|

## Review
Reviewer:
Result:
Findings:
```

#### `archive.md`

```md
# Archive

## Summary

## Verification

## Follow-ups
```

### 和 Trellis 的关系与差异

MewoFlow 参考了 Trellis 的一些核心思想：用文件承载长期上下文，用任务目录保存过程证据，用 hooks/commands/skills 把 AI 工作流从"软提示"提升为可检查的流程。

但 MewoFlow 不是 Trellis 的复刻，也不追求 v0.2.1 就成为跨平台工作流系统：

| 维度 | Trellis | MewoFlow v0.2.1 |
|---|---|---|
| 支持范围 | 面向多 AI 编程工具和更完整的工作流生态 | 仅支持 Claude Code |
| 目标 | 规格、workspace、tasks、skills、sub-agents、commands、hooks 等完整体系 | 本地开发流程门禁：research -> grill -> plan -> implement -> verify -> archive |
| 规范管理 | 更像可持续演进的 spec/workspace 系统 | 只生成轻量 `.mewoflow/specs/`，由项目按需维护 |
| 搜索 | 可结合平台能力和工作流设计 | 只强制使用 Claude Code 自带 WebSearch/WebFetch/MCP，不管理 API Key |
| 协作 | 可扩展到更复杂的团队/平台能力 | 不做云同步、账号、团队权限 |
| 强制力 | 结合平台能力组织工作流 | 用 Claude Code hooks 做本地硬门禁，优先解决模型不遵守指令的问题 |

因此，MewoFlow 当前更像一个小而硬的本地约束层：把 Trellis 风格的上下文和任务证据思想压缩到 Claude Code 本地项目里，先解决"必须搜索、必须澄清、必须验证、有证据才算完成"。

### 当前限制

- v0.2.1 仅支持 Claude Code。
- 搜索能力由 Claude Code 提供，MewoFlow 不调用外部搜索 API。
- 不包含云端同步、账号系统、团队权限或托管服务。
- 任务分类使用确定性规则，不使用复杂模型判断。
- `override` 只用于异常情况，不是正常流程的一部分。

### 路线图

- 改进任务分类启发式规则。
- 增强 verify 阶段的 review 证据和失败修复循环。
- 让 `.mewoflow/specs/` 的注入更精简，避免上下文过大。
- 后续按需支持更多 AI 编程客户端。

### 许可证

MewoFlow 使用 [MIT License](./LICENSE)。

---

## 安装方法

### 环境要求

- Node.js `>=18`
- npm
- Claude Code

MewoFlow 不提供搜索后端。研究阶段使用 Claude Code 已经可用的 WebSearch、WebFetch 或 MCP 搜索工具。

### 安装

发布后可以在 Claude Code 项目中直接初始化：

```bash
npx mewoflow init
```

本仓库本地开发时可以使用：

```bash
npm install
npm run build
npx mewoflow init
```

如果你正在调试本仓库，也可以直接运行源码 CLI：

```bash
npm run dev -- init
```

### 本地开发

安装依赖：

```bash
npm install
```

运行检查：

```bash
npm run typecheck
npm test
npm run build
```

完整本地验证：

```bash
npm run verify
```

### 发布预览

预览 npm 发布包内容：

```bash
npm run pack:dry
```

当前 `package.json` 使用 `files` 字段限制发布内容，只包含运行 CLI 需要的构建产物、README 和 package 元数据。

---

## 使用教程

### 快速开始

在 Claude Code 项目根目录执行：

```bash
npx mewoflow init
```

然后向 Claude Code 提出一个开发任务，例如：

```txt
修复登录 bug
```

MewoFlow 会创建一个按日期和任务名命名的任务目录，并把当前 gate 注入到 Claude Code 上下文中。AI 需要按顺序推进：

```bash
mewoflow check research
mewoflow check grill
mewoflow check plan
mewoflow check implement
mewoflow check verify
mewoflow check archive
```

查看当前任务状态：

```bash
mewoflow status
```

异常情况下可以显式跳过当前 gate，但必须写明原因：

```bash
mewoflow override <gate> --reason "说明为什么无法正常完成这个 gate"
```

### 一键健康检查

v0.2 起提供本地 doctor：

```bash
mewoflow doctor
```

它会检查：

- Node.js 版本是否满足要求。
- `AGENTS.md` 和 `CLAUDE.md` 是否存在。
- `CLAUDE.md` 是否导入 `@AGENTS.md`。
- `.mewoflow/` 的规则、workflow、runtime、specs、journal 是否存在。
- `.claude/settings.json` 是否配置了 MewoFlow hooks。
- `.claude/skills/mewoflow-doctor/SKILL.md` 是否存在。
- 当前任务是否可读。
- 当前 session 是否记录过 Claude Code 搜索工具调用。

如果要把"联网搜索是否正常"纳入硬性检查，可以运行：

```bash
mewoflow doctor --require-search
```

MewoFlow 本身不会调用外部搜索 API，也不会管理搜索 Key。它只检查 Claude Code hook 记录到的 WebSearch、WebFetch 或 MCP 搜索证据。初始化后会生成 Claude Code skill：

```txt
/mewoflow-doctor
```

该命令会要求 Claude Code 先使用自带 WebSearch 搜索当前 Claude Code hooks/skills 文档，再执行 `mewoflow doctor --require-search`。这正是为了应对部分模型，尤其是中文或本地模型，不稳定遵守提示词和 skill 的情况：搜索行为由 hook 记录，健康检查由 CLI 验证，而不是只相信模型自述。

### CLI 参考

| 命令 | 说明 |
|---|---|
| `mewoflow init` | 初始化 `.mewoflow/` 和 Claude Code hook 配置。 |
| `mewoflow status` | 查看当前任务和 gate。 |
| `mewoflow doctor` | 检查本地文件、hook 配置、doctor skill、当前任务和搜索证据状态。 |
| `mewoflow doctor --require-search` | 要求当前 session 已记录 WebSearch、WebFetch 或 MCP 搜索工具调用。 |
| `mewoflow check research` | 校验研究证据并进入 `grill`。 |
| `mewoflow check grill` | 校验澄清记录并进入 `plan`。 |
| `mewoflow check plan` | 校验计划并进入 `implement`。 |
| `mewoflow check implement` | 结束实现阶段并进入 `verify`。 |
| `mewoflow check verify` | 校验证据并进入 `archive`。 |
| `mewoflow check archive` | 校验归档并进入 `done`。 |
| `mewoflow override <gate> --reason "..."` | 异常情况下跳过当前 gate。 |
| `mewoflow hook <event>` | Claude Code hook 内部调用。 |

`mewoflow hook <event>` 由 Claude Code 配置调用，通常不需要手动执行。`/mewoflow-doctor` 是由 `.claude/skills/mewoflow-doctor/SKILL.md` 提供的 Claude Code 命令，用来先触发搜索再运行 doctor。

### 本地文件与版本管理

建议处理方式：

| 路径 | 用途 | 是否提交 |
|---|---|---|
| `AGENTS.md` | 跨 Agent 通用说明 | 通常提交 |
| `CLAUDE.md` | Claude Code 项目记忆入口，默认导入 `AGENTS.md` | 通常提交 |
| `.mewoflow/rules.md` | 项目流程规则 | 通常提交 |
| `.mewoflow/workflow.md` | gate 说明 | 通常提交 |
| `.mewoflow/specs/` | 轻量项目规范 | 通常提交 |
| `.mewoflow/journal.md` | 已完成任务归档摘要 | 由项目决定 |
| `.mewoflow/tasks/` | 任务证据与归档 | 由项目决定 |
| `.mewoflow/runtime/mewoflow-hook.cjs` | Claude Code hook shim | 使用 MewoFlow 的项目通常提交 |
| `.mewoflow/runtime/sessions/*.json` | 临时 session 日志 | 不提交 |
| `.claude/`、`.cursor/` 等 AI 工具目录 | 本地工具配置或状态 | 默认不提交 |
| `dist/` | 构建产物 | 源码仓库不提交，发布包通过 `files` 字段包含 |

### 故障排查

#### Claude Code 没有触发 MewoFlow

检查 `.claude/settings.json` 是否包含 MewoFlow hook 命令，并确认当前 Claude Code 会话是在项目根目录启动的。

也可以运行：

```bash
mewoflow doctor
```

如果希望同时检查搜索证据，请在 Claude Code 中使用 `/mewoflow-doctor`。

#### research gate 无法通过

确认 `research.md` 包含来源表格，并且当前 session 中确实调用过 WebSearch、WebFetch、MCP 搜索工具，或明确写明 `user-provided-source`。

如果不确定搜索是否被 hook 记录，运行：

```bash
mewoflow doctor --require-search
```

#### 实现阶段仍然无法改代码

进入 `implement` 后，AI 还需要读取以下文件：

```txt
.mewoflow/rules.md
.mewoflow/tasks/<task-id>/research.md
.mewoflow/tasks/<task-id>/grill.md
.mewoflow/tasks/<task-id>/plan.md
```

#### 不小心卡在某个 gate

优先补齐该 gate 的证据，再运行 `mewoflow check <gate>`。只有无法正常补齐时，才使用 `mewoflow override <gate> --reason "..."`。
