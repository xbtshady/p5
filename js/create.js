/**
 * 新增照片页逻辑 —— 0.4 版（表单换成 Vant）
 *
 * 流程：
 *   1. 挂载前先查会话：没登录就跳登录页
 *   2. 选图 → 前端压缩（长边 1600px、WebP）→ 缩略图 + 体积对照
 *   3. 提交 → 上传到私有桶 {uid}/xxx → 落库 → 回列表
 *
 * 三条硬约定：
 *   - 上传失败绝不落库。宁可报错让用户重试，也不要留下一条指向不存在文件的记录。
 *   - 失败原因一律显示出来，不静默吞掉。
 *   - ⚠️ 页面上所有 van-* 组件必须写完整闭合标签（<van-field></van-field>）。
 *     HTML 不认自定义标签的自闭合，写成 <van-field /> 会把后面所有同级组件
 *     吞成它的子元素，表现为「写了好几个只渲染出一个」。原生 void 元素
 *     （img / input）不受影响。
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
  var P5 = window.P5 || {};

  // 长边 1600px 足够看清构图，又不至于把流量耗在像素上
  var MAX_EDGE = 1600;
  var QUALITY = 0.85;

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
              note: note.value
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
