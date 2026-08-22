# DSH 飞书消息通道

[![CI](https://github.com/srchengtao2025/dsh-feishu-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/srchengtao2025/dsh-feishu-channel/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/srchengtao2025/dsh-feishu-channel)](https://github.com/srchengtao2025/dsh-feishu-channel/releases)
[![License](https://img.shields.io/github/license/srchengtao2025/dsh-feishu-channel)](./LICENSE)

[English](./README.en.md) · [更新记录](./CHANGELOG.md) · [安全说明](./SECURITY.md)

`dsh-feishu-channel` 是一个社区维护的 DeepSeek Harness 插件，为 Harness 增加飞书企业自建应用消息通道。它通过飞书长连接接收事件，不要求服务器开放新的公网端口。

> 项目状态：Developer Preview。当前版本针对 DeepSeek Harness `0.1.0-rc.8` 开发和验证；Harness 仍在快速演进，升级核心后请重新运行测试。

## 快速安装

环境要求：DeepSeek Harness `0.1.0-rc.8`、Node.js 22 或更高版本，以及一个启用了机器人能力的飞书企业自建应用。

从 GitHub Releases 下载最新的 `dsh-feishu-channel-*.tgz`，然后安装到 Harness Web profile：

```bash
dsh plugin --profile web add ./dsh-feishu-channel-0.10.1.tgz
```

如果首次安装出现 `ERR_PNPM_IGNORED_BUILDS`，pnpm 会在 Web profile 的 `pnpm-workspace.yaml` 中生成 `protobufjs` 待审核项。这个生命周期脚本不是插件运行所必需的，可将生成的占位值明确改为 `false`，保留 DSH 的严格供应链保护，然后重新执行安装：

```yaml
allowBuilds:
  protobufjs: false
```

如果你希望从源码构建：

```bash
git clone https://github.com/srchengtao2025/dsh-feishu-channel.git
cd dsh-feishu-channel
npm ci
npm test
npm pack
dsh plugin --profile web add ./dsh-feishu-channel-0.10.1.tgz
```

## 当前能力

- 在 DSH 本地 Web 服务中提供 `/feishu-channel` 配置页。
- 支持显式选择飞书国内版或 Lark 国际版 API 域。
- App Secret 写入 DSH credentials，不进入 settings，不会从配置 API 回显。
- 允许用户 `open_id` 白名单；空白名单时私聊默认允许，群聊仍要求白名单。
- 私聊控制，以及可选的群聊 `@机器人` 控制。
- 每个飞书会话映射一个持久化 DSH Session，支持 `/new`、`/stop`、`/status`。
- 普通任务可开关流式输出；启用时优先使用飞书 CardKit 原生流式卡片，权限不可用时自动降级为编辑文本消息。
- 支持双向文件传输：飞书上传文件会安全保存并关联下一条任务；Agent 可用 `feishu_send_file` 回传生成物，也可手动执行 `/file send`。
- 支持把指定飞书/Lark Wiki 作为本地只读 RAG，向 Agent 提供 `feishu_kb_search` 与 `feishu_kb_read` 工具，并返回可引用的来源链接。
- DSH 请求越权操作时发送一次性飞书审批卡片，同时支持 `/approve`、`/reject` 文字命令。
- 允许白名单用户通过 `/webui` 生成短时 Web UI 地址，默认 30 分钟、最长 60 分钟，到期自动关闭。
- 使用 `message_id` 做进程内幂等去重，按飞书会话串行处理任务。

## 本地开发与安装

在插件目录打包：

```bash
npm ci
npm test
npm pack
```

安装到 DSH 的 Web profile：

```bash
dsh plugin --profile web add ./dsh-feishu-channel-0.10.1.tgz
```

重启 DSH 后，通过 SSH 隧道打开配置页：

```bash
ssh -N -L 3080:127.0.0.1:3080 root@YOUR_SERVER
```

浏览器访问 `http://127.0.0.1:3080/feishu-channel`。

## CLI 配置

插件安装后，profile 内会生成 `dsh-feishu-config` 命令。建议在服务器本机执行：

```bash
dsh-feishu-config show
dsh-feishu-config configure
```

`configure` 会先保存 App ID、允许用户、工作目录和群聊开关，但默认保持通道停用；随后明确询问是否立即测试凭据并启用。App Secret 使用隐藏输入，不会回显。

非交互配置时，App Secret 应通过 stdin 传入，避免出现在 shell 历史和进程参数中：

```bash
read -s FEISHU_SECRET
printf '%s' "$FEISHU_SECRET" | dsh-feishu-config set \
  --app-id cli_0123456789abcdef \
  --app-secret-stdin \
  --workspace /var/lib/dsh/workspace
unset FEISHU_SECRET
```

测试凭据并启用（`enable` 是明确的启用确认）：

```bash
dsh-feishu-config test
dsh-feishu-config enable
```

管理允许用户：

```bash
dsh-feishu-config allow add ou_xxx
dsh-feishu-config allow remove ou_xxx
```

其他常用命令：

```bash
dsh-feishu-config disable
dsh-feishu-config set --group-at
dsh-feishu-config set --no-group-at
dsh-feishu-config set --domain feishu
dsh-feishu-config set --domain lark
dsh-feishu-config set --streaming
dsh-feishu-config set --no-streaming
dsh-feishu-config set --files --max-file-mb 30
dsh-feishu-config set --no-files
dsh-feishu-config set --clear-app-secret --disable
dsh-feishu-config --help
```

## 模型配置 CLI

插件安装后还会提供 `dsh-model-config`，用于在服务器 CLI 中查看和切换 DSH 全局默认模型。它直接更新 DSH 的用户 settings，服务会热加载；API Key 通过 stdin 写入 credentials，不会出现在参数或 `settings.yaml` 中。

```bash
dsh-model-config show
dsh-model-config set-default --provider deepseek-official --model deepseek-v4-pro
dsh-model-config set-default --model deepseek-v4-flash --reasoning-effort high
dsh-model-config reset-default
```

配置 DeepSeek 模型和 API Key：

```bash
read -s DEEPSEEK_API_KEY
printf '%s' "$DEEPSEEK_API_KEY" | dsh-model-config set-deepseek \
  --model deepseek-v4-pro \
  --api-key-stdin
unset DEEPSEEK_API_KEY
```

删除凭据引用：

```bash
dsh-model-config credential unset --ref DEEPSEEK_API_KEY
```

## 临时 Web UI 地址

只有已经加入允许用户列表的用户可以执行此高权限命令：

```text
/webui
/webui 15m
/webui status
/webui stop
```

命令会启动一个 Cloudflare Quick Tunnel，并返回带随机访问令牌的临时 URL。默认有效期 30 分钟，最长 60 分钟。URL 是持有即访问凭证，请勿转发；到期或执行 `/webui stop` 后自动失效。

服务器需要安装 `cloudflared` 并确保它在服务的 `PATH` 中；也可以通过 `DSH_CLOUDFLARED_PATH` 指定绝对路径。Quick Tunnel 由 Cloudflare 分配随机 `trycloudflare.com` 子域名，适合临时调试，不适合作为长期生产入口。

## 飞书/Lark 知识库 RAG

在 `/feishu-channel` 配置页启用知识库检索并填写一个 `/wiki/<token>` 链接。插件会把可读取的新版文档正文同步到工作区内的 `.dsh-feishu/knowledge-index.json`，按段落切片并提供本地检索，不会把整库无条件注入模型上下文。

当前应用若只有入口文档权限，插件会索引该文档并显示 `partial`；要遍历整个知识空间，还需要把应用加入目标知识空间并授予只读权限。索引上限为 500 篇文档或 200 万字符，检索结果始终包含原始文档链接。

## 飞书后台配置

1. 创建企业自建应用并启用机器人能力。
2. 在“权限管理”中开通以下应用身份权限：
   - `im:message.p2p_msg:readonly`：读取用户发给机器人的单聊消息。
   - `im:message:send_as_bot`：以应用的身份发送消息。
   - 推荐增加 `cardkit:card:write`：启用 CardKit 原生打字机流式；未开通时插件会自动使用文本消息编辑流式。
   - `im:resource`：获取用户消息中的文件资源，并上传需要回传的文件。
   - 如启用群聊，再开通 `im:message.group_at_msg:readonly`：接收群聊中 `@机器人` 的消息。
3. 事件与回调中选择“使用长连接接收事件/回调”。
4. 添加事件 `im.message.receive_v1`。
5. 如需使用审批按钮，添加回调 `card.action.trigger`。
6. 发布应用版本，并把需要控制 DSH 的成员加入应用可用范围。
7. 在插件配置页填写 App ID、App Secret；保存时会先保持停用，确认后才会测试凭据并启用通道。
8. 私聊机器人发送 `/whoami`，将返回的 `open_id` 填入允许列表。

默认不配置允许用户时，私聊无需白名单即可执行任务；这是为了首次配置方便。用于生产环境时，强烈建议先通过 `/whoami` 获取自己的 `open_id`，再配置明确的允许用户列表。

## 安全边界

- 插件不改变 DSH Web 服务监听地址；推荐继续保持 `127.0.0.1`。
- 允许列表为空时，私聊默认可以执行远程任务，群聊不会执行；配置任意白名单后，私聊和群聊都只允许列表用户。
- Agent 工作目录固定为配置的绝对路径，默认 `/var/lib/dsh/workspace`。
- 审批只允许原任务发起人处理，并且仅授权一次；十分钟未处理自动拒绝。
- 当前消息去重状态在进程内保存，服务重启后不会保留；后续版本可替换为持久化队列。
- 文本消息编辑流式受飞书单条消息最多 20 次编辑限制；插件会节流更新并预留最后一次编辑写入完整答案。
- 接收文件仅保存到工作区的 `.dsh-feishu/inbox`，文件名会清洗且单文件默认限制 30 MB；文件不会自动执行。
- 回传文件必须经 `realpath` 校验后仍位于当前 DSH 工作区内，不能通过 `..` 或符号链接读取工作区外文件。

## 飞书命令

- `/whoami`：显示自己的飞书 `open_id`，无需预先加入白名单。
- `/help`：查看命令。
- `/status`：查看 DSH 会话状态。
- `/new`：清空当前飞书会话映射。
- `/stop`：终止当前执行。
- `/approve <代码>`：允许一次待审批操作。
- `/reject <代码>`：拒绝待审批操作。
- `/file list`：查看已上传、等待下一条任务关联的文件。
- `/file send <工作区内路径>`：把指定文件发送到当前飞书会话。
- `/file help`：查看文件命令帮助。

## 常见问题

### 机器人收不到消息

确认应用版本已经发布、用户位于应用可用范围、长连接事件中添加了 `im.message.receive_v1`，并检查 `dsh-feishu-config show` 的连接状态。

### 文件收发失败

确认应用已授权 `im:resource`，文件不为空且未超过配置的 30 MB 上限。回传文件还必须位于配置的 DSH 工作目录内。

### 原生流式卡片不可用

确认已授权 `cardkit:card:write`。没有该权限时插件会自动降级为编辑普通文本消息，不影响基本对话。

## 参与开发

提交改动前请运行 `npm test`、`npm run check` 和 `npm run pack:check`。详细流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

本项目采用 [MIT License](./LICENSE)，不是 DeepSeek 官方项目。
