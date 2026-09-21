/**
 * js/facets.js 的校验脚本 —— 0.11 加
 *
 * 为什么要有它：facets.js 里有两处「改一处忘一处」的高危区，靠人眼看不出来 ——
 *   1. 提示词模板必须和 docs/PROMPT.md 里那段文本一字不差（维度行是 BASE 渲染的，
 *      改值域时两边必须同时对上；脚本里有断言检查维度行只出现 6 行、
 *      口径说明和多选说明都渲染出来了）
 *   2. 解析器的容错边界：缺维度不报错、脏值不丢弃、多值拆开、失败时原文不吞
 * 这两处只能靠一份能重复跑的断言列表兜。
 *
 * 跑法（零依赖，不用装任何东西）：
 *   node js/facets.test.js
 * 全过退出码 0，有失败退出码 1。
 *
 * ⚠️ 改 facets.js 的 BASE、提示词段落或解析器后，跑一遍。
 */
global.window = {};
require("./facets.js");
var F = window.P5Facets;

var pass = 0;
var fail = 0;

function ok(label, cond, extra) {
  if (cond) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label + (extra ? "  → " + extra : ""));
  }
}

console.log("=== 字典 ===");
ok("BASE 有 6 个基础维度", F.BASE.length === 6, F.BASE.length);
ok("维度名正确", F.BASE.map(function (f) { return f.name; }).join(",") === "镜头,时段,光线,视角,景别,姿势");
ok("每个维度都带「不确定」", F.BASE.every(function (f) { return f.values.indexOf("不确定") >= 0; }));
ok("姿势是多值维度", F.BASE.filter(function (f) { return f.multi; }).map(function (f) { return f.name; }).join(",") === "姿势");
ok("isBase(镜头)", F.isBase("镜头") === true);
ok("isBase(道具) 为假", F.isBase("道具") === false);
ok("valuesOf(镜头) 是数组", Array.isArray(F.valuesOf("镜头")));
ok("valuesOf(道具) 是 null", F.valuesOf("道具") === null);

console.log("=== 编解码 ===");
ok("encode 正常", F.encode("镜头", "中长焦") === "镜头:中长焦", F.encode("镜头", "中长焦"));
ok("encode 带空格被拒", F.encode("镜头", "中长 焦") === "");
ok("encode 带冒号被拒", F.encode("镜头", "f:2.8") === "");
ok("encode 带逗号被拒", F.encode("道具", "伞,光") === "");
ok("encode 空值被拒", F.encode("镜头", "") === "");
ok("decode 正常", JSON.stringify(F.decode("镜头:中长焦")) === '{"name":"镜头","value":"中长焦"}');
ok("decode 取第一个冒号", F.decode("道具:伞:伞").value === "伞:伞");
ok("decode 无冒号返回 null", F.decode("低机位") === null);
ok("decode 冒号在首返回 null", F.decode(":值") === null);
ok("decode 冒号在尾返回 null", F.decode("镜头:") === null);
ok("validateValue 合法", F.validateValue("中长焦") === "");
ok("validateValue 空", F.validateValue("  ") !== "");
ok("validateValue 带全角括号", F.validateValue("广角（<35mm）") !== "");

console.log("=== 池子聚合 ===");
var pool = F.poolFromTags(["镜头:中长焦", "道具:透明雨伞", "道具:反光板", "道具:透明雨伞", "场景:老街", "坏标签", ""]);
console.log("  " + JSON.stringify(pool));
ok("只留非基础维度", pool.map(function (p) { return p.name; }).join(",") === "道具,场景");
ok("值去重且保持出现顺序", pool[0].values.join(",") === "透明雨伞,反光板");
ok("坏标签被跳过", pool.length === 2);

console.log("=== 提示词 ===");
var empty = F.buildPrompt();
var full = F.buildPrompt(pool);
console.log("  --- 空池子版 ---");
console.log(empty);
console.log("  --- 有池子版 ---");
console.log(full);
console.log("");
ok("空池子版不含「已有维度」节", empty.indexOf("【已有维度") < 0);
ok("空池子版不含「别硬套」句", empty.indexOf("硬套") < 0);
ok("有池子版含「已有维度」节", full.indexOf("【已有维度，优先复用】") >= 0);
ok("有池子版含「别硬套」句", full.indexOf("不要为了用上某个已有维度而硬套") >= 0);
ok("「别硬套」句位置跟着文档（在「自己开新维度」之后）",
  full.indexOf("【其他技术点：你自己开新维度】") < full.indexOf("不要为了用上某个已有维度而硬套"));
ok("池子值出现在提示词里", full.indexOf("道具：透明雨伞 / 反光板") >= 0);
ok("镜头那行带口径说明", full.indexOf("广角（<35mm）") >= 0);
ok("姿势那行带多选说明", full.indexOf("（可多选，用「/」隔开）") >= 0);
ok("维度行数 = 6", full.split("\n").filter(function (l) { return /^(镜头|时段|光线|视角|景别|姿势)：/.test(l); }).length === 6);
ok("buildPrompt 直接吃 tags 数组也行", F.buildPrompt(["道具:透明雨伞"]).indexOf("道具：透明雨伞") >= 0);
ok("空池子的提示词比有池子的短", empty.length < full.length);

console.log("=== 解析器 ===");

var r1 = F.parseReply("这是分析结果：\n```json\n{\"facets\":{\"镜头\":{\"v\":\"中长焦\",\"why\":\"背景压缩明显\"},\"姿势\":{\"v\":\"回眸/坐姿\",\"why\":\"\"}},\"tips\":[\"站远一点\",\"让模特离背景远些\"]}\n```\n希望有用！");
console.log("  " + JSON.stringify(r1.facets));
ok("剥围栏 + 剥前后废话", r1.ok === true && r1.facets.length === 3, JSON.stringify(r1.error));
ok("多值维度拆成两条", r1.facets.filter(function (f) { return f.name === "姿势"; }).length === 2);
ok("基础维度按 BASE 顺序", r1.facets[0].name === "镜头");
ok("known 为真", r1.facets[0].known === true);
ok("tips 两条", r1.tips.length === 2);

var r2 = F.parseReply("{\"facets\":{\"镜头\":\"长焦压缩\",\"道具\":{\"v\":\"透明雨伞\",\"why\":\"逆光成亮点\"}},\"tips\":\"注意光线\"}");
console.log("  " + JSON.stringify(r2.facets));
ok("偷懒形态（值是裸字符串）认", r2.ok === true && r2.facets.length === 2);
ok("值不在值域 → known 为假但不丢弃", r2.facets.filter(function (f) { return f.value === "长焦压缩"; })[0].known === false);
ok("AI 开的维度标 isNew", r2.facets.filter(function (f) { return f.name === "道具"; })[0].isNew === true);
ok("tips 是字符串也认", r2.tips.length === 1 && r2.tips[0] === "注意光线");
ok("追加维度排在基础维度后面", r2.facets[1].name === "道具");

var r3 = F.parseReply("{\"facets\":{\"镜头\":{\"v\":\"中长焦\"}}}");
ok("只给一个维度不报错", r3.ok === true && r3.facets.length === 1 && r3.tips.length === 0);

var r4 = F.parseReply("今天天气不错，我觉得这张拍得挺好。");
ok("不是 JSON → ok=false", r4.ok === false && r4.raw.length > 0, r4.error);
ok("失败时原文没被吞", r4.raw.indexOf("今天天气不错") >= 0);

var r5 = F.parseReply("{\"facets\":{},\"tips\":[]}");
ok("空 JSON → ok=false", r5.ok === false, r5.error);

var r6 = F.parseReply("{\"facets\":{\"道具\":{\"v\":\"透 明雨伞\",\"why\":\"逆光下成了亮点\"}}}");
ok("值里的空白被清掉", r6.facets[0].value === "透明雨伞", r6.facets[0].value);
ok("解析出的值能直接 encode", F.encode(r6.facets[0].name, r6.facets[0].value) === "道具:透明雨伞");

var r7 = F.parseReply("{\"facets\":{\"镜头\":{\"v\":\"f:2.8\"}}}");
ok("值里的冒号被清掉（否则编码会坏）", r7.facets[0].value === "f2.8" && F.encode("镜头", r7.facets[0].value) !== "", r7.facets[0].value);

var r8 = F.parseReply("{\"facets\":{\"镜头\":{\"v\":\"中长焦:f/2.8\"}}}");
ok("脏值不丢：含 / 会被当多值拆开，人工确认时能删", r8.facets.length === 2, JSON.stringify(r8.facets.map(function (f) { return f.value; })));

var r9 = F.parseReply("{\"facets\":{\"镜头\":{\"v\":\"广角（<35mm）\"}}}");
ok("值里带口径说明时 encode 会拒绝（界面据此提示）", F.encode("镜头", r9.facets[0].value) === "", r9.facets[0].value);

console.log("");
console.log("PASS " + pass + " / FAIL " + fail);
process.exit(fail ? 1 : 0);
