# 77figure Shopify 销售监控

第 14 级部署练习项目：用本地只读脚本生成 Shopify 销售监控数据，再部署为静态网页。

## 本地生成

```bash
node scripts/build-dashboard.mjs
```

脚本读取本机 `.secrets/.env.shopify-tracking-uploader`，不会把 token 写入 `data/dashboard.json` 或前端页面。

## 稳定更新

第 15 级定时任务准备版：

```bash
node scripts/run-dashboard-update.mjs
```

包装脚本提供整轮 timeout、整轮 retry、运行日志和状态文件：

- 日志：`logs/dashboard-update-*.log`
- 成功状态：`data/last-run.json`
- 失败状态：`data/last-error.json`

默认值：

- `DASHBOARD_UPDATE_TIMEOUT_MS=600000`
- `DASHBOARD_UPDATE_ATTEMPTS=2`
- `SHOPIFY_REQUEST_TIMEOUT_MS=30000`
- `SHOPIFY_REQUEST_ATTEMPTS=3`

## GitHub Actions

线上自动更新使用 `.github/workflows/update-dashboard.yml`：

- 每天 UTC 01:00 自动运行，即北京时间 09:00。
- 支持在 GitHub Actions 页面手动触发 `workflow_dispatch`。
- 读取 GitHub Secrets：`SHOPIFY_STORE_DOMAIN`、`SHOPIFY_ACCESS_TOKEN`。
- 成功后只提交 `data/dashboard.json` 和 `data/last-run.json`。
- `logs/` 不提交到仓库。

## SKU 归一化口径

看板复用 `77运营/ERP录单自动化/定尾收款` 的定尾逻辑，先把销售状态 SKU 归到基础 SKU，再做补货和滞销判断。

- `-D`：定金，归入基础 SKU，但不计入实销。
- `-B`：尾款，归入基础 SKU，但不计入实销。
- `-P`：预约期全额，归入基础 SKU；当变体文案包含 `全額`、`全额`、`期間限定` 时计入实销。
- 预约商品但无法自动判断全额/定尾的订单，归入 `预约待判`，暂计入实销但在状态拆分中标出。
- 例外完整 SKU：`WT-WOLF-PARTS-B`、`WT-WOLF-PARTS-O` 不剥离后缀。

## 分析口径

- 售罄补货提醒：当前 SKU 库存小于等于 0，且近 90 天有销量。
- 优先补货：售罄且近 30 天销量大于等于 3。
- 评估补货：售罄且近 90 天销量大于等于 3。
- 滞销/折扣提醒：库存大于 0、商品创建超过 60 天、近 90 天销量小于等于 1。
- 建议清仓/折扣：近 90 天 0 销量且库存大于等于 3。
- 实销不包含定金和尾款，避免同一个预售商品因定金+尾款被重复计数。

## 安全边界

- 前端不保存 Shopify token。
- 输出只包含 SKU、商品标题、库存、销量和建议，不包含客户信息。
- GitHub Pages 只发布静态页面和聚合数据。
