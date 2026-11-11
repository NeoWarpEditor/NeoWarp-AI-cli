# NeoWarpAI CLI

**NeoWarp AI 编程助手的命令行版** —— 在终端里用自然语言驱动 AI 编写和修改真实的 Scratch 3（`.sb3`）项目文件，无需打开 NeoWarp 编辑器。

积木 DSL 引擎、模型配置格式、工具调用协议、流式对话循环均**逐行复用**自 [NeoWarp](https://github.com/Shiyuan-318/NeoWarp)（基于 TurboWarp Desktop）的 AI 部分，与桌面版 AI 助手行为一致。

## 与 NeoWarp 桌面版的代码对应关系

| CLI 模块 | 复用的上游代码 | 说明 |
| --- | --- | --- |
| `lib/dsl-engine.js` | `src-renderer-webpack/editor/gui/desktop-hoc.jsx` 顶层 29 个函数 | 积木 DSL 解析/校验/构建/序列化引擎，由 `scripts/extract-dsl-engine.js` 自动提取生成，零漂移 |
| `lib/config.js` | `src-main/ai-model-configs.js` | `tw_config.json` 同构配置：字段、`normalizeConfig`、`normalizeCustomEndpoint` 规则完全一致，配置可双向导入导出 |
| `lib/providers.js` | `src-renderer/ai-assistant/ai-assistant.js` 的 `PROVIDERS` | OpenAI / DeepSeek / GLM / Kimi / MiMo / Qwen 预设端点，另补 Anthropic / Ollama / Mock |
| `lib/llm.js` + `lib/loop.js` | `ai-assistant.js` 的 `runConversationLoop` | SSE 流式、`delta.tool_calls` 按 index 增量拼接、`reasoning_content` 思维链、结果 4000 字符截断、`lenientFixJsonStrings` 宽松 JSON 修复 |
| `lib/backend.js` | `desktop-hoc.jsx` 工具执行器（50+ case） | `add_script` / `insert_blocks` / `delete_block` / `modify_input` 等链操作语义逐行对齐（含 `spliceBlocksIntoScript`） |
| `lib/prompt.js` | `scripts/build-system-prompt.js` | 协议段（DSL 语法 / 操作类型 / 校验规则）取自上游 HEAD/TAIL，积木字典从同一 `OPCODE_SCHEMA` 生成 |
| 快照撤销 | 桌面版"一键撤销 AI 修改" | 首次修改前自动快照，`project undo` 一键回滚 |

CLI 的差异化部分：`lib/sb3.js` 用 Node 内置 zlib 实现纯 JS 的 ZIP 读写（零依赖直接操作 `.sb3`）；`lib/vm-adapter.js` 把 `project.json` 包装成 DSL 引擎所需的 scratch-vm 鸭子类型接口。

## 快速开始

```bash
# 交互对话（内置 Mock 模型，无需任何配置即可体验完整工具循环）
node bin/neowarp-ai.js chat --project 我的.sb3

# 配置真实模型（OpenAI 兼容 / Anthropic / Ollama 均可）
node bin/neowarp-ai.js models add
# 或直接导入桌面版配置
node bin/neowarp-ai.js models import ~/Library/Application\ Support/neowarp/tw_config.json

# 单发执行：AI 修改后自动写回项目文件
node bin/neowarp-ai.js run "给 Ball 加一个按空格二段跳的脚本" \
  --project demo/demo.sb3 --save
```

## 命令一览

| 命令 | 说明 |
| --- | --- |
| `chat [--project f] [--save] [--session id]` | REPL 对话：流式输出、思维链灰显、工具调用实时展示；`/save /undo /model /info /clear` 会话内命令 |
| `run "任务" [--save] [--json]` | 单发执行 |
| `models list/add/use/remove/key/test/import` | 模型配置管理（与桌面版 `tw_config.json` 同格式） |
| `project new/info/scripts/undo/snapshots` | 项目管理：新建、概况、读脚本 DSL、快照回滚 |
| `dsl roundtrip` | DSL 引擎往返自检（16 项用例） |

## 能力范围

- **积木脚本**：`add_script`（DSL 追加）、`insert_blocks`（after/before/body_start/body_end + else 分支）、`delete_block`（with_children/block_only）、`modify_input`（标量/报告器/SUBSTACK DSL）、`get_sprite_scripts`（tid 读回）、自定义积木 `define/call`
- **变量与列表**：全套 CRUD，`$var`/`@list` 自动在舞台创建全局，作用域回退查找与 Scratch 一致
- **精灵与舞台**：增删改查、复制（含脚本与本地变量深拷贝 + id 重映射）、属性设置（越界按 Scratch 规则截断并告警）、造型/背景切换、TurboWarp 自定义舞台尺寸
- **扩展**：登记式安装（CLI 不加载运行时代码，导出后在编辑器生效）、仅可删除 AI 自己添加的扩展（与上游保护规则一致）
- **其他**：`web_search`（DuckDuckGo 即时回答）、`ask_user`（终端选项卡）、系统信息、`explain`
- **不可用**（需要 GUI/VM 运行时）：绿旗点击、舞台截图、造型素材库 URL 下载 —— 提示词已作对应裁剪

## 终端 UI

内置一套 Apple Design 风格的终端设计系统（`lib/ui.js`）：

- **低饱和 macOS 系统色板**：systemBlue（品牌/工具）、systemGreen（成功）、systemRed（失败）、systemOrange（提问），256 色近似，`--no-color` 与非 TTY 环境自动零 ANSI
- **统一符号语言**：`◈` 品牌 · `✻` 思考 · `▸` 工具 · `✓`/`✗` 结果 · `›` 提示符 · `·` 列表项
- **行式渲染**：工具行即开即闭，结果行独立输出 —— 模型并行发起多个工具调用时结果永不错位，并自动标注归属（`✓ add_sprite · 2ms`）
- **等待反馈**：模型响应期间行内 spinner（`✻ 思考中 ·`），仅真实 TTY 启用
- **人话参数摘要**：`add_script Ball · ← 10 行 DSL`，不再 dump 原始 JSON
- **任务摘要卡**：每轮任务结束一行 `✓ 完成 · 4 轮 · 4 次工具调用 · 0.6s`

效果见 `demo/screenshot-ui-demo.png`（端到端运行）与 `demo/screenshot-ui-verify.png`（自检与模型配置）。

## 验证

```bash
npm run selftest   # DSL 引擎 16 项往返 + 校验拒绝用例
npm run demo       # Mock 模型端到端：建角色→建变量→写脚本→读回核对→保存
```

## 许可

与 NeoWarp / TurboWarp 上游一致，**GPL-3.0-or-later**（完整文本见仓库根目录 [LICENSE](LICENSE)）。
