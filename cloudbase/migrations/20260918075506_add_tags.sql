-- ============================================================================
-- P5 0.7 —— 标签：photo_notes 加 tags 列
-- ============================================================================
--
-- 为什么是 text[] 而不是关联表 photo_tags：
--   1.0 对标签只需要两件事 —— 「按标签筛选」和「列出所有标签及用量」。
--   PG 的数组类型配 GIN 索引就能兜住，不必引入关联表 + JOIN + 中间表的 INSERT 顺序。
--   等 1.5 真要拆技法/题材两个维度、要做标签统计时再迁移。
--
-- 为什么不用 jsonb：
--   tags 是有序、去重后的字符串集合，text[] 的包含运算符 @> 正好对上 GIN 的
--   array_ops 操作符类；jsonb 只能走 jsonb_ops，还得多包一层 jsonb 字面量语法。
--
-- 前端怎么查（已在 SDK 里确认过）：
--   db.from('photo_notes').select('*').contains('tags', ['低机位'])
--   → 拼成 postgREST 的 tags=cs.{低机位}
--   → 对应 PG 的 tags @> '{低机位}'，走下面这条 GIN 索引。
--
--   ⚠️ SDK 对数组参数是 tags.join(',') 直接拼串，**不做任何转义**。
--   所以标签里不能出现 , { } " 这几个字符，否则会把查询拼坏。
--   归一化由前端 js/cloudbase.js 的 P5.cleanTags 统一负责，写库前和查询前都会过一道。
--
-- 不需要动 GRANT / RLS：
--   权限是按表授的（GRANT SELECT, INSERT ON public.photo_notes TO authenticated），
--   新列自动继承，不用补授权。隔离仍然是 owner_id = auth.uid()，
--   加一列不改变任何策略。
--
-- 应用：tcb db pg migration up -e p5-d4g6dukvb86de1377
-- ============================================================================

ALTER TABLE public.photo_notes
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- 标签筛选走 @>（包含），GIN 的 array_ops 默认就支持它。
-- 已有索引 photo_notes_owner_created_idx (owner_id, created_at DESC) 管列表排序，
-- 这条只管标签检索，两条不冲突 —— 实际查询是「owner_id 等值 + tags 包含」，
-- 规划器会在两者间挑一条，数据量小的时候走哪条都无所谓。
CREATE INDEX IF NOT EXISTS photo_notes_tags_idx
  ON public.photo_notes USING GIN (tags);
