/**
 * 首页（照片列表）逻辑 —— 0.5 版
 *
 * 流程：
 *   1. 挂载前先查会话：没登录就跳登录页
 *   2. 取当前用户的照片（RLS 只会返回本人的行，前端不传也不该传归属条件）
 *   3. 私有桶拿不到直链，渲染前批量换成临时访问链接
 *   4. 卡片右上角可删除：二次确认后先删行、再删桶里的文件
 *
 * 关于「刷新时闪一下」：沿用 0.1 定下的约定 —— 先把要显示的内容全部确定好，
 * 再 mount Vue。所以照片列表和临时链接都在 mount 之前就备齐了。
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

  // Vant 的函数式组件挂在全局 vant 上（不是 Vue 插件的一部分）
  var vantLib = window.vant || {};
  var showImagePreview = vantLib.showImagePreview;
  var showConfirmDialog = vantLib.showConfirmDialog;

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  /** 时间戳 → 2026.09.16 */
  function fmtDate(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "." + pad(d.getMonth() + 1) + "." + pad(d.getDate());
  }

  async function bootstrap() {
    var user = null;
    var error = "";

    try {
      user = await P5.getCurrentUser();
    } catch (e) {
      error = e.message || String(e);
    }

    if (!user) {
      // 未登录，或会话已失效 —— 回登录页
      location.replace("login.html");
      return;
    }

    var photos = [];

    if (!error) {
      try {
        var rows = await P5.listPhotos();

        var paths = rows
          .map(function (r) {
            return r.storage_path;
          })
          .filter(Boolean);

        // 私有桶不发直链，必须先换临时访问链接才能进 <img src>
        var urlMap = paths.length ? await P5.signPhotoUrls(paths) : {};

        photos = rows.map(function (r) {
          return {
            id: r.id,
            // 删除时要连桶里的文件一起删，所以路径必须留着
            storagePath: r.storage_path,
            title: r.title || "",
            note: r.note || "",
            date: fmtDate(r.created_at),
            url: urlMap[r.storage_path] || "",
            // 图片解码完置 true，CSS 靠它把照片淡出来
            loaded: false
          };
        });
      } catch (e) {
        error = e.message || String(e);
      }
    }

    createApp({
      setup: function () {
        // 渲染用的列表。删除要就地改它，所以外面那个 photos 数组只当初始数据源
        var list = ref(photos);
        var busy = ref(false);
        var err = ref(error);

        // 顶栏滚出内容时才浮出阴影（class 挂在 .topbar 上，样式在 style.css）。
        // passive 监听 + 只在跨过阈值时赋值，避免每滚一帧都触发一次渲染
        var scrolled = ref(false);

        function onScroll() {
          var v = window.scrollY > 4;
          if (v !== scrolled.value) scrolled.value = v;
        }

        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();

        async function logout() {
          if (busy.value) return;

          busy.value = true;
          err.value = "";

          try {
            await P5.signOut();
            // 清掉本地会话后回登录页，可以换账号
            location.replace("login.html");
          } catch (e) {
            err.value = e.message || String(e);
            busy.value = false;
          }
        }

        /**
         * 点图全屏看 —— 交给 Vant 的 showImagePreview（自带双指缩放、左右切换）。
         *
         * 传进来的 index 是列表下标，但取不到临时链接的照片不参与预览，
         * 所以要重新数一遍它在「有图的那批」里排第几，否则点第 3 张会跳到第 2 张。
         */
        function preview(index) {
          if (typeof showImagePreview !== "function") return;

          var urls = [];
          var start = 0;

          list.value.forEach(function (p, i) {
            if (!p.url) return;
            if (i === index) start = urls.length;
            urls.push(p.url);
          });

          if (!urls.length) return;

          showImagePreview({
            images: urls,
            startPosition: start,
            closeable: true
          });
        }

        /**
         * 删除一条记录。
         *
         * 先弹确认：删掉就没了，不给自己留后悔的余地。
         * 确认后交给 P5.deletePhoto（先删行再删文件，两道门都由 RLS 把关），
         * 成功了才从列表里摘掉这一条 —— 失败就原地保留并把原因显示出来。
         */
        async function remove(p) {
          if (busy.value) return;

          if (typeof showConfirmDialog === "function") {
            try {
              // 危险动作按全站约定用 --danger 那支红。
              // 从 CSS 变量读，不抄一份色值 —— 抄了就是两处维护，换主题时必漏一边。
              var dangerColor =
                getComputedStyle(document.documentElement)
                  .getPropertyValue("--danger")
                  .trim() || "#bc331c";

              await showConfirmDialog({
                title: "删除这张照片？",
                message: "照片和记录都会删掉，无法恢复。",
                confirmButtonText: "删除",
                confirmButtonColor: dangerColor
              });
            } catch (e) {
              return; // 点了取消
            }
          }

          busy.value = true;
          err.value = "";

          try {
            await P5.deletePhoto(p.id, p.storagePath);
            list.value = list.value.filter(function (x) {
              return x.id !== p.id;
            });
          } catch (e) {
            err.value = e.message || String(e);
          } finally {
            busy.value = false;
          }
        }

        return {
          photos: list,
          busy: busy,
          error: err,
          scrolled: scrolled,
          logout: logout,
          preview: preview,
          remove: remove
        };
      }
    }).mount("#app");

    // 挂载完成（v-cloak 已移除），撤掉启动占位层
    if (boot) boot.remove();
  }

  bootstrap();
})();
