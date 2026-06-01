# 77figure Shopify 销售监控

第 14 级部署练习项目：用本地只读脚本生成 Shopify 销售监控数据，再部署为静态网页。

## 本地生成

```bash
node scripts/build-dashboard.mjs
```

脚本读取本机 `.secrets/.env.shopify-tracking-uploader`，不会把 token 写入 `data/dashboard.json` 或前端页面。

## 分析口径

- 售罄补货提醒：当前 SKU 库存小于等于 0，且近 90 天有销量。
- 优先补货：售罄且近 30 天销量大于等于 3。
- 评估补货：售罄且近 90 天销量大于等于 3。
- 滞销/折扣提醒：库存大于 0、商品创建超过 60 天、近 90 天销量小于等于 1。
- 建议清仓/折扣：近 90 天 0 销量且库存大于等于 3。

## 安全边界

- 前端不保存 Shopify token。
- 输出只包含 SKU、商品标题、库存、销量和建议，不包含客户信息。
- GitHub Pages 只发布静态页面和聚合数据。
