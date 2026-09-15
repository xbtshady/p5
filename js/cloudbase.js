/**
 * CloudBase 封装 —— 0.2 版（用户名密码登录）
 *
 * 职责：初始化 SDK + 登录 / 退出 / 查当前用户。
 *
 * 依赖：
 *   - cloudbase.full.js（页面通过 CDN 引入，全局变量 cloudbase）
 *   - config.js（window.APP_CONFIG.envId / .accessKey）
 *
 * 对外接口（window.P5）：
 *   signIn(username, password)  → user          登录，失败抛异常
 *   signOut()                   → void          退出登录
 *   getCurrentUser()            → user | null   查当前登录用户（未登录返回 null）
 *
 * 会话持久化：
 *   auth({ persistence: "local" }) 会把会话存进 localStorage，
 *   所以刷新页面、关掉标签页再打开，登录态都还在。
 */
(function () {
  var app = null;
  var auth = null;
  var db = null;
  var readyPromise = null;

  function init() {
    if (readyPromise) return readyPromise;

    readyPromise = (async function () {
      var cfg = window.APP_CONFIG || {};

      if (!cfg.envId) {
        throw new Error(
          "未配置 envId：请复制 js/config.example.js 为 js/config.js，并填入 CloudBase 环境 ID"
        );
      }
      if (!cfg.accessKey) {
        throw new Error(
          "未配置 accessKey（Publishable Key）：CloudBase PG 环境从浏览器访问需要它"
        );
      }
      if (typeof cloudbase === "undefined") {
        throw new Error("CloudBase SDK 未加载，请检查网络或 CDN 地址");
      }

      // 地域：新版 CloudBase 环境由 SDK 自动解析，通常不传 region。
      // 仅旧版 env-xxx 环境请求失败时，才需要在 config.js 里显式指定。
      var initOptions = { env: cfg.envId, accessKey: cfg.accessKey };
      if (cfg.region) initOptions.region = cfg.region;

      app = cloudbase.init(initOptions);
      auth = app.auth({ persistence: "local" });
      db = app.rdb();

      return app;
    })();

    return readyPromise;
  }

  /** 把 SDK 返回的英文错误转成能看懂的中文 */
  function friendly(err) {
    var raw = (err && (err.message || err.error_description || err.code)) || "";
    console.warn("[P5] 登录失败原始错误:", err);

    if (/invalid.*(credential|password|login)|incorrect|wrong password/i.test(raw)) {
      return "用户名或密码不正确";
    }
    if (/user.*not.*found|no such user/i.test(raw)) {
      return "用户名或密码不正确";
    }
    if (/too many|rate.?limit|frequent/i.test(raw)) {
      return "尝试过于频繁，请稍后再试";
    }
    if (/network|fetch|timeout|Failed to fetch/i.test(raw)) {
      return "网络异常，请检查网络后重试";
    }
    return "登录失败：" + (raw || "未知错误");
  }

  /**
   * 登录。
   * 注意：SDK 把失败放在返回值里（不 throw），所以要自己判 error。
   */
  async function signIn(username, password) {
    await init();

    var res = await auth.signInWithPassword({
      username: username,
      password: password
    });

    if (res && res.error) {
      throw new Error(friendly(res.error));
    }
    return res.data && res.data.user;
  }

  /** 当前登录用户。未登录返回 null。 */
  async function getCurrentUser() {
    await init();

    // getLoginState() 会触发从 localStorage 恢复会话（刷新页面后靠它）。
    // 返回值形态各版本不一致，所以只当触发器用，真正的判断交给 getSession()。
    if (typeof auth.getLoginState === "function") {
      try {
        await auth.getLoginState();
      } catch (e) {
        console.warn("[P5] getLoginState 失败，继续尝试 getSession:", e);
      }
    }

    var res = await auth.getSession();
    var session = res && res.data && res.data.session;
    return session ? session.user : null;
  }

  /** 退出登录。本地会话会被清空。 */
  async function signOut() {
    await init();

    var res = await auth.signOut();
    if (res && res.error) {
      throw new Error("退出登录失败：" + (res.error.message || ""));
    }
  }

  window.P5 = {
    signIn: signIn,
    signOut: signOut,
    getCurrentUser: getCurrentUser,
    // 1.0 会用它读写 photo_notes，现在先留着
    db: function () {
      return db;
    }
  };
})();
