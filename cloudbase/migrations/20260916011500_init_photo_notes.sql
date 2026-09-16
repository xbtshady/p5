-- ============================================================================
-- P5 0.3 —— 照片表 photo_notes + 用户隔离
-- ============================================================================
--
-- 隔离做两层，缺一不可：
--   第一层 数据表：owner_id = auth.uid()，策略只授 authenticated
--   第二层 照片文件：私有桶 + 路径首段 = uid
--
-- 本环境实测到的前提（下面策略依赖它们）：
--   auth.uid()                -> text，无参数，直接读 JWT
--   storage.foldername(name)  -> text[]
--   storage.objects / storage.buckets 的 GRANT 已对 anon / authenticated 全开
--   （平台默认），所以那两张表的隔离**完全依赖下面这几条 RLS 策略**，
--   粒度必须严格：任何一条写松了就是越权。
--
-- 应用：tcb db pg migration up -e p5-d4g6dukvb86de1377
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 业务表
-- ----------------------------------------------------------------------------

CREATE TABLE public.photo_notes (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id     TEXT        NOT NULL DEFAULT auth.uid(),
  storage_path TEXT        NOT NULL,
  title        TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 列表查询是「按 owner_id 过滤 + created_at 倒序」，正好走这条索引
CREATE INDEX photo_notes_owner_created_idx
  ON public.photo_notes (owner_id, created_at DESC);


-- ----------------------------------------------------------------------------
-- 2. 两道门的第一道：GRANT
--    刻意不授 anon —— 未登录连这张表都碰不到，更别说读行
--    也刻意不授 UPDATE / DELETE —— 0.3 不做改和删
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT ON public.photo_notes TO authenticated;


-- ----------------------------------------------------------------------------
-- 3. 两道门的第二道：RLS
--    owner_id 的默认值取自 JWT，前端无法伪造；策略只负责核对它等于 auth.uid()
-- ----------------------------------------------------------------------------

ALTER TABLE public.photo_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY p5_notes_select ON public.photo_notes
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

CREATE POLICY p5_notes_insert ON public.photo_notes
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());


-- ----------------------------------------------------------------------------
-- 4. 照片桶（私有）
--    public = false：不发直链，读取一律走临时签名 URL。
--    这是隔离的第二层 —— 只隔离表而桶是公开的话，
--    别人拿到（或猜到）URL 就能直接看图，第一层等于白做。
-- ----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('photos', 'photos', false)
ON CONFLICT (id) DO NOTHING;


-- ----------------------------------------------------------------------------
-- 5. 照片文件的 RLS
--    路径约定 {uid}/{uuid}.webp —— 首段必须是本人的 uid
-- ----------------------------------------------------------------------------

CREATE POLICY p5_photos_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'photos'
    AND (storage.foldername(name))[1] = auth.uid()
  );

CREATE POLICY p5_photos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'photos'
    AND (storage.foldername(name))[1] = auth.uid()
  );
