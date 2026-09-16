/**
 * 新增照片页逻辑 —— 0.3 版
 *
 * 流程：
 *   1. 挂载前先查会话：没登录就跳登录页
 *   2. 选图 → 前端压缩（长边 1600px、WebP）→ 预览
 *   3. 提交 → 上传到私有桶 {uid}/xxx → 落库 → 回列表
 *
 * 两条硬约定：
 *   - 上传失败绝不落库。宁可报错让用户重试，也不要留下一条指向不存在文件的记录。
 *   - 失败原因一律显示出来，不静默吞掉。
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

    createApp({
      setup: function () {
        var file = ref(null);
        var previewUrl = ref("");
        var sizeText = ref("");
        var title = ref("");
        var note = ref("");
        var busy = ref(false);
        var statusText = ref("保存中…");
        var err = ref(error);

        async function pick(e) {
          var picked = e.target.files && e.target.files[0];
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
            file.value = out;
            previewUrl.value = URL.createObjectURL(out);
            sizeText.value = fmtSize(picked.size) + " → " + fmtSize(out.size);
          } catch (e2) {
            file.value = null;
            previewUrl.value = "";
            sizeText.value = "";
            err.value = e2.message || String(e2);
          } finally {
            busy.value = false;
            statusText.value = "保存中…";
          }
        }

        async function submit() {
          if (busy.value) return;

          busy.value = true;
          statusText.value = "上传中…";
          err.value = "";

          try {
            if (!file.value) throw new Error("还没选照片");

            var path = await P5.uploadPhoto(file.value, extOf(file.value));

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
          file: file,
          previewUrl: previewUrl,
          sizeText: sizeText,
          title: title,
          note: note,
          busy: busy,
          statusText: statusText,
          error: err,
          pick: pick,
          submit: submit
        };
      }
    }).mount("#app");

    // 挂载完成（v-cloak 已移除），撤掉启动占位层
    if (boot) boot.remove();
  }

  bootstrap();
})();
