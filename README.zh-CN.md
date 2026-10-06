# pi-devin-native

[English](README.md)

为 Pi 添加 Devin 原生 CLI 模型提供商。使用 Devin 账号登录；模型通过 Devin CLI 后端响应，文件读取、编辑和命令执行仍由本地 Pi 工具完成。

这是非官方扩展，不是 Devin 云端任务 API，也不会创建远程 Devin Agent 任务。

## 环境要求

- Node.js >=22.19.0。
- Pi；当前开发和测试基于 `@earendil-works` 1.0.4，不保证兼容旧版 `@mariozechner` API。
- 有 Devin CLI/Terminal 及对应模型访问权限的账号。

## 安装

下载本项目后，在项目目录运行：

```bash
pi install .
```

重启 Pi 即可加载扩展。若只想临时使用，在本项目目录运行：

```bash
./start.sh
```

该脚本等价于 `pi -e /本项目的绝对路径/index.ts`，支持转发 Pi 命令行参数。也可以在其他工作目录使用绝对路径加载：

```bash
pi -e /本项目的绝对路径/index.ts
```

安装和临时加载二选一，避免重复注册 `devin` 提供商。当前 `package.json` 设置了 `private: true`，这里仅提供本地安装方式。

## 使用

在 Pi 中执行：

```text
/login devin
/devin-refresh
/model
```

1. 按登录提示在浏览器中完成 Devin 授权。
2. `/devin-refresh` 获取当前账号可用的 CLI 模型。
3. 在 `/model` 中选择 `devin` 提供商下的模型，然后正常使用 Pi。

登录回调地址是 `http://127.0.0.1:59653/callback`，五分钟超时。如果 Pi 运行在远程机器上，需要自行转发回调端口。凭据由 Pi 管理；过期后重新执行 `/login devin`，注销使用 `/logout devin`。

刷新成功后，模型元数据会保存到 Pi 的 `<agent-dir>/models-store.json`（默认 `~/.pi/agent/models-store.json`），不保存凭据。新进程在选择默认模型前会恢复缓存，因此 `/model` 中按 `Ctrl+S` 保存的 Devin 默认模型重启后也会生效，包括离线启动。刷新失败会保留上一次成功的模型列表。

只有尚无缓存时才使用 `swe-1-6` 初始条目，它不代表账号具有访问权限。首次使用请先执行 `/devin-refresh`；实际可用模型以刷新结果为准。

### 使用已有凭据

支持通过 `DEVIN_API_KEY` 提供原生 CLI session token，也接受带 `devin-session-token$` 前缀的值。**Devin 云端任务 API key 不能替代 CLI token。** 建议优先使用浏览器登录；不要将凭据写入仓库、聊天或日志。

## 支持范围

- Devin OAuth 登录、账号模型发现和 Connect/Protobuf 流式响应。
- 文本、thinking/签名、工具调用及工具结果回传。
- 按服务端能力声明处理图片；SWE-1.6 模型按纯文本处理。
- 保留原生模型 UID 及不同 effort 变体；Pi thinking 显示 UID 中的固定档位（minimal / low / medium / high / xhigh / max），UID 未标明时参考模型名称。未标明强度的推理模型暂沿用 high 占位，并不表示服务端实际为 high。切换推理强度需选择对应模型，而不是通过 Pi thinking 档位调整服务端参数。
- 请求取消、超时和异常流检查。

不支持 Native Fusion 编排、严格工具语法约束或订阅余额查询。费用信息来自服务端，**显示为 0 不代表免费**。

项目包含离线测试和模拟后端的 Pi CLI 集成测试；这些不等于真实 Devin 订阅下的端到端验证。后端协议或登录流程变化也可能导致扩展失效。

## 常见问题

| 问题 | 处理方式 |
| --- | --- |
| 登录端口被占用 | 释放 59653 端口后重试。 |
| 浏览器授权后未返回 | 检查本地回调访问、代理或远程端口转发。 |
| 401 | 重新登录，并确认使用的是 CLI 凭据。 |
| 403 或模型发现失败 | 确认账号的 CLI 和模型权限，再执行 `/devin-refresh`。 |
| 429 | 检查额度，稍后重试。 |

提交问题前请删除凭据和私人内容。安全说明见 [SECURITY.md](SECURITY.md)。

## 开发

```bash
npm ci
npm run check
```

`check` 包括 TypeScript 类型检查、离线测试和打包检查。发布流程见 [RELEASE.md](RELEASE.md)，贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。
