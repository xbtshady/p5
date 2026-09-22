/**
 * 新增照片页逻辑 —— 0.13 版（维度档位 + AI 闭环）
 *
 * 流程：
 *   1. 挂载前先查会话：没登录就跳登录页
 *   2. 选图 → 前端压缩（长边 1600px、WebP）→ 缩略图 + 体积对照
 *   3. AI 闭环：生成提示词 → 复制 → 连照片一起发给外部 AI → 把它回的 JSON 粘回来
 *      → 档位和技巧自动填好
 *   4. 扫一眼确认（不对的就点掉）→ 提交 → 上传 → 落库 → 回列表
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
 *    拦截放在确认界面（人看一眼就能改），不靠程序硬丢。
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

        /* ---- AI 闭环的状态（0.13） ---- */
        var promptText = ref("");   // 生成出来的提示词，放只读框里显示（复制失败时手动抄）
        var promptOpen = ref(false);
        var replyText = ref("");    // 用户粘进来的 AI 回复原文
        var replyOpen = ref(false);
        var replyBox = ref(null);   // 粘贴框，展开后自动聚焦
        var tips = ref([]);         // AI 给的技巧，回填后显示、可逐条删
        var whyText = ref("");      // AI 每条判断的依据，拼成一行给人工确认用
        var feedback = ref("");     // 灰字反馈（已复制 / 填了几个档位）

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

          if (promptOpen.value) {
            promptOpen.value = false;
            return;
          }

          promptText.value = P5F.buildPrompt(poolTags);
          promptOpen.value = true;

          var copied = false;
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(promptText.value);
              copied = true;
            }
          } catch (e) {
            console.warn("[P5] 复制失败:", e);
          }

          feedback.value = copied
            ? "已复制。把提示词和照片一起发给能看图的 AI，再把它回的 JSON 粘到下面。"
            : "没能自动复制，长按上面框里的文字手动复制。";
        }

        /**
         * 展开 / 收起粘贴区，展开后自动聚焦（省一次点击）。
         *
         * 为什么不去读剪贴板（navigator.clipboard.readText）：各端权限行为不一致，
         * 微信内置浏览器里基本拿不到；读失败还得再教一次怎么手动粘 ——
         * 不如一开始就让人自己粘，行为可预期。
         */
        function toggleReply() {
          if (busy.value) return;

          replyOpen.value = !replyOpen.value;
          if (!replyOpen.value) return;

          nextTick(function () {
            if (replyBox.value && replyBox.value.focus) replyBox.value.focus();
          });
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
            ? "已选 " + n + " 项，再点一下取消；拿不准的空着就行"
            : "拿不准的空着就行，不必每一项都填";
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
          }
        }

        return {
          files: files,
          file: upload,
          previewUrl: previewUrl,
          sizeText: sizeText,
          title: title,
          note: note,
          facetGroups: facetGroups,
          facets: facets,
          facetHint: facetHint,
          chipValues: chipValues,
          isLoose: isLoose,
          isOn: isOn,
          toggle: toggle,
          promptText: promptText,
          promptOpen: promptOpen,
          replyText: replyText,
          replyOpen: replyOpen,
          replyBox: replyBox,
          tips: tips,
          whyText: whyText,
          feedback: feedback,
          genPrompt: genPrompt,
          toggleReply: toggleReply,
          applyReply: applyReply,
          removeTip: removeTip,
          busy: busy,
          statusText: statusText,
          error: err,
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
