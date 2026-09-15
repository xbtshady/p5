/**
 * CloudBase 封装 —— 0.1 版
 *
 * 只做两件事：读 projectName、写 projectName。
 *
 * 依赖：
 *   - cloudbase.full.js（index.html 已通过 CDN 引入，全局变量 cloudbase）
 *   - config.js（window.APP_CONFIG.envId）
 *
 * 数据结构：
 *   collection: settings
 *   doc:        app
 *   { _id: 'app', projectName: 'p5' }
 */
(function () {
  var COLLECTION = "settings";
  var DOC_ID = "app";

  var app = null;
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
      if (typeof cloudbase === "undefined") {
        throw new Error("CloudBase SDK 未加载，请检查网络或 CDN 地址");
      }

      app = cloudbase.init({
        env: cfg.envId,
        region: cfg.region || "ap-shanghai"
      });

      // 匿名登录。0.1 用它快速验证链路，1.0 会换成 writeToken 方案。
      var auth = app.auth({ persistence: "local" });
      await auth.signInAnonymously();

      db = app.database();
      return app;
    })();

    return readyPromise;
  }

  /**
   * 读取 projectName。不存在返回 null。
   */
  async function getProjectName() {
    await init();
    var res = await db.collection(COLLECTION).doc(DOC_ID).get();
    var list = (res && res.data) || [];
    if (!list.length) return null;
    return list[0].projectName || null;
  }

  /**
   * 写入 projectName。文档不存在则创建。
   */
  async function setProjectName(name) {
    await init();
    await db.collection(COLLECTION).doc(DOC_ID).set({ projectName: name });
    return name;
  }

  window.P5 = {
    getProjectName: getProjectName,
    setProjectName: setProjectName
  };
})();
