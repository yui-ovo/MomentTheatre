# SillyTavern 1.14 兼容适配

从扩展 1.0.15 开始，最低客户端版本为 1.14.0。此前版本将 1.18.0 写入 manifest，1.14 会在执行入口脚本前拒绝加载。

## 核对依据

核对官方 [1.14.0 tag](https://github.com/SillyTavern/SillyTavern/tree/1.14.0)，提交 `9c9be90821ffd6132b40b5f04982522a61d7ad30`。

| 功能 | 1.14 行为与适配 |
| --- | --- |
| 启动、账号隔离 | `APP_READY` 已支持晚订阅回放，`accountStorage` 已在扩展上下文公开；沿用原实现与资料库命名空间。 |
| 生成状态 | 没有 `isGenerating()`；读取 `script.js` 的实时 `is_send_press`、`streamingProcessor`，以及 `group-chats.js` 的 `is_group_generating`。 |
| 世界书列表 | 上下文没有 `getWorldInfoNames()`；读取 `world-info.js` 的实时 `world_names`。 |
| 角色、面具、预设、正则 | 已提供 `unshallowCharacter`、`powerUserSettings`、`getPresetManager`、`readPresetExtensionField`、`loadWorldInfo`，无需改动源资料。 |
| 主 API | 1.14 的 `presetToGeneratePayload` 只转换温度；兼容分支补齐连接、消息、模型、回复上限、流式参数及基础采样参数。 |
| 模型选择 | 1.14 的 `getChatCompletionModel` 参数为来源字符串；调用时省略参数，在新旧版本都读取当前连接模型。 |
| 独立 API | 继续使用 `ChatCompletionService.sendRequest` 与 custom 后端代理；指定的 Authorization 头覆盖宿主 custom 密钥，空密钥也明确发送空值。 |
| 手动同步 | 1.14 已有 `/api/files/upload`、`/api/files/verify` 和按账号读取文件的路径；不改协议。 |

主要源码：[扩展上下文](https://github.com/SillyTavern/SillyTavern/blob/1.14.0/public/scripts/st-context.js)、[请求服务](https://github.com/SillyTavern/SillyTavern/blob/1.14.0/public/scripts/custom-request.js)、[连接参数](https://github.com/SillyTavern/SillyTavern/blob/1.14.0/public/scripts/openai.js)、[custom 后端](https://github.com/SillyTavern/SillyTavern/blob/1.14.0/src/endpoints/backends/chat-completions.js)。

## 范围

旧版主 API 读取当前 Chat Completion 连接；选定预设提供提示词与基础采样参数。兼容分支不切换主预设、不写回主连接或 API 密钥，不复刻宿主聊天的工具调用、logit bias、自定义停止字符串。其他主 API 类型仍使用独立 OpenAI 兼容 API。

新版提供完整请求转换接口时继续使用原生转换结果；生成状态及世界书列表也优先使用新版接口。1.0.14 的 TT 手机安全区修复保留。

## 验证与实机检查

运行 `node --test tests/host-compat.test.mjs`。覆盖新旧初始化、实时生成状态、旧版世界书与角色关联、主／独立 API 参数隔离、流式返回、生成冲突取消及新版接口路径。

额外使用官方 1.14.0 原始 `custom-request.js` 和 `sse-stream.js`，在本地模拟网络回复下验证主／独立 API × 流式／非流式四种请求。没有连接真实供应商，也没有把模拟测试当作实际酒馆验收。

更新扩展并刷新后，检查：能打开和收起；当前角色、面具、世界书与预设列表可读；使用现有连接生成一条短番外；切换流式再生成；保存后刷新仍可读取。独立 API 另行测试模型列表与短回复。已有资料先导出备份。
