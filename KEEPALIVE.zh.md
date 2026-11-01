# CCometixLine 原生会话保活

原生保活 fork 版本 `2.0.1-keepalive.4`，基于 Haleclipse/CCometixLine 提交 `56849931745e05d2d4e506af2bedbc8d1f0616d4`。保留上游 Rust 状态栏、TUI、伴随插件和分发结构。保活调度与观测参考 dsh-model-fusion；没有移植其请求重放或认证逻辑。

## 行为

在官方账号登录的交互式 Claude Code 主会话中，正常对话结束且空闲 50 分钟后，通过官方 `$.prompt.submit()` 提交：

> [CCometixLine 保活] 仅回复 OK。不要调用工具，不要继续之前的任务。

消息和回复正常保存在会话历史中，并显示插件来源。每次保活回复结束后重新计时。首版仅有开关，间隔固定为 50 分钟，每 10 秒检查一次。没有额外守护进程；退出 Claude Code 即结束计时。

- 默认关闭；新启动、恢复、会话切换、重载后，等待一次正常用户对话结束。
- 只有实际缓存数据为 `1h`、缓存仍有效且状态栏数据在 30 秒以内才发送。
- 五分钟缓存、未知 TTL、缓存过期、草稿、运行中的工具或任务会暂停发送。
- 休眠或时钟中断后不补发；需要新的正常用户对话。
- 请求拒绝、失败、中断或保活尝试调用工具后暂停，直到一次正常用户对话成功结束。
- 用户任务优先；保活工具调用被拒绝，只取消关联到本插件的保活轮次。
- 不读取凭证、不拼接 HTTP 请求、不修改模型、思考档位、工具定义或缓存 TTL。

保活会消耗真实用量。`OK` 的长度由模型决定；缓存读取数量大于零表示有缓存命中，不代表全部上下文都命中，也不保证节省额度。长任务、电脑休眠和草稿阻塞可能导致缓存过期，插件不会为了保活打断正常工作。

## 获取与同步上游

本 fork 的默认开发分支为 `keepalive`；`master` 保留上游历史。同步时将上游合并到功能分支，保留保活改动：

```sh
git clone https://github.com/lyy0709/CCometixLine.git
cd CCometixLine
git remote add upstream https://github.com/Haleclipse/CCometixLine.git
git switch keepalive
git fetch upstream
git merge upstream/master
cargo test
cargo fmt -- --check
cargo clippy -- -D warnings
# 使用你配置的 Claude 入口运行插件测试，再提交、推送。
git push origin keepalive
```

合并存在冲突时，先处理冲突并验证，不使用覆盖功能分支的强制同步。`origin` 指向自己的 fork，`upstream` 指向 Haleclipse/CCometixLine。

## 安装本地构建

要求具有函数式插件模块能力的 Claude Code；本地实测版本为 **2.1.316**。该接口仍是早期功能，未来版本可能需要适配。首次使用需重启 Claude Code 才能加载伴随插件。

如果配置了 IP guard，所有 Claude CLI 操作都应显式通过受保护的启动器。非交互 shell 不一定会加载交互 shell 的 `claude()` 函数。伴随模块的安装/更新命令可使用 `CCLINE_CLAUDE=/绝对路径/可执行启动器 ccline mod install` 指定入口；Python guard 需要先有调用 Python 和该脚本的可执行启动包装。保活本身在已有 Claude Code 进程内提交消息，因此日常 Claude Code 会话也应从 guard 入口启动。

源码构建：

```sh
cargo build --release
./target/release/ccometixline --version
```

交付包的 `bin/ccline` 为 macOS Apple Silicon 二进制。其他平台请自行构建；上游的跨平台构建流程保留，但本次没有实机验证 Windows/Linux。

推荐将交付的二进制放入既有 CCometixLine 安装位置前，备份原文件：

```sh
mkdir -p ~/.claude/ccline
# 已安装时先把旧 ccline 复制到一个尚不存在的备份文件，再执行下一行。
cp ./bin/ccline ~/.claude/ccline/ccline
chmod +x ~/.claude/ccline/ccline
~/.claude/ccline/ccline mod install
~/.claude/ccline/ccline
```

TUI 中打开 **Claude Code → Companion mod**：

1. 安装或更新 companion mod。开启保活时如模块不是当前版本，会先打开现有安装确认界面；安装后再次操作开关。
2. 将 **keepalive** 从 off 改为 on。首次开启会把 `keepalive` 指标添加到第一行（已有该指标时不重复添加），并准备状态栏每 2 秒刷新的设置。
3. 按 **Ctrl+S** 保存。Claude Code 的设置差异会单独展示，接受后写入并保留原有备份；其他设置按上游方式保留。
4. 重启 Claude Code，完成一轮正常对话。状态栏开始显示 `KA 50:00 后保活`。

也可以手动配置（合并到现有配置，不覆盖其余内容）：

```toml
# ~/.claude/ccline/config.toml
[keepalive]
enabled = true
```

在现有 `[[line]]` 的 `left` 或 `right` 中加入 `"keepalive"`，并将 Claude Code 的 `statusLine.command` 指向原生保活 fork 版本、`statusLine.refreshInterval` 设为 `2`。支持原有 `CCLINE_HOME`；伴随插件与状态栏必须使用同一个目录。

不必全局安装即可试用：把 `CCLINE_HOME` 设为独立测试目录，给 `claude --plugin-dir /绝对路径/source/mod/cometix --settings /绝对路径/settings.json` 传入本次会话专用设置；其中状态栏 command 指向交付二进制。此方式不改变全局插件安装记录。

**不要用上游 `npm update -g @cometix/ccline` 更新这个派生版本**：它会安装上游程序，可能覆盖本功能。此 fork 未发布到 npm；源码与后续更新在 [lyy0709/CCometixLine](https://github.com/lyy0709/CCometixLine)。

## 状态与数据

`keepalive` 指标支持模板字段 `status`（显示文案）、`state`（原始状态）、`left`、`reason`、`result`、`attempts`、`replies`、`read`、`write`。

| 显示 | 原始状态 | 含义 |
| --- | --- | --- |
| KA 已关闭 | off | 配置关闭 |
| KA 等待对话 | waiting | 等待一次正常用户轮次结束 |
| KA 49:32 后保活 | countdown | 距离保活检查的倒计时 |
| KA 正在对话 | busy | 正在思考、回复或执行任务，优先于草稿 |
| KA 正在输入 | draft | 会话空闲，输入框有未发送内容 |
| KA 正在保活 | sending | 当前保活轮次正在执行 |
| KA 已暂停 · 原因 | paused | 缓存条件不满足或发生异常 |
| KA 模块未就绪 | unavailable | 尚未收到当前会话的保活模块数据 |
| KA 状态已过期 · 插件停止更新 | unavailable | 模块数据超过 30 秒未更新，不表示 Claude 网络断开 |

`/clear` 和 `/resume` 只结束旧会话，后台检查会绑定新会话并继续更新状态；清空草稿后恢复等待对话或符合条件的倒计时。恢复的历史对话不会立即触发保活，仍须在本次运行中完成一次正常对话。

提交、开始回复、输入编辑和回复结束都会更新显示，状态栏在下一次本地刷新呈现；不必等下一次 10 秒保活检查。暂停原因仅在 paused 状态展示，上一轮保活结果仅在 countdown 状态展示，避免旧提示残留。保活条件与 50 分钟间隔保持不变。

“收到回复，未确认缓存命中”与“缓存命中”分开显示；后者依据官方返回的 `cache_read_input_tokens`。实际续期还需查看原有 `cache` 指标的到期时间。

Rust 在既有 `state/sessions/<session>.json` 中增加解析后的 `keepalive` 开关；TypeScript 在既有 `bridge/<session>.json` 中增加运行状态和计数。两者按 session id 隔离。旧配置和旧桥接文件仍可读取。

## 验证和限制

```sh
claude plugin test mod/cometix
cargo test
cargo fmt -- --check
cargo clippy -- -D warnings
cargo build --release
```

单元测试使用官方 `claude-code/testing` 的虚拟时钟，仅用于验证调度与竞态；交付代码使用真实时钟和真实 Claude Code 会话。本地实机记录与用户会话数据不随公开仓库发布。

恢复上游程序前先关闭保活，并用对应的上游程序重新安装 companion mod。仅卸载插件会停止运行；无需删除用户会话或认证数据。

来源：
- https://github.com/Haleclipse/CCometixLine
- https://github.com/aa2246740/dsh-model-fusion/blob/8192f845387f9f7d588cbee6302979d8b93c6976/src/host/native-keepalive.ts
- https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/mods/types/claude-code.d.ts
- https://code.claude.com/docs/en/prompt-caching

上游在 Cargo.toml 和插件清单中声明 MIT 许可；本派生版本保留全部上游署名与已有文件。
