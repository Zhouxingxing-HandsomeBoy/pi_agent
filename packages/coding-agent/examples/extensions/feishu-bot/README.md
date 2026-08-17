# Pi Feishu (Lark) Bot Extension

把一个正在运行的 pi agent 变成一个飞书机器人：在飞书里给它发消息 → pi agent 帮你干活 → 结果回写到飞书会话。

鉴权方式：飞书开放平台应用（`app_id` + `app_secret` 换取 `tenant_access_token`），可调用完整 OpenAPI。

## 工作原理

```
飞书用户 ──消息事件──▶ 本扩展启动的 Webhook
                            │  (url_verification 校验 / AES-256-CBC 解密)
                            ▼
                   pi.sendUserMessage(text) 注入到当前 agent 会话
                            │
                            ▼
                      pi agent 执行（read/write/bash/…）
                            │  (监听 message_end 累积回复文本)
                            ▼
                   agent_settled 后通过 im/v1/messages 回写飞书
```

- 每个飞书会话串行处理（`chat_id` 维度队列），避免并发调用 `sendUserMessage`。
- 飞书要求 Webhook 在 **1 秒内**返回 200，因此收到消息后立即回 200，实际处理异步完成。
- 自动跳过机器人自己发出的消息（`sender_type === "app"`），防止回声循环。
- 按 `message_id` 去重，避免飞书重试导致重复处理。

## 前置条件

1. 在 [飞书开放平台](https://open.feishu.cn/) 创建一个**企业自建应用**。
2. 在 **开发配置 → 权限管理** 开通：`im:message`、`im:message:send_as_bot`（发送消息权限）。
3. 在 **开发配置 → 事件与回调 → 事件配置** 中：
   - 订阅方式选择「将事件发送至开发者服务器」。
   - 请求地址填你的公网 HTTPS 地址 + 路径（如 `https://example.com/feishu/event`）。
   - 添加事件订阅：**接收消息**（`im.message.receive_v1`）。
4. 在 **事件与回调 → 加密策略** 配置：
   - 可选 **Encrypt Key**（开启后回调体被加密，本扩展会自动解密）。
   - 可选 **Verification Token**（开启后本扩展会校验 `token`）。

## 配置（环境变量）

复制 `.env.example` 为 `.env` 并填写，或在运行 pi 前 `export`：

| 变量 | 必填 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | 是 | 应用 App ID |
| `FEISHU_APP_SECRET` | 是 | 应用 App Secret |
| `FEISHU_ENCRYPT_KEY` | 否 | 事件加密 Key（与飞书后台一致才生效） |
| `FEISHU_VERIFICATION_TOKEN` | 否 | 校验 Token |
| `FEISHU_PORT` | 否 | Webhook 监听端口，默认 `3000` |
| `FEISHU_PATH` | 否 | Webhook 路径，默认 `/feishu/event` |
| `FEISHU_RECEIVE_ID_TYPE` | 否 | 回消息用的 ID 类型，默认 `chat_id` |

> 两个变量都未设置时，扩展会在加载时打印警告并自动禁用，不影响 pi 正常启动。

## 启用扩展

扩展目录默认不会被自动发现，需显式指定其一：

**方式 A：放到项目本地扩展目录**（推荐，持久化）

```bash
mkdir -p .pi/extensions/feishu-bot
cp -r packages/coding-agent/examples/extensions/feishu-bot/* .pi/extensions/feishu-bot/
```

**方式 B：用 `--extension` 直接指向示例目录**

```bash
pi --extension ./packages/coding-agent/examples/extensions/feishu-bot
```

启动时设置环境变量，例如：

```bash
export FEISHU_APP_ID=cli_xxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxx
export FEISHU_ENCRYPT_KEY=xxxxxxxx   # 可选
pi --extension ./packages/coding-agent/examples/extensions/feishu-bot
```

启动后日志会出现：

```
[feishu-bot] webhook listening on http://0.0.0.0:3000/feishu/event
```

## 公网可达

飞书只接受 **IPv4 公网 HTTPS** 回调地址。本地开发可用隧道：

```bash
ngrok http 3000
# 或
ssh -R 80:localhost:3000 localhost.run
```

把生成的公网地址 + `/feishu/event` 填到飞书「请求地址」。首次保存时飞书会推送 `url_verification`，扩展会自动原样返回 `challenge` 完成校验。

## 会话内命令

| 命令 | 说明 |
|---|---|
| `/feishu-status` | 显示 Webhook 端口/路径与加解密开关状态 |
| `/feishu-send <chat_id> <文本>` | 主动给某个飞书会话发一条测试消息 |

## 手动验证

1. 启动 pi（带扩展 + 环境变量）+ 隧道，飞书后台保存请求地址并通过 URL 校验。
2. 在飞书里 @ 或私聊该机器人发一句「列出当前目录下的文件」。
3. pi 会话里应出现对应 user 消息并自动执行，最终把结果文本回写到飞书。

## 已知限制（MVP）

- 仅处理文本消息；图片/卡片/富文本暂回「暂仅支持文本消息」。
- 复用当前 agent 会话（单会话），未做飞书 `open_id` → 独立 pi lane 的隔离。
- 回复取本轮所有 assistant 文本块拼接；若 agent 开启 extended thinking，思考内容不计入（thinking 块非 `text`）。
- 建议把机器人跑在**独立的 pi 进程**里，不要同时在 TUI 里手动输入：当前实现用全局 `agent_settled` 捕获回复，若同一会话被 TUI 输入并发驱动，可能把 TUI 的回复误发到飞书。
- 需保持 pi 进程常驻；未内置独立进程/守护。生产部署建议配合进程管理器与 TLS 终止。
