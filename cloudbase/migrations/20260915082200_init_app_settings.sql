-- 20260915082200_init_app_settings
-- 0.1 walking skeleton：建一张键值表，存 projectName。
--
-- 说明：
--   * 0.1 只需要「读一个值、改一个值」，键值表比宽表更贴合，后续配置项直接加行即可。
--   * GRANT 与 RLS 是两道独立的门，缺一不可：先 GRANT 给角色，再建 POLICY，
--     只做其一都会得到形似「权限不足」的报错。
--   * 0.1 阶段写的策略是「anon / authenticated 全部可读写」，属于临时放宽。
--     1.0 会收紧成：读放开、写必须校验 writeToken（避免 publishable key 泄露后被随意写）。

-- 1) 建表
CREATE TABLE IF NOT EXISTS public.app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) 授权给 anon / authenticated（publishable key 走 anon，匿名登录会话走 authenticated）
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO anon, authenticated;

-- 3) 开启行级安全
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- 4) 策略：0.1 临时放开（1.0 收紧）
DROP POLICY IF EXISTS app_settings_select ON public.app_settings;
CREATE POLICY app_settings_select ON public.app_settings
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS app_settings_insert ON public.app_settings;
CREATE POLICY app_settings_insert ON public.app_settings
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS app_settings_update ON public.app_settings;
CREATE POLICY app_settings_update ON public.app_settings
  FOR UPDATE TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- 5) 播种初始值
INSERT INTO public.app_settings (key, value)
VALUES ('projectName', 'p5')
ON CONFLICT (key) DO NOTHING;

-- 回滚（如需）：
-- DROP TABLE IF EXISTS public.app_settings;
