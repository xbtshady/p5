/**
 * 首页（照片列表）逻辑 —— 0.14 版（卡片档位行 + 原地展开）
 *
 * 流程：
 *   1. 挂载前先查会话：没登录就跳登录页
 *   2. 取当前用户的照片（RLS 只会返回本人的行，前端不传也不该传归属条件）
 *   3. 私有桶拿不到直链，渲染前批量换成临时访问链接
 *   4. 取一次标签用量，给「探索」区做标签云
 *   5. 卡片右上角可删除：二次确认后先删行、再删桶里的文件
 *   6. 点标签筛选（探索区的入口），再点一次取消
 *   7. 卡片默认只露一行档位值 + 技巧条数，点日期那行原地展开详情（0.14）
 *
 * 关于「刷新时闪一下」：沿用 0.1 定下的约定 —— 先把要显示的内容全部确定好，
 * 再 mount Vue。所以照片列表、临时链接、标签用量都在 mount 之前就备齐了。
 *
 * 筛选为什么一律走服务端查询，而不是在前端过滤已取回的数组：
 *   筛过一次之后手上的列表就不是全集了（只有带该标签的那几张），
 *   再在前端筛只会越筛越少。取消筛选时更是只能重新取。
 *   所以每次切标签都重新查一次，语义永远一致。
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
  var computed = Vue.computed;
  var P5 = window.P5 || {};

  // 标签云最多显示几个。个人项目里标签本来就收敛（预置清单只有 11 个），
  // 但自定义标签攒多了会把「探索」区撑成一大片，所以封个数。
  // 筛选中的那个标签一定会出现，不受这个上限影响。
  var TAG_CLOUD_MAX = 12;

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

  /**
   * 取一批照片，并换成可以进 <img src> 的临时链接。
   * tag 传空串表示不筛。
   */
  async function loadPhotos(tag) {
    var rows = await P5.listPhotos(tag ? { tag: tag } : null);

    var paths = rows
      .map(function (r) {
        return r.storage_path;
      })
      .filter(Boolean);

    // 私有桶不发直链，必须先换临时访问链接才能进 <img src>
    var urlMap = paths.length ? await P5.signPhotoUrls(paths) : {};

    return rows.map(function (r) {
      var tips = r.ai_tips || [];

      // 档位一行只显值：库里存的是「镜头:中长焦」，decode 之后只取值。
      // 「不确定」不显示 —— 它是 AI 拿不准时的合法出口，但没有参考价值，
      // 一行档位要留给真信息（展开区同规则，两处同一个数组）。
      var facetValues = P5Facets.fromTags(r.tags || [])
        .map(function (d) {
          return d.value === P5Facets.UNCERTAIN ? "" : d.value;
        })
        .filter(Boolean);

      return {
        id: r.id,
        // 删除时要连桶里的文件一起删，所以路径必须留着
        storagePath: r.storage_path,
        title: r.title || "",
        note: r.note || "",
        facetValues: facetValues,
        tips: tips,
        // 没有描述、档位、技巧任何一样时，展开区是空的 —— 不渲染那个按钮
        expandable: !!(r.note || facetValues.length || tips.length),
        open: false,
        date: fmtDate(r.created_at),
        url: urlMap[r.storage_path] || "",
        // 图片解码完置 true，CSS 靠它把照片淡出来
        loaded: false
      };
    });
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
    var tagCounts = [];

    if (!error) {
      try {
        photos = await loadPhotos("");
        tagCounts = await P5.listTagCounts();
      } catch (e) {
        error = e.message || String(e);
      }
    }

    createApp({
      setup: function () {
        // 渲染用的列表。删除要就地改它，所以外面那个 photos 数组只当初始数据源
        var list = ref(photos);
        // 标签用量，给探索区做标签云
        var counts = ref(tagCounts);
        // 当前筛选的标签，空串 = 没筛
        var activeTag = ref("");
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
         * 标签云。用量倒序取前 TAG_CLOUD_MAX 个。
         *
         * 当前筛选中的那个一定带上 —— 否则筛到一个冷门标签后，它自己从云里消失了，
         * 界面上就没有任何地方能再点它来取消，只能整页刷新。
         */
        var tagCloud = computed(function () {
          var all = counts.value;
          var top = all.slice(0, TAG_CLOUD_MAX);
          if (!activeTag.value) return top;

          var already = top.some(function (t) {
            return t.tag === activeTag.value;
          });
          if (already) return top;

          return top.concat(
            all.filter(function (t) {
              return t.tag === activeTag.value;
            })
          );
        });

        /**
         * 切标签筛选。
         *
         * 传空串 = 取消筛选。传当前已选的那个 = 再点一次也是取消（开关语义），
         * 这样探索区的「清除」和「点当前标签」行为一致，不用解释两套。
         *
         * ⚠️ activeTag 在查询**成功之后**才改：查询失败时界面应该保持原样，
         * 不能出现「标签高亮了但列表还是上一批」这种自相矛盾的状态。
         */
        async function filterBy(tag) {
          if (busy.value) return;

          var next = tag === activeTag.value ? "" : tag;

          busy.value = true;
          err.value = "";

          try {
            var rows = await loadPhotos(next);
            list.value = rows;
            activeTag.value = next;
          } catch (e) {
            err.value = e.message || String(e);
          } finally {
            busy.value = false;
          }
        }

        /**
         * 卡片原地展开 / 收起（0.14）。
         * 只改这一条的 open，别的卡片不动 —— 刷的时候一张一张看，不该连带。
         */
        function toggle(p) {
          p.open = !p.open;
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

            // 标签用量跟着变了，重取一次。不取的话，删掉最后一张带 #低机位 的照片后，
            // 探索区那个标签还挂着「1」，点进去却是空的。
            try {
              counts.value = await P5.listTagCounts();
            } catch (ce) {
              // 只是个数字没更新，不影响用 —— 不值得让整次删除显示成失败
              console.warn("[P5] 删除后刷新标签用量失败:", ce);
            }
          } catch (e) {
            err.value = e.message || String(e);
          } finally {
            busy.value = false;
          }
        }

        return {
          photos: list,
          tagCounts: tagCloud,
          activeTag: activeTag,
          busy: busy,
          error: err,
          scrolled: scrolled,
          logout: logout,
          preview: preview,
          filterBy: filterBy,
          toggle: toggle,
          remove: remove
        };
      }
    }).mount("#app");

    // 挂载完成（v-cloak 已移除），撤掉启动占位层
    if (boot) boot.remove();
  }

  bootstrap();
})();
