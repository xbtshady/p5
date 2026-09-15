/**
 * 首页（登录成功页）逻辑 —— 0.2 版
 *
 * 流程：
 *   1. 挂载前先查会话：没登录就跳登录页
 *   2. 已登录 → 显示用户信息 + 退出登录按钮
 *
 * 1.0 这个页面会变成照片流，现在先当登录成功页用。
 *
 * 关于「刷新时闪一下」：沿用 0.1 定下的约定 —— 先把要显示的内容全部确定好，
 * 再 mount Vue。所以 toProfile() 在 mount 之前就把所有展示文案算成了纯字符串。
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

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  /**
   * 把 CloudBase 的 user 对象转成页面要显示的纯文本。
   *
   * 实际能拿到的字段（本环境实测）：
   *   user.id                          → 用户 ID
   *   user.created_at                  → 注册时间（UTC，这里转本地时区显示）
   *   user.user_metadata.nickName      → 昵称
   *   user.user_metadata.username      → 用户名
   *   user.user_metadata.uid           → 同 user.id
   *   user.app_metadata.providers[]    → 登录方式
   *
   * 拿不到的：头像、手机号、邮箱（本环境都是空字符串）。
   * 所以头像用昵称首字母 + 纯色底代替。
   */
  function toProfile(user) {
    var meta = user.user_metadata || {};
    var appMeta = user.app_metadata || {};

    var name = meta.nickName || meta.name || meta.username || "用户";

    var created = "—";
    if (user.created_at) {
      var d = new Date(user.created_at);
      if (!isNaN(d.getTime())) {
        created =
          d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
          " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      }
    }

    var providers = appMeta.providers || (appMeta.provider ? [appMeta.provider] : []);

    return {
      name: name,
      initial: name.trim().charAt(0).toUpperCase() || "?",
      username: meta.username || "",
      uid: meta.uid || user.id || "—",
      created: created,
      provider: providers.length ? providers.join(", ") : "—"
    };
  }

  async function bootstrap() {
    var user = null;
    var loadError = "";

    try {
      user = await P5.getCurrentUser();
    } catch (e) {
      loadError = e.message || String(e);
    }

    if (!user) {
      // 未登录，或会话已失效 —— 回登录页（带 ?next 以后再说，1.0 用得上）
      location.replace("login.html");
      return;
    }

    // 挂载前把要显示的内容全部确定好
    var profile = toProfile(user);

    createApp({
      setup: function () {
        var busy = ref(false);
        var error = ref(loadError);

        async function logout() {
          if (busy.value) return;

          busy.value = true;
          error.value = "";

          try {
            await P5.signOut();
            // 清掉本地会话后回登录页，可以换账号
            location.replace("login.html");
          } catch (e) {
            error.value = e.message || String(e);
            busy.value = false;
          }
        }

        return {
          profile: ref(profile),
          busy: busy,
          error: error,
          logout: logout
        };
      }
    }).mount("#app");

    // 挂载完成（v-cloak 已移除），撤掉启动占位层
    if (boot) boot.remove();
  }

  bootstrap();
})();
