/**
 * 新增照片页逻辑 —— 0.8 版（加上标签）
 *
 * 流程：
 *   1. 挂载前先查会话：没登录就跳登录页
 *   2. 选图 → 前端压缩（长边 1600px、WebP）→ 缩略图 + 体积对照
 *   3. 选标签：预置清单点选 + 输入框加自定义，选中的才提交
 *   4. 提交 → 上传到私有桶 {uid}/xxx → 落库 → 回列表
 *
 * 三条硬约定：
 *   - 上传失败绝不落库。宁可报错让用户重试，也不要留下一条指向不存在文件的记录。
 *   - 失败原因一律显示出来，不静默吞掉。
 *   - ⚠️ 页面上所有 van-* 组件必须写完整闭合标签（<van-field></van-field>）。
 *     HTML 不认自定义标签的自闭合，写成 <van-field /> 会把后面所有同级组件
 *     吞成它的子元素，表现为「写了好几个只渲染出一个」。原生 void 元素
 *     （img / input）不受影响。
 *
 * 标签的两个约定：
 *   - 归一化一律走 P5.cleanTags，**不在页面里自己写一套**。
 *     它同时管着「写库」和「按标签查询」两条路（SDK 拼 cs.{a,b} 不转义），
 *     分成两份迟早会漂。见 js/cloudbase.js 的标签一节。
 *   - 上限（单个 12 字、最多 6 个）从 P5.tagLimits() 读，不在这里抄数字。
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

  var createApp = Vue.createApp;
  var ref = Vue.ref;
  var computed = Vue.computed;
  var P5 = window.P5 || {};

  // 长边 1600px 足够看清构图，又不至于把流量耗在像素上
  var MAX_EDGE = 1600;
  var QUALITY = 0.85;

  /**
   * 预置标签，按维度分两组。
   *
   * 为什么要预置：标签一旦自由发散，「低机位」「低角度」「仰拍」会同时存在，
   * 三个标签指同一件事 —— 参考库最怕的就是这个，翻的时候对不上。
   * 预置清单负责把词汇收敛住，自定义留给出乎清单之外的东西。
   *
   * 1.5 会把这两组拆成 techTags / topicTags 两个字段，那时这里的结构不用改，
   * 直接把组名映射到字段名即可（见 PRODUCT-1.0.md §八）。
   */
  var PRESET_GROUPS = [
    { name: "技法", tags: ["构图", "角度", "光线", "色彩", "姿势", "镜头"] },
    { name: "题材", tags: ["环境人像", "室内", "夜景", "街拍", "场景"] }
  ];

  var PRESET_ALL = PRESET_GROUPS.reduce(function (acc, g) {
    return acc.concat(g.tags);
  }, []);

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
        // 已选标签。数组顺序就是点选顺序，界面直接照着渲染
        var tags = ref([]);
        // 自定义标签输入框里的草稿
        var draft = ref("");
        var busy = ref(false);
        var statusText = ref("保存中…");
        var err = ref(error);

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

        /* ---------------- 标签 ---------------- */

        var LIMITS = (P5.tagLimits && P5.tagLimits()) || { len: 12, count: 6 };

        var full = computed(function () {
          return tags.value.length >= LIMITS.count;
        });

        // 只把「不在预置清单里」的挑出来单独一行。
        // 预置标签是原地开关的（在它自己那组里高亮），不在这里重复列一份。
        var customTags = computed(function () {
          return tags.value.filter(function (t) {
            return PRESET_ALL.indexOf(t) < 0;
          });
        });

        var tagPlaceholder = computed(function () {
          return full.value ? "已达上限" : "请输入标签";
        });

        var tagHint = computed(function () {
          var base =
            "已选 " + tags.value.length + " / " + LIMITS.count +
            "，单个标签最多 " + LIMITS.len + " 字";
          if (full.value) return base + "（已满，先取消一个再加）";
          return base;
        });

        function isSelected(t) {
          return tags.value.indexOf(t) >= 0;
        }

        /** 预置标签的开关 */
        function toggle(t) {
          if (busy.value) return;

          tags.value = isSelected(t)
            ? tags.value.filter(function (x) {
                return x !== t;
              })
            : P5.cleanTags(tags.value.concat(t));

          err.value = "";
        }

        /**
         * 加一个自定义标签。
         * 直接把草稿整串丢给 cleanTags —— 它负责按 , ， 、 ; 空格 切开，
         * 所以用户一次打「低机位, 逆光」会变成两个标签，不会变成一个带逗号的。
         * 顺便它也会把 # 前缀和 { } 引号之类的危险字符清掉。
         */
        function addCustom() {
          if (busy.value || full.value) return;

          var raw = draft.value;
          if (!raw || !raw.trim()) return;

          var before = tags.value.join("\u0000");
          tags.value = P5.cleanTags(tags.value.concat(raw));
          draft.value = "";

          // 输入的全是重复标签 / 全是空字符时，cleanTags 会返回原样的数组。
          // 这时候用户会以为「点了没反应」，给一句提示。
          if (tags.value.join("\u0000") === before) {
            err.value = "这个标签已经有了，或者只有不能用的字符";
          } else {
            err.value = "";
          }
        }

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
              tags: tags.value
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
          tags: tags,
          draft: draft,
          presetGroups: PRESET_GROUPS,
          customTags: customTags,
          full: full,
          tagPlaceholder: tagPlaceholder,
          tagHint: tagHint,
          isSelected: isSelected,
          toggle: toggle,
          addCustom: addCustom,
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
