-- 0.1 walking skeleton 清理：删除 app_settings 键值表
--
-- 这张表只服务于 0.1（在页面上读写 projectName，用来验证 CloudBase PG 链路）。
-- 0.2 起身份由 CloudBase 身份服务负责，不再需要它。
--
-- 顺带关掉一个安全隐患：该表建表时的三条 RLS 策略都是
--   USING true / WITH CHECK true，roles = {anon, authenticated}
-- 意味着任何人拿到网页源码里的 Publishable Key，就能读写整张表。
-- 表删掉，这个暴露面就彻底没了。
--
-- 注：DROP TABLE 会连带删除该表上的所有策略，无需单独 DROP POLICY。

DROP TABLE IF EXISTS public.app_settings;
