/**
 * Vue 3 页面逻辑 —— 0.1 版
 *
 * 页面加载时从 CloudBase 读取 projectName 并显示为 "hello {projectName}"。
 * 输入框可修改并保存回 CloudBase，用来验证「写」的链路。
 *
 * 关于「刷新时会闪一下占位符」：
 *   v-cloak 只能挡到 Vue 挂载完成，挡不住挂载之后才发起的数据加载。
 *   若挂载后才请求，页面会先渲染初始值（hello …、空输入框透出 placeholder），
 *   等数据回来再替换 —— 那就是刷新时看到的闪烁。
 *   这里改为「先把数据取回来，再挂载 Vue」：v-cloak 移除时页面已是最终内容，不闪。
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

  var createApp = Vue.createApp;
  var ref = Vue.ref;
  var P5 = window.P5 || {};

  async function bootstrap() {
    var name = "";
    var initError = "";

    try {
      name = (await P5.getProjectName()) || "";
    } catch (e) {
      initError = e.message || String(e);
    }

    // 挂载前就把要显示的初始值全部确定好
    var displayName = initError ? "?" : (name || "(未设置)");

    createApp({
      setup: function () {
        var projectName = ref(displayName);
        var draft = ref(name);
        var saving = ref(false);
        var savedAt = ref("");
        var error = ref(initError);

        async function save() {
          var value = draft.value.trim();
          if (!value) return;

          saving.value = true;
          error.value = "";
          try {
            var saved = await P5.setProjectName(value);
            projectName.value = saved;
            draft.value = saved;
            savedAt.value = new Date().toLocaleTimeString();
          } catch (e) {
            error.value = e.message || String(e);
          } finally {
            saving.value = false;
          }
        }

        return {
          projectName: projectName,
          draft: draft,
          saving: saving,
          savedAt: savedAt,
          error: error,
          save: save
        };
      }
    }).mount("#app");

    // 挂载完成（v-cloak 已移除），撤掉启动占位层
    if (boot) boot.remove();
  }

  bootstrap();
})();
