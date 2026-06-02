

# MewoFlow



**让开发按证据驱动的开发流程工作。**  
基于Trellis和grill-me skill两个项目结合的新项目



## 什么是 MewoFlow?

国产模型在某些情况下在不断约束的情况下，还是会自己去编写，而不是遵守开发流程，于是参考了Trellis项目对我常用的工作流进行的整合
MewoFlow 只解决一个具体问题：让大模型在本地开发任务中按证据驱动的流程工作。

## 安装

```bash
npm install -g mewoflow
```

## 使用方法

在项目根目录执行：

```bash
mewoflow init
```

它会检查本地 wiring、必要时重新初始化，并确认 hooks 与 skill 是否处于可工作状态。

然后向 Claude Code 提出一个需要完整流程的开发任务，例如：

```txt
修复登录 bug
```

MewoFlow 不会立刻创建任务目录。它会先把请求判断为 `simple` / `standard` / `epic`，把判断结果展示给你，并询问这个判断有没有问题。hook 不会根据固定回复词自动接受或拒绝判断；Claude 需要理解你的自然语言回复，然后运行显式状态转换命令：

```bash
npx mewoflow accept-judgment --session <session-id>
npx mewoflow reject-judgment --reason "用户纠正内容" --session <session-id>
```

如果 workflow 判断被接受，`accept-judgment` 才会创建 draft pending task。随后 Claude 必须用受控命令提交自己判断出的最终 title/slug：

```bash
npx mewoflow propose-task --title "修复登录 bug" --slug "login-bug" --session <session-id>
```

然后再明确询问你是否创建任务。Claude 理解你的确认或取消后，必须运行显式命令，不允许 hook 用硬编码短语自动判断：

```bash
npx mewoflow confirm-task --session <session-id>
npx mewoflow cancel-task --session <session-id>
```

`confirm-task` 会创建 `.mewoflow/tasks/<date>-<slug>/` 并进入正式 workflow。draft id 不会作为最终 task id。如果 Claude Code 用结构化问答收集了确认，可能不会触发新的 `UserPromptSubmit` hook；这种情况下同样运行上面的受控命令，不允许手动 `mkdir .mewoflow/tasks/...` 或写任务状态文件。

```txt
judgment-review -> pending-task-confirmation -> research -> grill -> plan -> user-approval -> implement -> verify -> review -> verify -> archive
```

其中 `research.md` 必须写 `## Tool Evidence`，并证明用过 WebSearch、WebFetch、MCP、skill 或明确用户来源；不能把用户拒绝回答的问题或假设写成事实。

`grill` gate 会直接使用初始化时写入项目的 `.claude/skills/grill-me/SKILL.md`，要求 AI 一次只问一个关键问题，给出推荐答案，并覆盖产品目标、MVP 范围、非目标、页面/导航、数据来源、核心交互、响应式 UI、空/错态、测试/验收、风险、预算/时间盒、部署、隐私安全、失败模式和回滚。只有当模型/assistant 判断继续追问已经没有意义时，才能把结论、停止追问者和理由写入 `grill.md`。

`plan` gate 也不会自动进入实现。Claude 在最终写计划前必须再次联网/MCP/skill 搜索快捷方案或现成方案，并在 `## Shortcut / Existing Solution Scan` 中记录。计划还必须包含 MVP 切片、阶段、延后项、风险和验证方式。从 0 开始的大项目应先作为 parent epic 完成全局 research/grill/plan，再在 `## Parent / Child Task Breakdown` 里列出 child tasks，计划批准后可用 `mewoflow split-task --from-plan` 拆分逐一完成。

Claude 必须先把计划展示给你。hook 不会根据固定批准短语自动记录 plan approval；Claude 理解你的自然语言回复已经批准计划后，应运行：

```bash
npx mewoflow approve-plan --prompt "用户批准计划原文" --session <session-id>
```

只有记录了这条显式批准后，`mewoflow check plan` 才能进入 `implement`。

实现完成后不能只跑一次验证就结束。标准流程必须先把初次验证证据写入 `verify.md`，通过 `mewoflow check verify` 进入 `review`；随后在 `review.md` 中记录逐文件代码 review、架构/安全/性能/可维护性影响，并在适合时使用 skill 或 subagent；`mewoflow check review` 通过后必须再次补充 post-review 验证证据，再通过第二次 `mewoflow check verify` 进入 `archive`。归档通过后，任务目录会移动到 `.mewoflow/archive/<task-id>/`。

如果你只是让 Claude Code 提交当前 git 改动，例如输入 `提交` 或 `git 提交`，MewoFlow 不会为此创建 workflow task，而是要求运行受控命令：

```bash
npx mewoflow commit --message "简短提交说明"
```

该命令只创建本地 commit，不会 push；它会拒绝疑似 secret 文件，并可用 `--dry-run` 预览提交消息和变更文件。

当 hooks 正常触发时，Claude Code transcript 里会出现类似 `猫咪正在监控你的需求喵！`、`猫咪正在检查工具调用喵！` 的提示。没有看到提示时，先运行 `/mewoflow` 或 `mewoflow doctor` 检查 `.claude/settings.json` 的 hook wiring。

在 pending task 未确认、`research` / `grill` / `plan` 未通过、或计划尚未得到用户批准前，MewoFlow 会阻止脚手架、安装依赖和实现文件编辑。比如 `pnpm create next-app@latest .`、`npm install`、`pnpm add` 会被要求先完成任务确认、`research -> grill -> plan` 和用户批准，避免 AI 询问完需求后直接创建项目。

常用命令：

```bash
mewoflow status
mewoflow accept-judgment --session <session-id>
mewoflow reject-judgment --reason "用户纠正内容" --session <session-id>
mewoflow propose-task --title "修复登录 bug" --slug "login-bug" --session <session-id>
mewoflow confirm-task --session <session-id>
mewoflow cancel-task --session <session-id>
mewoflow check pending-task-confirmation
mewoflow check research
mewoflow check grill
mewoflow check plan
mewoflow approve-plan --prompt "用户批准计划原文" --session <session-id>
mewoflow split-task --from-plan
mewoflow check implement
mewoflow check verify
mewoflow check review
mewoflow check verify
mewoflow check archive
mewoflow commit --message "chore: update workflow"
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
      review.md
      archive.md
  archive/
    <task-id>/
      task.json
      research.md
      grill.md
      plan.md
      verify.md
      review.md
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
    grill-me/
      SKILL.md
```

Hook 职责：


| Hook               | Purpose                                                |
| ------------------ | ------------------------------------------------------ |
| `UserPromptSubmit` | 判断请求类型，先创建 pending judgment，并提示 Claude 通过显式 CLI 命令推进判断、任务确认和计划批准。 |
| `PreToolUse`       | 阻止 pending judgment/task 未确认、过早改代码、脚手架和安装依赖；保护状态文件，允许受控 CLI 命令和当前任务证据写入。  |
| `PostToolUse`      | 记录文件读取、搜索工具调用和命令执行，并输出记录提示。                            |
| `Stop`             | 任务未完成时阻止 AI 直接结束，并提醒继续当前 gate。                         |


如果当前只有 pending judgment，`PreToolUse` 会阻止研究、脚手架和文件写入，只允许 `mewoflow accept-judgment` / `mewoflow reject-judgment --reason "..."` 这类受控判断命令。判断被接受后才会出现 pending task；此时唯一允许的 pending 写入口是 MewoFlow CLI 自己的受控命令：`mewoflow propose-task --title "..." --slug "..."` 记录模型建议，随后由 `mewoflow confirm-task` 创建正式任务，或由 `mewoflow cancel-task` 取消草稿。hook 不会根据自然语言短句自动确认或取消。如果当前没有 active task，`PreToolUse` 也会阻止高风险脚手架或依赖命令，提示先建立或恢复任务。普通小改动不会因此被强制拉入完整 workflow。

## Troubleshooting

### 看不到猫咪 hook 提示

1. 在 Claude Code 里运行 `/mewoflow`，让 skill 检查或重建本地 wiring。
2. 运行 `mewoflow doctor`，确认 `.claude/settings.json` 包含 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 四个 hook。
3. 如果 doctor 报 hook 缺失，重新执行 `npx mewoflow init`。

### Claude 询问后仍想直接创建项目

这通常表示 prompt judgment 还没通过显式命令处理、pending task 还没有被确认、active task 没有建立，或当前 gate 还停在 `research` / `grill` / `plan`。MewoFlow 会在工具调用前拦截脚手架和依赖命令，并提示先完成：

```txt
judgment-review -> pending-task-confirmation -> research -> grill -> plan -> user-approval
```

继续方式是：Claude 先解释你的自然语言判断回复并运行 `mewoflow accept-judgment --session <session-id>` 或 `mewoflow reject-judgment --reason "..." --session <session-id>`；判断接受后，再运行 `mewoflow propose-task --title "..." --slug "..." --session <session-id>` 固化模型建议的最终 task id；你确认创建任务后运行 `mewoflow confirm-task --session <session-id>`，取消则运行 `mewoflow cancel-task --session <session-id>`，不要手动写 `.mewoflow/tasks`。之后补齐 `.mewoflow/tasks/<task>/research.md`、`grill.md`、`plan.md`；分别运行 `mewoflow check research`、`mewoflow check grill`；展示计划并在 Claude 判断你已批准后运行 `mewoflow approve-plan --prompt "..." --session <session-id>`，最后才能 `mewoflow check plan` 进入 `implement` 并创建项目或改代码。

### 已确认但还是卡在 pending task

如果 transcript 里显示你已经在 Claude 的选择题/结构化问答中点了“确认创建”，但 hook 仍提示 pending task，说明确认没有对应的显式 CLI 状态转换。这不是让 Claude 手动建目录的理由。正确做法是让 Claude 运行：

```bash
npx mewoflow confirm-task --session <session-id>
```

这个命令会由 MewoFlow CLI 从 session 中读取 pending task，创建正式任务目录，并把 gate 设为 `research`。

### Claude 写完计划后仍想直接运行 `pnpm create`

`mewoflow check plan` 要求显式用户批准。Claude 必须先展示 `plan.md`，理解你的自然语言回复是否已经批准计划，然后运行 `mewoflow approve-plan --prompt "..." --session <session-id>` 记录批准。hook 不会根据固定批准短语自动写入 approval。没有该记录时，即使计划内容有效，也不能进入 `implement`，脚手架和实现写入会继续被拦截。

### `grill-me` 缺失或 grill 只问一轮

`grill` 不是固定轮数限制，而是必须使用项目内置的 `.claude/skills/grill-me/SKILL.md`，持续追问到模型/assistant 判断“继续问已经没有意义”。`grill.md` 还必须覆盖产品目标、MVP 范围、非目标、页面/导航、数据来源、核心交互、响应式 UI、空/错态和测试/验收。如果 `mewoflow doctor` 报 `.claude/skills/grill-me/SKILL.md` 缺失，或 `grill.md` 没有记录 `Used: grill-me`、`Decision Coverage` 与 `Grill Completion Judgment`，重新执行：

```bash
npx mewoflow init
```

然后让 Claude Code 回到当前任务的 `grill` gate，直接使用 project-local `grill-me` skill。

## Workflow Gates


| Gate                        | Purpose                              | Evidence                                                        |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `pending-task-confirmation` | 新开发需求先等待判断复核和用户确认是否创建任务                   | prompt judgment、accept/reject 命令、draft pending id、模型提交 title/slug、confirm/cancel 命令                   |
| `research`                  | 获取最新资料和上下文                           | Tool Evidence、来源、事实、假设、未知项、对任务的影响                               |
| `grill`                     | 直接使用 project-local `grill-me` 追问关键需求 | skill 使用记录、问题、推荐答案、用户答案、决策覆盖、风险/预算/部署/安全/回滚、模型/assistant 停止追问理由 |
| `plan`                      | 写实现计划                                | 快捷/现成方案扫描、MVP 切片、parent/child breakdown、阶段、延后项、风险、验证方式          |
| `user-approval`             | 用户明确批准计划后才允许进入实现                     | plan approval 记录、用户批准原文                                         |
| `implement`                 | 允许修改代码                               | 计划已批准，且已读取规则和任务上下文                                              |
| `verify`                    | 初次验证与 review 后复验                      | 命令输出、关键链路证据、review follow-up 验证记录                              |
| `review`                    | 对实现做代码 review                        | 逐文件 review、架构/安全/性能/可维护性影响、skill/subagent 证据或无合适 skill 说明       |
| `archive`                   | 归档任务                                 | 总结、验证结果、review 结论、后续事项；目录移动到 `.mewoflow/archive/<task-id>/`        |


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
grill-me
```

`/mewoflow` 用来开始或恢复 MewoFlow，`/mewoflow-doctor` 会要求 Claude Code 先使用自带搜索，再运行 `npx mewoflow doctor --require-search`。`grill-me` 是 project-local skill，供 `grill` gate 直接调用。

## AGENTS.md and CLAUDE.md

MewoFlow 会生成两个项目说明入口：

- `AGENTS.md`：跨 Agent 通用说明。
- `CLAUDE.md`：Claude Code 项目记忆入口，默认导入 `@AGENTS.md`。

它们是软引导，用来告诉 AI 项目采用 MewoFlow。真正阻止跳步骤的是 hooks 和 `mewoflow check`。

## How is this different from Trellis?

MewoFlow 参考了 Trellis 的文件化上下文、任务证据、hooks/commands/skills 思想，但目标更窄：


| Trellis                                                        | MewoFlow                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 面向多 AI 编程工具和团队工作流                                              | 只先支持 Claude Code                                                                                               |
| 提供 spec、workspace、tasks、skills、sub-agents、commands、hooks 等完整体系 | 只做本地开发流程门禁                                                                                                     |
| 可演进为跨平台协作层                                                     | 专注强制 pending-task-confirmation -> research -> grill -> plan -> user-approval -> implement -> verify -> review -> verify -> archive |
| 平台能力更完整                                                        | 不做云同步、账号、团队权限、搜索 API Key 管理                                                                                    |


## CLI Reference


| Command                                            | Description                                             |
| -------------------------------------------------- | ------------------------------------------------------- |
| `mewoflow init`                                    | 初始化 MewoFlow 文件和 Claude Code hooks。                     |
| `mewoflow status`                                  | 查看当前任务和 gate。                                           |
| `mewoflow doctor`                                  | 检查本地文件、hook 配置、doctor skill 和任务状态。                      |
| `mewoflow doctor --require-search`                 | 要求当前 session 已记录搜索工具调用。                                 |
| `mewoflow accept-judgment --session <id>`           | 接受当前 pending judgment；workflow 判断会创建 pending task 草稿。 |
| `mewoflow reject-judgment --reason "..." --session <id>` | 拒绝当前 pending judgment，并记录用户纠正原因。 |
| `mewoflow propose-task --title "..." --slug "..." --session <id>` | 为 pending task 记录模型建议的最终标题和 slug。                       |
| `mewoflow confirm-task --session <id>`              | 用户已确认 pending task 后，由 CLI 受控创建正式任务。                    |
| `mewoflow cancel-task --session <id>`               | 用户取消 pending task 后，由 CLI 清除草稿。                 |
| `mewoflow check pending-task-confirmation`          | `confirm-task` 的兼容命令。                    |
| `mewoflow approve-plan --prompt "..." --session <id>` | Claude 判断用户已批准计划后，受控记录 plan approval。                      |
| `mewoflow split-task --from-plan`                  | parent epic 计划批准后，按 plan 中的 child task breakdown 拆分子任务。 |
| `mewoflow check <gate>`                            | 校验当前 gate 证据并进入下一阶段。                                    |
| `mewoflow commit --message "..."`                  | 受控创建本地 git commit；拒绝疑似 secret 文件，不会 push。                 |
| `mewoflow commit --dry-run`                        | 预览提交消息和将要提交的文件，不写入 git。                                 |
| `mewoflow override <gate> --reason "..."`          | 异常情况下跳过当前 gate。                                         |
| `mewoflow hook <event>`                            | Claude Code hook 内部调用。                                  |


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
