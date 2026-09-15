/**
 * CloudBase 封装 —— 0.1 版（PostgreSQL）
 *
 * 只做两件事：读 projectName、写 projectName。
 *
 * 依赖：
 *   - cloudbase.full.js（index.html 通过 CDN 引入，全局变量 cloudbase）
 *   - config.js（window.APP_CONFIG.envId / .accessKey）
 *
 * 重要：本环境是 CloudBase PostgreSQL 模式，数据库 API 是 app.rdb()（postgREST 风格），
 *      不是 NoSQL 的 app.database()。方法名不同，别混：
 *        .where({...})  → .match({...}) / .eq('col', v)
 *        .orderBy(...)  → .order(...)
 *        .count()       → .select('*', { count: 'exact' })
 *        .offset(n)     → .range(from, to)
 *
 * 数据结构：
 *   table: public.app_settings
 *   row:   { key: 'projectName', value: 'p5', updated_at: <timestamptz> }
 */
(function () {
  var TABLE = "app_settings";
  var KEY = "projectName";

  var app = null;
  var db = null;
  var readyPromise = null;

  /** 统一把 SDK 的 { data, error } 形态转成异常，避免调用方漏判 */
  function unwrap(res, action) {
    if (res && res.error) {
      var e = res.error;
      throw new Error(
        action + " 失败：" + (e.message || e.code || JSON.stringify(e))
      );
    }
    return res;
  }

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
          "未配置 accessKey（Publishable Key）：CloudBase PG 环境从浏览器访问数据库需要它"
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

      // 匿名登录。0.1 用它快速验证链路。
      // 前提：控制台「登录授权 -> 登录方式」已开启「匿名登录」，否则报 login_type_disabled。
      // 注意：SDK 把失败放在返回值里，不 throw，所以这里要自己判 error。
      var auth = app.auth({ persistence: "local" });
      unwrap(await auth.signInAnonymously(), "匿名登录");

      db = app.rdb();
      return app;
    })();

    return readyPromise;
  }

  /**
   * 读取 projectName。不存在返回 null。
   */
  async function getProjectName() {
    await init();
    var res = unwrap(
      await db.from(TABLE).select("value").eq("key", KEY),
      "读取 projectName"
    );
    var rows = res.data || [];
    return rows.length ? rows[0].value : null;
  }

  /**
   * 写入 projectName。行不存在则插入，存在则更新。
   */
  async function setProjectName(name) {
    await init();
    unwrap(
      await db
        .from(TABLE)
        .upsert(
          { key: KEY, value: name, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        ),
      "保存 projectName"
    );
    return name;
  }

  window.P5 = {
    getProjectName: getProjectName,
    setProjectName: setProjectName
  };
})();
