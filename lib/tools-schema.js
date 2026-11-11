/**
 * NeoWarpAI CLI — function calling 工具定义。
 * 命名与语义对齐 NeoWarp 桌面版系统提示词（scripts/build-system-prompt.js 的
 * OPERATION TYPES 与 OTHER TOOLS 段），供 OpenAI / Anthropic / Ollama 工具调用。
 */
'use strict';

const P = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required: required || [] } }
});

const S = { type: 'string' };
const N = { type: 'number' };
const B = { type: 'boolean' };

const TOOLS = [
  // ── 积木脚本 ──
  P('add_script', '在一个角色上新建脚本（自己的独立积木堆）。script 参数是积木 DSL 文本：一行一积木 opcode 参数...，两空格缩进表示放进 C 块体内，else 单独一行表示 if_else 的否则分支，$变量 @列表 (报告器) 引用，# 注释。首行可以是帽积木（event_* / control_start_as_clone / define），否则自动加绿旗帽。',
    { sprite: S, script: { type: 'string', description: 'DSL 文本，如 "event_whenflagclicked\\n  motion_movesteps 10"' } }, ['sprite', 'script']),
  P('set_scripts', '整体替换某角色的全部脚本（谨慎使用；常规追加用 add_script，局部修改用 insert_blocks / modify_input）。',
    { sprite: S, script: S }, ['sprite', 'script']),
  P('insert_blocks', '把积木体插入既有脚本的指定位置（不新建积木堆）。position: after(默认,紧贴锚点下方)/before(锚点上方)/body_start/body_end；body_* 可加 branch:"else" 定位 else 分支。blocks 不能以帽积木开头。',
    { targetId: { type: 'string', description: '锚点积木 tid（来自 get_sprite_scripts 或项目上下文）' }, position: { type: 'string', enum: ['after', 'before', 'body_start', 'body_end'] }, blocks: S, branch: { type: 'string', enum: ['else'] } }, ['targetId', 'blocks']),
  P('delete_block', '删除积木。mode: with_children(默认,连同体内与下方全部)/block_only(仅该块并重连前后)。',
    { targetId: S, mode: { type: 'string', enum: ['with_children', 'block_only'] } }, ['targetId']),
  P('modify_input', '修改既有积木的一个输入。value 可以是数字/字符串、报告器对象 {"opcode":"...","inputs":{...}}；SUBSTACK/SUBSTACK2 传 DSL 文本替换整个分支体。inputName 必须是该 opcode 的参数名。',
    { targetId: S, inputName: S, value: {} }, ['targetId', 'inputName', 'value']),
  P('get_sprite_scripts', '把一个角色的全部脚本读回为 DSL 文本（带 tid）。修改陌生代码前先读它，把插入位置锚定到正确的 tid。',
    { sprite: S }, ['sprite']),
  P('execute_operations', '一次调用批量执行多个操作（add_script/insert_blocks/delete_block/modify_input/add_comment/delete_comment/explain）。需要同时加多个脚本或组合修改时优先用它。',
    { operations: { type: 'array', items: { type: 'object' } } }, ['operations']),
  P('add_comment', '给积木附加注释（targetId）或放置自由注释（x,y）。返回 data.commentId。',
    { sprite: S, targetId: S, x: N, y: N, text: S, minimized: B }, ['sprite', 'text']),

  // ── 项目 / 精灵 / 舞台 ──
  P('get_project_info', '读取项目全貌：角色列表（位置/大小/方向/积木数/造型/声音）、舞台背景、已装扩展。写之前先读。',
    {}, []),
  P('add_sprite', '新建空白角色（CLI 不内置素材库图片）。返回实际名称（重名自动编号）。',
    { spriteName: S }, []),
  P('duplicate_sprite', '复制角色（含脚本、造型与本地变量）。new_name 可省略，自动编号并把最终名称报给你。',
    { spriteName: S, newName: S }, ['spriteName']),
  P('rename_sprite', '重命名角色。引用该角色的积木会自动更新。',
    { spriteName: S, newName: S }, ['spriteName', 'newName']),
  P('delete_sprite', '删除角色及其脚本、造型、声音与本地变量。结果会列出被删除的内容。',
    { spriteName: S }, ['spriteName']),
  P('set_sprite_property', '一次设置角色多项属性：x/y/size/direction/visible/draggable/rotation_style。越界数值按 Scratch 规则截断并在 warnings 里报告。',
    { spriteName: S, x: N, y: N, size: N, direction: N, visible: B, draggable: B, rotationStyle: S }, ['spriteName']),
  P('get_sprite_property', '读取角色属性。',
    { spriteName: S }, ['spriteName']),
  P('change_costume', '按名称切换角色造型。名字大小写敏感。',
    { spriteName: S, costumeName: S }, ['spriteName', 'costumeName']),
  P('change_backdrop', '按名称切换舞台背景。',
    { backdropName: S }, ['backdropName']),
  P('add_backdrop', '新增纯色背景（SVG 渐变）。color 为 #rrggbb。',
    { backdropName: S, color: S }, []),
  P('get_stage_info', '读取舞台信息（当前背景、全部背景、尺寸）。',
    {}, []),
  P('set_stage_size', '设置自定义舞台尺寸（TurboWarp 特性，最小 240x180）。',
    { width: N, height: N }, ['width', 'height']),
  P('rename_project', '重命名项目。',
    { name: S }, ['name']),

  // ── 变量 ──
  P('create_variable', '创建变量。省略 sprite_name 时在舞台（全局）上创建——这是默认推荐。数值字符串会按 Scratch 规则转成数字。已存在时返回 existed:true 而不报错。',
    { variableName: S, initial_value: S, spriteName: { type: 'string', description: '仅局部状态才传；省略=全局' } }, ['variableName']),
  P('set_variable', '设置变量值（不存在时报错，先 create_variable）。同时返回旧值。',
    { variableName: S, value: {}, spriteName: S }, ['variableName', 'value']),
  P('get_variable', '读变量值（先角色后舞台回退查找）。',
    { variableName: S, spriteName: S }, ['variableName']),
  P('rename_variable', '重命名变量。',
    { variableName: S, newName: S, spriteName: S }, ['variableName', 'newName']),
  P('delete_variable', '删除变量。仍被积木引用时会拒绝并列出引用角色；确信要删传 force:true。',
    { variableName: S, spriteName: S, force: B }, ['variableName']),
  P('list_variables', '列出全部变量（名称/值/作用域）。',
    {}, []),

  // ── 列表（下标从 1 开始；接受 "first"/"last"）──
  P('create_list', '创建列表，可带初始 items。',
    { listName: S, items: { type: 'array', items: {} }, spriteName: S }, ['listName']),
  P('get_list', '读列表内容。编辑之前先读，保证下标正确。',
    { listName: S, spriteName: S }, ['listName']),
  P('list_lists', '列出全部列表。',
    {}, []),
  P('add_to_list', '追加一项到列表末尾（不存在时自动创建）。',
    { listName: S, item: {}, spriteName: S }, ['listName', 'item']),
  P('insert_to_list', '在位置插入，后面的项下移。index: 数字(1起)/"first"/"last"。',
    { listName: S, index: {}, item: {}, spriteName: S }, ['listName', 'index', 'item']),
  P('set_list_item', '替换某位置的值。',
    { listName: S, index: N, item: {}, spriteName: S }, ['listName', 'index', 'item']),
  P('delete_from_list', '删除一项。index: 数字/"last"/"all"(清空)。',
    { listName: S, index: {}, spriteName: S }, ['listName', 'index']),
  P('clear_list', '清空列表（保留列表本身）。',
    { listName: S, spriteName: S }, ['listName']),

  // ── 扩展 / 查询 / 交互 ──
  P('get_installed_extensions', '列出项目已登记的扩展。',
    {}, []),
  P('install_extension', '按 URL 或已知 ID 安装扩展（登记到项目 extensions，导出后在编辑器生效）。',
    { extension_url: S }, ['extension_url']),
  P('delete_extension', '只允许删除你（AI）经 install_extension 添加的扩展；内置与用户手动添加的受保护。',
    { extension_id: S }, ['extension_id']),
  P('web_search', '联网搜索（DuckDuckGo 即时回答）。查技巧、公式或文档时用。',
    { query: S }, ['query']),
  P('get_system_time', '获取当前系统时间与日期。',
    {}, []),
  P('get_system_info', '获取系统硬件与 OS 信息。',
    {}, []),
  P('ask_user', '当用户的要求过于笼统、模糊或存在多种解释时，向用户提问澄清。会渲染选项卡片，用户可点选或自行输入。仅在确需澄清时使用，明确具体的请求直接执行。',
    { question: S, options: { type: 'array', items: S } }, ['question']),
  P('explain', '向用户展示一段简短说明（不改变项目）。批量操作里的总结用它。',
    { text: S }, ['text'])
];

module.exports = { TOOLS };
