/**
 * 维度字典 + 提示词模板 + 回填解析器 —— 0.11 版
 *
 * 这个文件是「维度档位」这条线的底座，界面 / 提示词 / 校验三处读同一份：
 *   - 界面（0.12）：新增页的维度选择器，值只能从 valuesOf() 里挑
 *   - 提示词（0.13）：buildPrompt() 输出的那段，发给外部 AI
 *   - 校验：validateValue() / encode()，拦掉写不出合法编码的值
 * 所以改维度只改这里的 BASE，别处不要另抄一份值域。
 *
 * **纯函数，零依赖** —— 不碰 P5、不碰 DOM，可以在 node 里直接跑（用法见文件末注释）。
 *
 * 对外接口（window.P5Facets）：
 *   BASE                     基础维度定义（含值域），界面直接遍历它渲染
 *   UNCERTAIN                那个「不确定」，几个函数都要用
 *   isBase(name)             → bool
 *   valuesOf(name)           → string[] | null（非基础维度返回 null）
 *   encode(name, value)      → "镜头:中长焦"；不合法返回 ""
 *   decode(tag)              → {name, value} | null
 *   validateValue(value)     → "" | 一句中文原因（给界面做提示）
 *   fromTags(tags)           → [{name, value}] 编辑态（AI 结果也是这个形状）
 *   toTags(facets)           → string[] 写库用；编不出来的丢掉
 *   hasFacet(facets, n, v)   → bool（界面判断某个值有没有被选中）
 *   isMulti(name)            → bool（这个维度能不能多选）
 *   toggle(facets, n, v)     → 新的编辑态（点选 / 取消，单选维度自动顶掉旧值）
 *   poolFromTags(tags)       → [{name, values}]，只含非基础维度
 *   buildPrompt(existing)    → string，发给 AI 的完整提示词
 *   parseReply(text)         → {ok, facets, tips, error, raw}
 *
 * 编码为什么用「维度:值」：见 ARCHITECTURE.md §4.2。
 * 一句话 —— tags 是 text[]，「维度:值」复用 0.7 已经验证过的 GIN contains 路径，
 * 零迁移、维度可增删、多值维度（姿势）天然支持。
 * ⚠️ 冒号因此是保留字符：值里再冒出一个冒号，decode() 就会把维度拆错。
 */
(function () {
  var SEP = ":";

  /**
   * 值里不能出现的字符。两类理由叠加，都不是洁癖：
   *   - 云侧：SDK 的 contains() 是 tags.join(',') 直接拼串、不做转义，
   *     , { } [ ] ( ) " ' \ 会把 postgREST 的数组字面量拼坏
   *     （轻则筛不出结果，重则语义变成另一个查询，见 cloudbase.js 的标签一节）
   *   - 本地：cleanTags 把中英文逗号 / 顿号 / 分号 / 空白当分隔符，
   *     值里带这些会被切成两个标签；冒号是维度分隔符，带一个就拆错维度
   *
   * cleanTags 那边还有一道兜底（会截断），但被截断的编码是坏的 —— 所以在最前面拦死。
   *
   * 全角冒号和全角括号也拦：值里出现它们只可能是格式噪声（AI 把「维度：值」整串
   * 写进了 v，或者把口径说明写进了值），不可能是真的档位名。
   * 半角括号在 cloudbase.js 的 TAG_STRIP 里本来就被清掉，这里对全角保持同一条规则。
   */
  var RESERVED = /[{}\[\]()"'\\,:;，、；：（）\s]/;

  var UNCERTAIN = "不确定";

  /**
   * 基础维度。值域里的**值必须是「看一眼能分辨的档位」**，不是精确参数 ——
   * 从透视压缩、背景虚化形态能判断「大致落在哪一档」，判断不了「这支镜头 85mm」。
   * 收藏的图基本都是手机截图，EXIF 早被剥掉了，没有精确来源。
   *
   * gloss 只在提示词里当括号说明用（「广角（<35mm）」），
   * **库里存的永远是短词**（「广角」）—— 存成带括号的，按值筛选就废了。
   *
   * multi: true 表示这个维度可以多选（存成多个 tag：姿势:回眸 + 姿势:坐姿），
   * 只影响提示词措辞和 0.12 的界面行为，不影响编码。
   */
  var BASE = [
    {
      name: "镜头",
      values: ["广角", "标准", "中长焦", "长焦", UNCERTAIN],
      gloss: { "广角": "<35mm", "标准": "35–70mm", "中长焦": "70–135mm", "长焦": ">135mm" }
    },
    { name: "时段", values: ["清晨", "上午", "正午", "下午", "黄昏", "夜晚", "室内恒定光", UNCERTAIN] },
    { name: "光线", values: ["顺光", "侧光", "逆光", "顶光", "柔光", "硬光", UNCERTAIN] },
    { name: "视角", values: ["平视", "仰拍", "俯拍", UNCERTAIN] },
    { name: "景别", values: ["特写", "近景", "中景", "全身", "环境人像", UNCERTAIN] },
    {
      name: "姿势",
      values: ["面对镜头", "侧身", "回眸", "行走", "坐姿", "倚靠", "动态抓拍", UNCERTAIN],
      multi: true
    }
  ];

  var BASE_NAMES = BASE.map(function (f) {
    return f.name;
  });

  function defOf(name) {
    for (var i = 0; i < BASE.length; i++) {
      if (BASE[i].name === name) return BASE[i];
    }
    return null;
  }

  function isBase(name) {
    return BASE_NAMES.indexOf(String(name == null ? "" : name)) >= 0;
  }

  /** 基础维度的值域；非基础维度（AI 自己开的）返回 null —— 调用方据此决定要不要校验 */
  function valuesOf(name) {
    var d = defOf(name);
    return d ? d.values : null;
  }

  /* --------------------------------------------------------------------------
   * 编解码
   * -------------------------------------------------------------------------- */

  /**
   * 拼一个维度标签。**不合法就返回空串，不做静默清洗** ——
   * 清洗会掩盖上游的 bug（值里本该没有这些字符），宁可让调用方拿到空串去报错。
   * 清洗的活儿在写入唯一入口 cleanTags 那里，别处不重复一套。
   */
  function encode(name, value) {
    var n = String(name == null ? "" : name).trim();
    var v = String(value == null ? "" : value).trim();
    if (!n || !v) return "";
    if (RESERVED.test(n) || RESERVED.test(v)) return "";
    return n + SEP + v;
  }

  /**
   * 拆一个维度标签。拆不出来返回 null（没冒号 / 冒号位置不对）。
   * 按**第一个**冒号切：值里理论上不该有冒号，万一有也不能把维度名切乱。
   */
  function decode(tag) {
    var s = String(tag == null ? "" : tag);
    var i = s.indexOf(SEP);
    if (i <= 0 || i === s.length - 1) return null;
    return { name: s.slice(0, i), value: s.slice(i + 1) };
  }

  /** 值能不能用：返回空串表示可以，否则是一句能显示给人看的原因 */
  function validateValue(value) {
    var v = String(value == null ? "" : value).trim();
    if (!v) return "不能为空";
    if (RESERVED.test(v)) return "不能含空格、冒号或括号引号（全角半角都不行）";
    return "";
  }

  /* --------------------------------------------------------------------------
   * 编辑态
   *
   * 编辑态 = `[{name, value}]`，一条对应库里一条 tag —— **和 parseReply 的输出同一个形状**。
   * 所以「AI 返回的结构化数据」和「人在界面上点选」走的是同一套更新函数，
   * 0.13 接 AI 时只是多一个数据来源，不用另写一套。
   * -------------------------------------------------------------------------- */

  /** tags → 编辑态。拆不出来的（旧自由标签、脏数据）跳过，界面不显示 */
  function fromTags(tags) {
    return (Array.isArray(tags) ? tags : [])
      .map(function (t) {
        return decode(t);
      })
      .filter(function (d) {
        return !!d;
      });
  }

  /**
   * 编辑态 → tags（写库前用）。
   * encode 不通过的**丢掉** —— 宁可少一个档位，也不要一条坏编码进库。
   * 这里不去重同样的 name+value 之外的任何东西：每个维度的单选约束由 toggle 保证，
   * 数量上限由 cleanTags 兜底。
   */
  function toTags(facets) {
    var seen = Object.create(null);
    var out = [];

    (Array.isArray(facets) ? facets : []).forEach(function (f) {
      if (!f) return;
      var tag = encode(f.name, f.value);
      if (!tag || seen[tag]) return;
      seen[tag] = true;
      out.push(tag);
    });

    return out;
  }

  function hasFacet(facets, name, value) {
    var n = String(name == null ? "" : name);
    var v = String(value == null ? "" : value);

    return (Array.isArray(facets) ? facets : []).some(function (f) {
      return f && f.name === n && f.value === v;
    });
  }

  /**
   * 这个维度能不能多选。
   * 基础维度看定义（只有姿势是多选）；**6 个之外的维度都按多值处理** ——
   * 一个维度用过多少个值，本身就说明它允许多值。
   */
  function isMulti(name) {
    var d = defOf(name);
    return d ? !!d.multi : true;
  }

  /**
   * 点一个值：已选就取消，没选就加上。
   *
   * **单选维度会自动顶掉同维度的旧值** —— 「光线」不可能既是侧光又是逆光，
   * 留着两个只会让筛选出来的结果自相矛盾。
   * 数组顺序就是点选顺序，界面照着渲染即可。
   */
  function toggle(facets, name, value) {
    var list = Array.isArray(facets) ? facets.slice() : [];
    var n = String(name == null ? "" : name);
    var v = String(value == null ? "" : value);

    if (!n || !v) return list;

    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].name === n && list[i].value === v) {
        list.splice(i, 1);
        return list;
      }
    }

    if (!isMulti(n)) {
      list = list.filter(function (f) {
        return !f || f.name !== n;
      });
    }
    list.push({ name: n, value: v });
    return list;
  }

  /**
   * 从已有的 tags 里聚合出「非基础维度」的池子，给 buildPrompt 喂回去。
   *
   * 池子的唯一理由是**逼 AI 复用已有写法**：没有它，「透明雨伞」「雨伞」「长柄伞」
   * 会同时存在，按值筛选就散了 —— 而筛选正是这个库能不能用的前提。
   * 所以池子要连**值**一起给，只给维度名解决不了同义词问题。
   *
   * 用 Object.create(null) 而不是 {}：维度名万一叫 "constructor"，
   * {} 上的原型属性会让 hasOwnProperty 那类判断出岔（cloudbase.js 里踩过同款坑）。
   */
  function poolFromTags(tags) {
    var list = Array.isArray(tags) ? tags : [];
    var order = [];
    var byName = Object.create(null);

    list.forEach(function (tag) {
      var d = decode(tag);
      if (!d || isBase(d.name)) return;
      if (!byName[d.name]) {
        byName[d.name] = [];
        order.push(d.name);
      }
      if (byName[d.name].indexOf(d.value) < 0) byName[d.name].push(d.value);
    });

    return order.map(function (n) {
      return { name: n, values: byName[n] };
    });
  }

  /* --------------------------------------------------------------------------
   * 提示词
   *
   * 权威文本在 docs/PROMPT.md（连同每条措辞的理由）。这里落的是同一份内容，
   * 差别只有一处：**6 个维度那几行由 BASE 渲染**，不手写 ——
   * 提示词里的值域必须和界面能选的一模一样，手抄两份迟早漂。
   * 所以：值是 BASE 的权威，措辞是 PROMPT.md 的权威。
   * -------------------------------------------------------------------------- */

  var INTRO = [
    "你是摄影技术分析助手（多为人像）。我会发给你一张照片，请判断它是怎么拍出来的。",
    "",
    "我建这个库是为了以后拍照时查参考。我要的是**能复用到别的照片上的属性 / 技术特征**，",
    "不是对这张照片的文字描述：",
    "",
    "  可以：中长焦 / 逆光 / 回眸 / 透明雨伞 —— 别的照片也可能出现",
    "  不行：她在笑 / 海边的傍晚 / 氛围温馨 —— 只属于这一张，或者根本没法用来筛选"
  ].join("\n");

  /** 「必答的 N 个维度」那一块，行由 BASE 渲染 */
  function baseBlock() {
    var lines = BASE.map(function (f) {
      var text = f.values
        .map(function (v) {
          var g = f.gloss && f.gloss[v];
          return g ? v + "（" + g + "）" : v;
        })
        .join(" / ");
      return f.name + "：" + text + (f.multi ? "（可多选，用「/」隔开）" : "");
    });

    return ["【必答的 " + BASE.length + " 个维度】值只从列出的选项里选"]
      .concat("（我要靠这些值筛选照片，同一个意思写成两个词就散架了）", "", lines)
      .join("\n");
  }

  /** 「已有维度」那一块。**池子为空时整节不出现** —— 不留空标题让 AI 困惑 */
  function poolBlock(pool) {
    if (!pool.length) return "";

    return [
      "【已有维度，优先复用】",
      "下面是我库里已经用过的维度（" + BASE.length + " 个基础维度之外的）。",
      "**能对上的就沿用原来的写法**，不要为同一个意思造一个新词 —— 那会让我筛不到一起。",
      ""
    ]
      .concat(
        pool.map(function (p) {
          return p.name + "：" + p.values.join(" / ");
        })
      )
      .join("\n");
  }

  /**
   * 「别硬套」那句。位置跟着 PROMPT.md 走 —— 在「自己开新维度」那节之后，
   * 因为它收束的是前面两节：既别硬套池子里的旧维度，也别为了填满而硬开新维度。
   * 但它**只在池子非空时出现**：池子空的时候提「已有维度」纯属添乱。
   */
  function noStuffingBlock(pool) {
    if (!pool.length) return "";
    return "⚠️ 不要为了用上某个已有维度而硬套，只填你在这张照片里确实看到的。";
  }

  var EXTRA_BLOCK = [
    "【其他技术点：你自己开新维度】",
    "确实出现了上面没有、又对我以后拍照有参考价值的技术点，才新建维度 ——",
    "优先复用已有的，没有合适的再新增。维度和值都由你定，要求：",
    "维度名用简短名词（如「道具」「场景」「色调」），值要能复用到别的照片上。"
  ].join("\n");

  var TIPS_BLOCK = [
    "【再给我 1-3 条 tips】",
    "说明「下次想拍出类似效果，我需要注意什么」。",
    "每条都要具体可操作，不要写「注意光线」这种空话。"
  ].join("\n");

  var RULES_BLOCK = [
    "【规矩】",
    "- 拿不准就选「不确定」，不要硬猜，宁可空着也别编。",
    "- 单张照片无法可靠推断的精确拍摄参数（如精确焦距、光圈、快门、具体钟点），",
    "  不要猜测，也不要为了填写完整而新增这些参数维度；无法可靠判断就不输出。",
    "- 每个判断附一句依据，15 字以内。"
  ].join("\n");

  var OUTPUT_BLOCK = [
    "【输出】",
    "只输出 JSON，不要解释文字，不要代码围栏：",
    "",
    "{",
    '  "facets": {',
    '    "镜头": {"v": "中长焦", "why": "背景压缩明显"},',
    '    "时段": {"v": "下午", "why": "影子偏长"},',
    '    "光线": {"v": "侧光", "why": "面部明暗各半"},',
    '    "视角": {"v": "平视", "why": "相机与眼睛齐平"},',
    '    "景别": {"v": "环境人像", "why": "人物约占画面三分之一"},',
    '    "姿势": {"v": "回眸", "why": "身体背向、头回转"},',
    '    "道具": {"v": "透明雨伞", "why": "逆光下成了亮点"}',
    "  },",
    '  "tips": [',
    '    "站远一点、用长一点的焦段压缩背景",',
    '    "让模特离背景再远些，分离感会更强",',
    '    "逆光时测光点压在脸上，不然脸会黑"',
    "  ]",
    "}"
    // 示例里故意带一项「道具」：让 AI 看见「追加维度」长什么样，
    // 否则它只会照着 6 个基础维度抄一遍。
  ].join("\n");

  /**
   * 池子的三种入参形态都收：buildPrompt(tags) 直接喂 tags 数组也行，
   * 免得调用方每次自己先 poolFromTags 一遍。
   */
  function normalizePool(input) {
    if (!Array.isArray(input) || !input.length) return [];
    if (typeof input[0] === "string") return poolFromTags(input);

    return input
      .filter(function (p) {
        return p && p.name && Array.isArray(p.values) && p.values.length;
      })
      .map(function (p) {
        return { name: String(p.name), values: p.values.slice() };
      });
  }

  /** 拼出完整提示词。existing 可以省略（库为空时就是没有「已有维度」那节的版本） */
  function buildPrompt(existing) {
    var pool = normalizePool(existing);

    return (
      [
        INTRO,
        baseBlock(),
        poolBlock(pool),
        EXTRA_BLOCK,
        noStuffingBlock(pool),
        TIPS_BLOCK,
        RULES_BLOCK,
        OUTPUT_BLOCK
      ]
        .filter(function (s) {
          return !!s;
        })
        .join("\n\n") + "\n"
    );
  }

  /* --------------------------------------------------------------------------
   * 回填解析器
   *
   * 容错的四条（PROMPT.md「要求只输出 JSON，但解析器仍要容错」）：
   *   1. 剥代码围栏、连同前后的话一起剥掉
   *   2. tips 给成字符串也认
   *   3. **缺了某个维度就当没给**，不报错 —— 「不确定」是合法出口，缺项不是错误
   *   4. 值不在值域里**降级成自定义值，不丢弃**，只把 known 标成 false 交给人工看
   * 实在解析不出来就把原文原样放回 raw，让界面贴给人看，不静默吞掉。
   * -------------------------------------------------------------------------- */

  /** 剥掉 ```json ... ``` 围栏；没围栏就原样返回 */
  function stripFence(text) {
    var s = String(text == null ? "" : text).trim();
    var m = /```[a-zA-Z]*\s*([\s\S]*?)```/.exec(s);
    if (m && m[1].trim()) return m[1].trim();
    return s;
  }

  /** 取第一个 { 到最后一个 } 之间的部分，把 AI 前后多说的那几句挡在外面 */
  function extractJson(s) {
    var i = s.indexOf("{");
    var j = s.lastIndexOf("}");
    if (i < 0 || j <= i) return "";
    return s.slice(i, j + 1);
  }

  /**
   * 值的最小清洗：去冒号（会把维度拆错）、去 #（界面展示用的前缀，不入库）、
   * 去所有空白（cleanTags 把空白当分隔符，值里带空白会被切成两个标签）。
   * 只做这三件，不改写别的 —— 值长什么样由 AI 负责，对了错了都交给人工看。
   */
  function cleanValue(v) {
    return String(v == null ? "" : v)
      .replace(/[:#]/g, "")
      .replace(/\s+/g, "")
      .trim();
  }

  /** 多值维度 AI 可能写成 "回眸/坐姿"，也可能给数组 —— 两种都拆平 */
  function splitValues(v) {
    if (Array.isArray(v)) {
      return v.reduce(function (acc, x) {
        return acc.concat(splitValues(x));
      }, []);
    }
    return String(v == null ? "" : v)
      .split(/[\/／、,，;；]+/)
      .map(cleanValue)
      .filter(Boolean);
  }

  function cleanWhy(w) {
    return String(w == null ? "" : w).replace(/\s+/g, " ").trim().slice(0, 30);
  }

  /**
   * 解析 AI 回的那段文本。
   *
   * 返回：
   *   ok      true 表示拿到了可用的 facets / tips
   *   facets  [{name, value, why, known, isNew}] —— **每条一个值**，
   *           多值维度就是多条（姿势:回眸 + 姿势:坐姿），和库里存法一致
   *   tips    字符串数组
   *   error   失败时的一句中文说明
   *   raw     原文（失败时界面直接贴给人看）
   *
   * known = 值在基础值域里；isNew = 维度是 6 个之外的（AI 自己开的）。
   * 这两个标记是给 0.13 的确认界面用的：isNew 的归到「AI 补充」区，
   * known=false 的提示「AI 给的值不在选项里」，删不删由人看一眼决定。
   */
  function parseReply(text) {
    var raw = String(text == null ? "" : text);
    var out = { ok: false, facets: [], tips: [], error: "", raw: raw };

    var body = extractJson(stripFence(raw));
    if (!body) {
      out.error = "没找到 JSON，原始内容已贴回";
      return out;
    }

    var obj;
    try {
      obj = JSON.parse(body);
    } catch (e) {
      out.error = "JSON 解析失败，原始内容已贴回";
      return out;
    }
    if (!obj || typeof obj !== "object") {
      out.error = "JSON 不是一个对象，原始内容已贴回";
      return out;
    }

    var items = [];
    var seen = Object.create(null);
    var src = obj.facets;

    if (src && typeof src === "object" && !Array.isArray(src)) {
      Object.keys(src).forEach(function (rawName) {
        var name = String(rawName).trim();
        if (!name) return;

        var entry = src[rawName];
        var values = [];
        var why = "";

        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          // 标准形态 {"v": "中长焦", "why": "背景压缩明显"}
          why = cleanWhy(entry.why != null ? entry.why : entry.reason);
          values = splitValues(entry.v != null ? entry.v : entry.value);
        } else {
          // 偷懒形态："中长焦" / ["回眸", "坐姿"]
          values = splitValues(entry);
        }

        var domain = valuesOf(name);

        values.forEach(function (value) {
          var key = name + "\u0000" + value;
          if (seen[key]) return;
          seen[key] = true;

          items.push({
            name: name,
            value: value,
            why: why,
            known: !!(domain && domain.indexOf(value) >= 0),
            isNew: !isBase(name)
          });
        });
      });
    }

    // 基础维度按 BASE 的顺序排在前面，AI 追加的排后面 —— 人工扫一眼时顺序稳定
    items.sort(function (a, b) {
      var ai = isBase(a.name) ? BASE_NAMES.indexOf(a.name) : 99;
      var bi = isBase(b.name) ? BASE_NAMES.indexOf(b.name) : 99;
      return ai - bi;
    });

    var rawTips = obj.tips;
    var tips = [];
    if (typeof rawTips === "string") {
      tips = [rawTips.replace(/\s+/g, " ").trim()].filter(Boolean);
    } else if (Array.isArray(rawTips)) {
      tips = rawTips
        .map(function (t) {
          return String(t == null ? "" : t).replace(/\s+/g, " ").trim();
        })
        .filter(Boolean);
    }

    if (!items.length && !tips.length) {
      out.error = "JSON 里没有 facets / tips，原始内容已贴回";
      return out;
    }

    out.ok = true;
    out.facets = items;
    out.tips = tips;
    return out;
  }

  window.P5Facets = {
    BASE: BASE,
    UNCERTAIN: UNCERTAIN,
    isBase: isBase,
    valuesOf: valuesOf,
    encode: encode,
    decode: decode,
    validateValue: validateValue,
    fromTags: fromTags,
    toTags: toTags,
    hasFacet: hasFacet,
    isMulti: isMulti,
    toggle: toggle,
    poolFromTags: poolFromTags,
    buildPrompt: buildPrompt,
    parseReply: parseReply
  };
})();

/* 想在 node 里试一把（这个文件零依赖，把 window 补上就行）：
 *
 *   node -e '
 *     global.window = {};
 *     require("./js/facets.js");
 *     const F = window.P5Facets;
 *     console.log(F.buildPrompt(F.poolFromTags(["道具:透明雨伞", "镜头:中长焦"])));
 *     console.log(F.parseReply("```json\n{\"facets\":{\"镜头\":{\"v\":\"中长焦\"}}}\n```"));
 *   '
 */
