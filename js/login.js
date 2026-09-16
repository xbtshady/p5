/**
 * 登录页逻辑 —— 0.2 版
 *
 * 流程：
 *   1. 挂载前先查会话：已登录就直接跳首页，不用再看登录表单
 *   2. 提交表单 → CloudBase 用户名密码登录 → 成功跳首页
 *
 * 关于「刷新时闪一下」：沿用 0.1 定下的约定 —— 先把要显示的内容全部确定好，
 * 再 mount Vue。这样 v-cloak 移除时页面已是最终状态，不会先渲染初始值再替换。
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

  var createApp = Vue.createApp;
  var ref = Vue.ref;
  var P5 = window.P5 || {};

  async function bootstrap() {
    var alreadyLoggedIn = false;
    var preError = "";

    try {
      alreadyLoggedIn = !!(await P5.getCurrentUser());
    } catch (e) {
      // 配置缺失之类的错误，留在表单里提示，不要静默
      preError = e.message || String(e);
    }

    if (alreadyLoggedIn) {
      location.replace("index.html");
      return;
    }

    var app = createApp({
      setup: function () {
        var username = ref("");
        var password = ref("");
        var busy = ref(false);
        var error = ref(preError);

        async function submit() {
          if (busy.value) return;

          busy.value = true;
          error.value = "";

          try {
            await P5.signIn(username.value, password.value);
            // 成功后跳首页。这里不重置 busy —— 页面马上要被替换掉。
            location.replace("index.html");
          } catch (e) {
            error.value = e.message || String(e);
            busy.value = false;
          }
        }

        return {
          username: username,
          password: password,
          busy: busy,
          error: error,
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
