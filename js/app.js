/**
 * Vue 3 页面逻辑 —— 0.1 版
 *
 * 页面加载时从 CloudBase 读取 projectName 并显示为 "hello {projectName}"。
 * 输入框可修改并保存回 CloudBase，用来验证「写」的链路。
 */
(function () {
  const { createApp, ref, onMounted } = Vue;
  const { getProjectName, setProjectName } = window.P5;

  createApp({
    setup() {
      const projectName = ref("…");
      const draft = ref("");
      const loading = ref(true);
      const saving = ref(false);
      const error = ref("");
      const savedAt = ref("");

      async function load() {
        loading.value = true;
        error.value = "";
        try {
          const name = await getProjectName();
          if (name) {
            projectName.value = name;
            draft.value = name;
          } else {
            projectName.value = "(未设置)";
            draft.value = "";
          }
        } catch (e) {
          projectName.value = "?";
          error.value = e.message || String(e);
        } finally {
          loading.value = false;
        }
      }

      async function save() {
        const value = draft.value.trim();
        if (!value) return;

        saving.value = true;
        error.value = "";
        try {
          const name = await setProjectName(value);
          projectName.value = name;
          draft.value = name;
          savedAt.value = new Date().toLocaleTimeString();
        } catch (e) {
          error.value = e.message || String(e);
        } finally {
          saving.value = false;
        }
      }

      onMounted(load);

      return {
        projectName,
        draft,
        loading,
        saving,
        error,
        savedAt,
        save
      };
    }
  }).mount("#app");
})();
