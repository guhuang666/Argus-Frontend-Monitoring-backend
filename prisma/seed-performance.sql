-- ============================================================================
-- performance_metrics 演示数据
--
-- 用途：让「性能」页的分位趋势图有东西可画（真实上报还没接上时用）。
-- 特征：
--   · 覆盖最近 30 天、每小时 3 条 —— 24h / 7d / 30d 三档都有数据
--   · 白天（9~22 点）LCP 系统性偏高，7d 视图能看出昼夜起伏
--   · lcp 5% / cls 8% / inp 25% 为 NULL —— 忠实于真实情况：
--       INP 只有用户真交互了才有值，不该被 0 兜底
--   · 故意留两段空窗（8 小时前 3 小时、3 天前 6 小时）：
--       24h 与 7d 视图上会出现折线断点，用来验证 connectNulls: false
--
-- 幂等：event_id 一律以 'seed-' 开头。重复执行前先跑文件末尾的 DELETE。
-- 清理：DELETE FROM performance_metrics WHERE event_id LIKE 'seed-%';
--
-- 执行：
--   docker cp prisma/seed-performance.sql argus-postgres-1:/tmp/seed.sql
--   docker exec argus-postgres-1 psql -U argus -d argus -f /tmp/seed.sql
-- ============================================================================

BEGIN;

-- 先清掉上一轮 seed，避免重复执行把每个桶的样本数越堆越多
DELETE FROM performance_metrics WHERE event_id LIKE 'seed-%';

INSERT INTO performance_metrics (
  event_id,
  project_id,
  "timestamp",
  url,
  user_agent,
  sdk_name,
  sdk_version,
  lcp,
  cls,
  inp,
  lcp_element,
  inp_target,
  inp_element,
  inp_phase,
  navigation_type,
  device_viewport,
  device_dpr,
  "connection",
  user_id,
  session_id,
  release,
  environment
)
SELECT
  'seed-' || gen_random_uuid()::text,
  p.id,

  -- 桶起点 + 0~55 分钟随机偏移；当前小时的桶用 LEAST 压到现在之前，
  -- 否则落在未来的行会被趋势查询的 `timestamp < to` 排除，右边最后一个桶变空
  LEAST(
    h.h + make_interval(mins => (random() * 55)::int),
    now() - interval '1 second'
  ),

  (ARRAY[
    'https://shop.example.com/list',
    'https://shop.example.com/detail?id=42',
    'https://shop.example.com/cart',
    'https://shop.example.com/checkout'
  ])[1 + floor(random() * 4)::int],

  CASE WHEN random() < 0.55
       THEN 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
       ELSE 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  END,

  'argus-sdk',
  '1.0.0',

  -- LCP：基线 1500ms，白天 +450ms，再叠一个平方分布的噪声（大部分落在低位，
  -- 少数冲到 3000ms 以上，能穿过 2500 / 4000 两条阈值线）
  CASE WHEN random() < 0.05 THEN NULL
       ELSE (
         1500
         + CASE WHEN EXTRACT(hour FROM h.h) BETWEEN 9 AND 22 THEN 450 ELSE 0 END
         + (random() ^ 2) * 2200
       )::float
  END,

  -- CLS：立方分布，绝大多数 < 0.1，尾部能到 0.35
  CASE WHEN random() < 0.08 THEN NULL
       ELSE ((random() ^ 3) * 0.35)::float
  END,

  -- INP：25% 为 NULL（页面没人交互）；有值时 70~690ms
  CASE WHEN random() < 0.25 THEN NULL
       ELSE (70 + (random() ^ 2) * 620)::float
  END,

  (ARRAY['img.hero', 'h1.title', 'div.banner', 'img.product'])[1 + floor(random() * 4)::int],
  (ARRAY['button#add-cart', 'a.nav-link', 'button#submit', 'input#search'])[1 + floor(random() * 4)::int],
  (ARRAY['button.recommend', 'a.card-link', 'button.primary', 'input.field'])[1 + floor(random() * 4)::int],
  (ARRAY['input-delay', 'processing', 'presentation'])[1 + floor(random() * 3)::int],

  (ARRAY['navigate', 'reload', 'back_forward'])[1 + floor(random() * 3)::int],
  (ARRAY['1920x1080', '1366x768', '390x844', '1440x900'])[1 + floor(random() * 4)::int],
  (ARRAY[1, 1.25, 2, 3])[1 + floor(random() * 4)::int]::float,
  (ARRAY['4g', '3g', '2g', 'slow-2g'])[1 + floor(random() * 4)::int],

  'u-' || (1 + floor(random() * 200)::int)::text,
  's-' || gen_random_uuid()::text,
  (ARRAY['1.4.0', '1.4.1', '1.4.2'])[1 + floor(random() * 3)::int],
  'production'

FROM projects p
CROSS JOIN generate_series(
  date_trunc('hour', now()) - interval '30 days',
  date_trunc('hour', now()),
  interval '1 hour'
) AS h(h)
CROSS JOIN generate_series(1, 3) AS s(n)

WHERE
  -- 空窗①：8 小时前，持续 3 小时 —— 24h 视图上能直接看到断点
  NOT (
        h.h >= date_trunc('hour', now()) - interval '11 hours'
    AND h.h <  date_trunc('hour', now()) - interval '8 hours'
  )
  -- 空窗②：3 天前，持续 6 小时 —— 7d 视图上的断点
  AND NOT (
        h.h >= date_trunc('hour', now()) - interval '3 days'
    AND h.h <  date_trunc('hour', now()) - interval '3 days' + interval '6 hours'
  );

COMMIT;

-- 检查：每个项目的数据量与时间跨度
SELECT p.name,
       count(*)                                    AS rows,
       count(*) FILTER (WHERE pm.lcp IS NULL)      AS lcp_null,
       min(pm."timestamp")                         AS first_seen,
       max(pm."timestamp")                         AS last_seen
  FROM performance_metrics pm
  JOIN projects p ON p.id = pm.project_id
 WHERE pm.event_id LIKE 'seed-%'
 GROUP BY p.name
 ORDER BY p.name;
