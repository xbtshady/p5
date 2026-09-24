/**
 * 新增照片页逻辑 —— 0.19d 版（AI 闭环合成一条流 + 单选维度就地展开）
 *
 * 流程：
 *   1. 挂载前先查会话：没登录就跳登录页
 *   2. 选图 → 前端压缩（长边 1600px、WebP）→ 缩略图 + 体积对照
 *   3. AI 闭环：生成提示词并复制 → 连照片一起发给外部 AI → 把它回的 JSON 粘回来
 *      → 粘上就自动填好档位和技巧
 *   4. 扫一眼确认（不对的就点掉）→ 提交 → 上传 → 落库 → 回列表
 *
 * 0.19c 的结构（REDESIGN §3.3）：
 *   - 页面拆成三个可折叠分组：基本信息（默认展开）/ 档位 / AI 技巧（都默认折叠）
 *   - 多选维度（姿势）和 AI 追加维度是胶囊 —— 判据直接用 P5Facets.isMulti，
 *     别在这里另写一份「哪几个是单选」的名单（改字典时两边会不一致）
 *   - 保存按钮移到底部固定条（在 HTML 里，这里只管 busy / 禁用态）
 *
 * 0.19d 的两处交互精简（起因是「点得太多了」）：
 *   - AI 那段从「生成提示词 / 粘贴回填 / 解析并填入」三颗键收成一颗主键：
 *     点一次 = 复制 + 露出粘贴框，粘贴由 onPaste 直接接管并回填。
 *     提示词只读框默认不展开 —— 那段文字是要复制的，不是要读的
 *   - 5 个单选维度从「点行 → 底部选择器 → 点确认」（3 次触碰）改成
 *     「点行 → 点值」（2 次），展开在行下面，遮罩不再挡着维度名和已选值。
 *     代价是没了 picker 的「不填」出口，改由「再点一次选中的值 = 取消」承担
 *     （P5Facets.toggle 本来就是这语义，和姿势胶囊、首页筛选一致）
 *
 * 三条硬约定：
 *   - 上传失败绝不落库。宁可报错让用户重试，也不要留下一条指向不存在文件的记录。
 *   - 失败原因一律显示出来，不静默吞掉。
 *   - ⚠️ 页面上所有 van-* 组件必须写完整闭合标签（<van-field></van-field>）。
 *     HTML 不认自定义标签的自闭合，写成 <van-field /> 会把后面所有同级组件
 *     吞成它的子元素，表现为「写了好几个只渲染出一个」。原生 void 元素
 *     （img / input）不受影响。
 *
 * AI 闭环为什么是剪贴板：站里不接 AI —— 没有后端成本，也没有密钥要管
 * （PRODUCT-1.0.md §3.5）。将来 1.5 站内直连时换掉的只有「复制 / 粘贴」这两步，
 * buildPrompt / parseReply 原样复用，现在做的不算弯路。
 *
 * ⚠️ 回填**不自动入库**：解析结果先铺到界面上，人点了保存才算数。
 *    AI 会错，而错标签比没标签更坏 —— 会把参考库污染成「你以为自己是中长焦拍的」。
 *    拦截放在确认界面（人看一眼就能改），不靠程序硬丢。所以回填成功后
 *    **自动展开档位组和技巧组**：折叠着就等于没让人看见。
 *
 * 档位这件事和 js/facets.js 怎么分工（别越界）：
 *   - **页面不写死任何值域**：有哪些维度、每个维度有哪些值，全从 P5Facets.BASE 来。
 *     改维度只改那份字典，界面和提示词自动跟着变
 *   - 点选 / 取消 / 单选顶替的规则在 P5Facets.toggle，页面只管调它
 *   - 编辑态是 [{name, value}]，**和 AI 回填（parseReply）的输出同一个形状** ——
 *     回填就是把结构化数据喂进同一套更新函数
 *   - 回填的合并规则（按维度覆盖、单选维度只留一个值）在 P5Facets.applyFacets
 *   - 写库前先过 P5Facets.toTags，再交给 P5.createPhoto（后者还会过 cleanTags ——
 *     那是写入的唯一入口，别在页面里另写一套清洗）
 */
(function () {
  var boot = document.getElementById("boot");

  function bootFail(msg) {
    if (boot) boot.innerHTML = '<span class="error">' + msg + "</span>";
  }

  // CDN 偶发不可达时的兜底提示，避免永远停在「载入中…」
  if (typeof Vue === "undefined") {
    bootFail("Vue 加载失败，请检查网络后刷新");
    return;
  }
  if (typeof vant === "undefined") {
    bootFail("组件库加载失败，请检查网络后刷新");
    return;
  }
  if (typeof imageCompression === "undefined") {
    bootFail("图片压缩库加载失败，请检查网络后刷新");
    return;
  }
  if (!window.P5Facets) {
    bootFail("维度字典加载失败，请检查网络后刷新");
    return;
  }

  var createApp = Vue.createApp;
  var ref = Vue.ref;
  var computed = Vue.computed;
  var nextTick = Vue.nextTick;
  var P5 = window.P5 || {};
  var P5F = window.P5Facets;

  // 长边 1600px 足够看清构图，又不至于把流量耗在像素上
  var MAX_EDGE = 1600;
  var QUALITY = 0.85;

  /**
   * 基础维度分组，直接就是字典里的那 6 个。
   *
   * 单选还是多选不在这里判断 —— 那是 P5Facets.toggle 的事，这里只负责显示个提示，
   * 免得用户不知道「姿势」能选好几个。
   * 真正渲染用的分组是 setup 里的 facetGroups（这份 + 库里已有的追加维度 + 回填新出现的）。
   */
  var BASE_GROUPS = P5F.BASE.map(function (f) {
    return {
      name: f.name,
      values: f.values,
      label: f.multi ? f.name + "（可多选）" : f.name
    };
  });

  /** 取扩展名，决定桶里的文件名后缀 */
  function extOf(file) {
    var m = /\.([a-z0-9]+)$/i.exec(file.name || "");
    return m ? m[1].toLowerCase() : "webp";
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  async function bootstrap() {
    var user = null;
    var error = "";

    try {
      user = await P5.getCurrentUser();
    } catch (e) {
      error = e.message || String(e);
    }

    if (!error && !user) {
      // 未登录，或会话已失效 —— 回登录页
      location.replace("login.html");
      return;
    }

    /**
     * 库里已有的标签，两处要用：
     *   - buildPrompt（0.13）：喂给 AI 当「已有维度，优先复用」的池子 ——
     *     逼它沿用已有的写法，别为同一个意思造新词（造了按值筛选就散了）
     *   - extraGroups：其中非基础维度那些（道具 / 场景…），当可点选的追加维度显示
     * 拿不到不该挡住新增：基础 6 个照常可用，所以这里只 warn 不报错。
     */
    var poolTags = [];
    var extraGroups = [];

    try {
      var counts = await P5.listTagCounts();
      poolTags = counts.map(function (c) {
        return c.tag;
      });
      extraGroups = P5F.poolFromTags(poolTags).map(function (p) {
        return { name: p.name, values: p.values, label: p.name };
      });
    } catch (pe) {
      console.warn("[P5] 已有维度读取失败，只显示基础维度:", pe);
    }

    var app = createApp({
      setup: function () {
        // van-uploader 自己管的列表（负责显示缩略图）
        var files = ref([]);
        // 压缩之后、真正要传上桶的那一份
        var upload = ref(null);
        var previewUrl = ref("");
        var sizeText = ref("");
        var title = ref("");
        var note = ref("");
        // 已选档位，[{name, value}]。数组顺序就是点选顺序，界面照着渲染
        var facets = ref([]);
        var busy = ref(false);
        var statusText = ref("保存中…");
        var err = ref(error);
        // 错误提示那个节点的引用（0.19c）。底部固定保存条会盖住页面下沿，
        // 出错时得主动把这行提示滚进视野，否则表现就是「点了保存没反应」
        var errBox = ref(null);

        /* ---- AI 闭环的状态（0.13） ---- */
        var promptText = ref("");   // 生成出来的提示词，放只读框里显示（复制失败时手动抄）
        var promptOpen = ref(false);
        // 生成过一次之后主按钮换成「重新复制提示词」（0.19d）：这颗键是幂等的，
        // 文案跟着状态走，人才知道再点一次不会出事
        var promptDone = ref(false);
        var replyText = ref("");    // 用户粘进来的 AI 回复原文
        var replyOpen = ref(false);
        var replyBox = ref(null);   // 粘贴框，解析失败时把光标放回去让人改
        var tips = ref([]);         // AI 给的技巧，回填后显示、可逐条删
        var whyText = ref("");      // AI 每条判断的依据，拼成一行给人工确认用
        var feedback = ref("");     // 灰字反馈（已复制 / 填了几个档位）

        /* ---- 折叠分组（0.19c） ----
         * 只有「展开 / 收起」这一个状态，内容一律留在 DOM 里（v-show）：
         * 切换分组不该丢已经填了一半的标题、描述、档位。
         * 默认只展开基本信息 —— 打开页面第一眼是「选照片」，不是一堆档位胶囊。 */
        var open = ref({ basic: true, facets: false, tips: false });

        function toggleGroup(key) {
          open.value[key] = !open.value[key];
        }

        /* ---- 单选维度的就地展开（0.19d） ---- */

        /**
         * 展开中的那一行（手风琴：同时只开一个）。
         *
         * 为什么不是各开各的：核对时本来就是一次看一个维度，而且这样一来
         * 「展开态」的页面高度上限就固定成一行 —— 改五个维度也不会越拉越长。
         */
        var expandedFacet = ref("");

        function toggleFacet(name) {
          if (busy.value) return;
          expandedFacet.value = expandedFacet.value === name ? "" : name;
        }

        /**
         * 点展开区里的一个值。
         *
         * 选中后**收起这一行**：动作到此闭环（展开 → 点 → 收），反馈也没丢 ——
         * 收起后上面那一行的值会当场变成刚选的。
         * 取消（点已选中的值）时反过来留着展开：人通常是要接着换个别的值。
         *
         * 单选维度点新值会顶掉旧值、再点取消，规则全在 P5Facets.toggle，
         * 这里不重复一遍 —— 重复了迟早两边不一致。
         */
        function pickFacet(name, value) {
          if (busy.value) return;

          var wasOn = P5F.hasFacet(facets.value, name, value);
          facets.value = P5F.toggle(facets.value, name, value);
          err.value = "";
          if (!wasOn) expandedFacet.value = "";
        }

        /**
         * 选完图（van-uploader 的 after-read）：
         * 压缩 → 记下要上传的文件 → 给缩略图换上压缩后的图。
         *
         * 为什么要把 entry.content 清掉：Vant 读出文件后会把原图 base64 塞进
         * content 当预览，优先级是 url > content。不清掉的话，缩略图显示的是
         * 原图，而实际上传的是压缩后的，两回事。
         */
        async function onRead(item) {
          // max-count=1 时是单个对象，保险起见兼容数组
          var entry = Array.isArray(item) ? item[0] : item;
          var picked = entry && entry.file;
          if (!picked) return;

          err.value = "";
          busy.value = true;
          statusText.value = "处理中…";

          try {
            if (!/^image\//.test(picked.type)) {
              throw new Error("请选择图片文件");
            }

            var out = picked;
            try {
              out = await imageCompression(picked, {
                maxWidthOrHeight: MAX_EDGE,
                useWebWorker: true,
                fileType: "image/webp",
                initialQuality: QUALITY
              });
            } catch (ce) {
              // 压缩失败不该挡住上传，退回原图继续
              console.warn("[P5] 压缩失败，改用原图:", ce);
              out = picked;
            }

            if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);

            upload.value = out;
            previewUrl.value = URL.createObjectURL(out);
            sizeText.value = fmtSize(picked.size) + " → " + fmtSize(out.size);

            entry.url = previewUrl.value;
            entry.content = "";
          } catch (e2) {
            upload.value = null;
            previewUrl.value = "";
            sizeText.value = "";
            err.value = e2.message || String(e2);
            // 不是图片就从上传框里撤掉，别留着让人以为选好了
            files.value = [];
          } finally {
            busy.value = false;
            statusText.value = "保存中…";
          }
        }

        /** 删掉已选的图（van-uploader 的 after-delete） */
        function onDelete() {
          if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
          upload.value = null;
          previewUrl.value = "";
          sizeText.value = "";
          err.value = "";
          return true;
        }

        /* ---------------- AI 闭环（0.13） ----------------
         * 站里不接 AI：点「生成提示词」复制，连照片一起发给外部 AI，
         * 把它回的 JSON 粘回来 → 自动填档位和技巧。
         * 将来 1.5 站内直连时，替换的只有这两步，buildPrompt / parseReply 原样复用。
         * 提示词正文和每条措辞的理由在 docs/PROMPT.md。
         * --------------------------------------------------- */

        /**
         * 生成提示词并复制。
         *
         * 池子喂的是**库里已有的全部标签**（基础维度那些会被 buildPrompt 自己滤掉）：
         * 把用过的写法还给 AI，它才会沿用而不是另造同义词 —— 造了按值筛选就散了。
         *
         * 复制失败**不是错**：提示词已经显示在下面的只读框里，长按手动复制即可。
         * 用 navigator.clipboard 而不是 execCommand —— 线上是 https，
         * 前者可靠，也不用往页面里塞一个隐藏的 textarea。
         */
        async function genPrompt() {
          if (busy.value) return;

          err.value = "";
          feedback.value = "";

          promptText.value = P5F.buildPrompt(poolTags);
          promptDone.value = true;

          var copied = false;
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(promptText.value);
              copied = true;
            }
          } catch (e) {
            console.warn("[P5] 复制失败:", e);
          }

          // 提示词框只在「没抄到」的时候自动展开 —— 那一刻手抄是唯一的出路。
          // 复制成功就不展开：这段文字占 6 行，而它本来也不是给人读的
          promptOpen.value = !copied;

          // 露出粘贴框，人从 AI 那边切回来就能直接粘。
          // ⚠️ 不聚焦：这会儿人是要去切 app 的，弹键盘只会挡住正要发出去的照片
          replyOpen.value = true;

          feedback.value = copied
            ? "提示词已复制。和照片一起发给能看图的 AI，再把它回的 JSON 粘到下面 —— 粘上就自动填。"
            : "没能自动复制，上面展开的框里就是提示词，长按手动复制，再把它回的 JSON 粘到下面。";
        }

        /** 手动展开 / 收起提示词框（它默认收着，这是「我自己想核对一遍」的入口） */
        function togglePrompt() {
          if (busy.value) return;
          promptOpen.value = !promptOpen.value;
        }

        /**
         * 粘贴即回填（0.19d）。
         *
         * 原来这条路是「点粘贴回填 → 点框 → 粘 → 点解析并填入」，四次触碰才完成
         * 一个动作。paste 事件里能直接拿到剪贴板文本，所以粘完就能填。
         *
         * 拿不到 clipboardData 就 return，让浏览器走默认粘贴（v-model 照样更新）——
         * 下面那颗「没自动填上就点这里」是给这条降级路径留的。
         * 读不到剪贴板在各端是常态而不是异常（微信内置浏览器基本拿不到），
         * 别把兜底那颗键当死代码删掉。
         *
         * 为什么不干脆监视输入自动解析：解析失败要报错，而「边打字边报错」比
         * 多点一次烦人得多。粘贴是一次明确的完成动作，只认它。
         */
        function onPaste(e) {
          var dt = e.clipboardData || window.clipboardData;
          var text = dt && dt.getData ? dt.getData("text") : "";

          if (!text || !text.trim()) return;

          // 手动接管：preventDefault 之后浏览器不会再触发 input，
          // 值由这里写一次，免得同一段文本进来两遍
          e.preventDefault();
          replyText.value = text;
          applyReply();
        }

        function removeTip(i) {
          var list = tips.value.slice();
          list.splice(i, 1);
          tips.value = list;
        }

        /**
         * 解析粘进来的回复并回填。
         *
         * 解析失败时**原文留在框里、框不收起**，只报一句原因 ——
         * 让人改一处就能重试，不必回 AI 那边再复制一遍。
         */
        function applyReply() {
          if (busy.value) return;

          err.value = "";
          feedback.value = "";

          if (!replyText.value.trim()) {
            err.value = "先把 AI 回的 JSON 粘进来";
            return;
          }

          var res = P5F.parseReply(replyText.value);

          if (!res.ok) {
            err.value = res.error;
            // 把光标放回框里，让人就地改那一处再试（不用再点一次框）。
            // 原文此刻仍留在框里（下面不收起），所以只报错、不丢内容
            nextTick(function () {
              if (replyBox.value && replyBox.value.focus) replyBox.value.focus();
            });
            return;
          }

          // 档位：按维度合进现有编辑态（AI 没提到的维度不动，单选维度只留一个值）
          facets.value = P5F.applyFacets(facets.value, res.facets);

          // 技巧：整批替换。回填代表「这一轮分析的结果」，不该和上一轮的叠在一起
          var max = (P5.tipsLimit && P5.tipsLimit().max) || 3;
          tips.value = res.tips.slice(0, max);

          // AI 每条的判断依据拼成一行：人工确认全靠它判断该不该留（PROMPT 里 why 的用途）
          whyText.value = res.facets
            .filter(function (f) {
              return f.why;
            })
            .map(function (f) {
              return f.name + ":" + f.value + "（" + f.why + "）";
            })
            .join(" · ");

          var n = res.facets.length;
          var loose = res.facets.filter(function (f) {
            return f.isNew || !f.known;
          }).length;

          var msg = "填好 " + n + " 个档位";
          if (tips.value.length) msg += "、" + tips.value.length + " 条技巧";
          if (res.tips.length > max) {
            msg += "（AI 给了 " + res.tips.length + " 条，只留了前 " + max + " 条）";
          }
          msg += "。扫一眼再保存";
          if (loose) msg += "；带圆点的是 AI 自己定的值，不对就点掉";

          feedback.value = msg;
          replyOpen.value = false;

          // 回填成功后自动展开这两组（0.19c）。
          // 理由不是「方便」而是「不展开就等于没确认」：档位和技巧都要人扫一眼、
          // 点掉不对的才算数（回填**不自动入库**），折叠着人根本看不见。
          // 技巧一条都没有就不展开了 —— 展开一个空组只是噪音，摘要上「未填」已够。
          open.value.facets = true;
          if (tips.value.length) open.value.tips = true;
        }

        /* ---------------- 档位 ---------------- */

        /**
         * 界面上要显示的分组 = 6 个基础 + 库里已有的追加维度 + **本次回填新出现的维度**。
         *
         * 最后那类是 AI 自己开的（PRODUCT §3.4：维度只由 AI 产生），此刻还没入库；
         * 不在这里补上，就会出现「值被选中了却看不见、也点不掉」。
         *
         * known 用 Object.create(null)：维度名万一叫 "constructor"，
         * {} 上的原型属性会让判断直接为真（cloudbase.js 里踩过同款坑）。
         */
        var facetGroups = computed(function () {
          var groups = BASE_GROUPS.concat(extraGroups);
          var known = Object.create(null);

          groups.forEach(function (g) {
            known[g.name] = true;
          });

          facets.value.forEach(function (f) {
            if (!f || known[f.name]) return;
            known[f.name] = true;
            // 候选先留空，AI 给的那个值由 chipValues 补上
            groups.push({ name: f.name, values: [], label: f.name });
          });

          return groups;
        });

        /**
         * 单选维度走「一行一个 + 弹层」，多选维度走胶囊。
         *
         * 判据直接用 P5F.isMulti —— 它对 6 个基础维度查字典（只有姿势是多选），
         * **对 6 个之外的维度一律返回 true**。所以 AI 追加的维度（道具 / 场景…）
         * 自动落到胶囊那一边，正好是 REDESIGN §3.3 要的「只有多选维度和 AI 追加维度
         * 保留胶囊」，不需要在这里另列一份名单。
         *
         * 页面里绝不能写死「镜头 / 时段 / 光线 / 视角 / 景别 是单选」——
         * 那份名单在 facets.js，改字典时这里不用动。
         */
        var singleGroups = computed(function () {
          return facetGroups.value.filter(function (g) {
            return !P5F.isMulti(g.name);
          });
        });

        var multiGroups = computed(function () {
          return facetGroups.value.filter(function (g) {
            return P5F.isMulti(g.name);
          });
        });

        /**
         * 某个维度当前选中的值，给单选行显示用。
         * 单选维度正常只会有一个值；万一编辑态里出现两个（手点 + 回填交错），
         * 取第一个显示 —— 摘要那一行会把全部列出来，不会被吞掉。
         */
        function pickedValue(name) {
          var hit = facets.value.filter(function (f) {
            return f && f.name === name;
          });

          return hit.length ? hit[0].value : "";
        }

        /**
         * 一个维度该显示哪些值：候选（字典 / 池子）在前，**编辑态里不在候选中的值接在后**。
         *
         * 后者是 AI 自己定的（判错的值、或新维度里新建的值）。不能让它隐形 ——
         * 隐形就点不掉，而它照样会被 toTags 写进库。
         * 带个圆点标出来，「人工确认」那一步就靠这些标记和上面那行依据。
         */
        function chipValues(g) {
          var out = g.values.slice();

          facets.value.forEach(function (f) {
            if (f && f.name === g.name && out.indexOf(f.value) < 0) out.push(f.value);
          });

          return out;
        }

        /** 值是不是「不在候选里」（决定要不要带圆点） */
        function isLoose(g, val) {
          return g.values.indexOf(val) < 0;
        }

        function isOn(name, value) {
          return P5F.hasFacet(facets.value, name, value);
        }

        /**
         * 点一个值：已选就取消，没选就加上。
         * 单选维度（6 个里除了姿势都是）点新值会自动顶掉旧值 —— 规则在 facets.js 里，
         * 这里不重复一遍，否则两边迟早不一致。
         */
        function toggle(name, value) {
          if (busy.value) return;

          facets.value = P5F.toggle(facets.value, name, value);
          err.value = "";
        }

        var facetHint = computed(function () {
          var n = facets.value.length;
          return n
            ? "已选 " + n + " 项，再点一下选中的值就是取消；拿不准的空着就行"
            : "点一行展开候选值。拿不准的空着就行，不必每一项都填";
        });

        /* ---- 折叠组头部的摘要（0.19c） ----
         * 用途是「不用展开也知道填了什么」（REDESIGN §5.3）。
         * 宽度只有一行的余量，超长由 CSS 省略号处理，这里不做截断 ——
         * 截断会让「已选 3 项」变成「已选 3 项…」这种看起来像出错的文案。 */

        var basicSummary = computed(function () {
          if (title.value) return title.value;
          return upload.value ? "已选照片，还没写标题" : "还没选照片";
        });

        var facetSummary = computed(function () {
          if (!facets.value.length) return "未填";

          return facets.value
            .map(function (f) {
              return f.value;
            })
            .join(" / ");
        });

        var tipsSummary = computed(function () {
          return tips.value.length ? tips.value.length + " 条" : "未填";
        });

        async function submit() {
          if (busy.value) return;

          busy.value = true;
          statusText.value = "上传中…";
          err.value = "";

          try {
            if (!upload.value) throw new Error("还没选照片");

            var path = await P5.uploadPhoto(upload.value, extOf(upload.value));

            // 顺序很重要：上传成功了才落库。
            // 反过来的话，上传一旦失败就会留下一条指向不存在文件的记录。
            statusText.value = "保存中…";
            await P5.createPhoto({
              storagePath: path,
              title: title.value,
              note: note.value,
              tags: P5F.toTags(facets.value),
              aiTips: tips.value
            });

            location.replace("index.html");
          } catch (e) {
            err.value = e.message || String(e);
            busy.value = false;
            statusText.value = "保存中…";

            // 提示行在表单最下方、又紧挨着底部固定条，不滚一下是看不见的。
            // 等一帧再滚：err 刚改，那个 <p v-if="error"> 还没挂上，此刻 errBox 仍是 null
            nextTick(function () {
              if (errBox.value && errBox.value.scrollIntoView) {
                errBox.value.scrollIntoView({ block: "center" });
              }
            });
          }
        }

        return {
          files: files,
          file: upload,
          previewUrl: previewUrl,
          sizeText: sizeText,
          title: title,
          note: note,
          facets: facets,
          facetHint: facetHint,
          /* ---- 0.19c：折叠分组 ---- 0.19d：单选维度就地展开 ----
           * facetValue 就是内部的 pickedValue：模板里叫 valueOf 会和
           * Object.prototype.valueOf 撞脸（这次没出事，但没人愿意下次再赌一把） */
          open: open,
          toggleGroup: toggleGroup,
          singleGroups: singleGroups,
          multiGroups: multiGroups,
          facetValue: pickedValue,
          basicSummary: basicSummary,
          facetSummary: facetSummary,
          tipsSummary: tipsSummary,
          expandedFacet: expandedFacet,
          toggleFacet: toggleFacet,
          pickFacet: pickFacet,
          chipValues: chipValues,
          isLoose: isLoose,
          isOn: isOn,
          toggle: toggle,
          promptText: promptText,
          promptOpen: promptOpen,
          promptDone: promptDone,
          replyText: replyText,
          replyOpen: replyOpen,
          replyBox: replyBox,
          tips: tips,
          whyText: whyText,
          feedback: feedback,
          genPrompt: genPrompt,
          togglePrompt: togglePrompt,
          onPaste: onPaste,
          applyReply: applyReply,
          removeTip: removeTip,
          busy: busy,
          statusText: statusText,
          error: err,
          errBox: errBox,
          onRead: onRead,
          onDelete: onDelete,
          submit: submit
        };
      }
    });

    // 注册 Vant 组件。⚠️ 漏掉这步**不会报错** —— Vue 只会把 van-* 当成未识别的
    // 自定义标签原样留在 DOM 里：页面「什么都没显示」，控制台却干干净净，很难查。
    app.use(vant);
    app.mount("#app");

    // 挂载完成（v-cloak 已移除），撤掉启动占位层
    if (boot) boot.remove();
  }

  bootstrap();
})();
