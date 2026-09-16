-- ============================================================================
-- P5 0.5 —— 删除照片：补齐 DELETE 的权限与策略
-- ============================================================================
--
-- 0.3 时刻意没授 DELETE（当时不做改和删），所以界面上根本没有删除入口。
-- 本迁移把两道门都补上，仍是「谁的行谁删、谁的图谁删」：
--
--   第一层 数据行：photo_notes 加 GRANT DELETE + 策略 USING (owner_id = auth.uid())
--   第二层 照片文件：storage.objects 加 DELETE 策略，路径首段 = uid
--
-- 两层都要补。只补一层的话，会出现「记录没了但文件还在」或者反过来
-- 「文件没了但列表里还挂着一条指向不存在文件的记录」。
--
-- 注意：storage.objects 的 GRANT 是平台默认对 anon / authenticated 全开的，
-- 所以这里不需要、也不应该再补 GRANT，只补策略。
--
-- 应用：tcb db pg migration up -e p5-d4g6dukvb86de1377
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 数据行：允许多少权限、允许删哪些行
--    只给 DELETE，不给 UPDATE —— 0.5 仍然不做编辑
-- ----------------------------------------------------------------------------

GRANT DELETE ON public.photo_notes TO authenticated;

CREATE POLICY p5_notes_delete ON public.photo_notes
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid());


-- ----------------------------------------------------------------------------
-- 2. 照片文件
--    路径约定 {uid}/{文件名}，首段必须是本人的 uid。
--    不能直接 DELETE FROM storage.objects —— 平台装了 protect_delete 触发器
--    会拦住，必须走 SDK / Storage API，这条策略是那条通路上的判据。
-- ----------------------------------------------------------------------------

CREATE POLICY p5_photos_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'photos'
    AND (storage.foldername(name))[1] = auth.uid()
  );
