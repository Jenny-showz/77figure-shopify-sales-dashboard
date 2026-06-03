import { readFile, mkdir, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(siteRoot, "../../..");
const envPath = path.join(workspaceRoot, ".secrets/.env.shopify-tracking-uploader");
const erpEnvPath = path.join(workspaceRoot, ".secrets/.env.erp");
const apiVersion = "2026-04";
const windowDays = 90;
const staleInboundDays = 60;
const now = new Date();
const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
const fullSkuSuffixExceptions = new Set(["WT-WOLF-PARTS-B", "WT-WOLF-PARTS-O"]);
const requestTimeoutMs = Number(process.env.SHOPIFY_REQUEST_TIMEOUT_MS || 30000);
const requestMaxAttempts = Number(process.env.SHOPIFY_REQUEST_ATTEMPTS || 3);
const retryBaseDelayMs = Number(process.env.SHOPIFY_RETRY_BASE_DELAY_MS || 1000);

function parseEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    env[key] = value;
  }
  return env;
}

function cleanEnvValue(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function normalizeDbHost(value) {
  let host = cleanEnvValue(value);
  if (host.includes("=")) host = cleanEnvValue(host.split("=").pop());
  if (/^postgres(ql)?:\/\//i.test(host) || /^https?:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      host = host.replace(/^[a-z]+:\/\//i, "");
    }
  }
  return host.split("/")[0].trim();
}

async function loadPreviousDashboard() {
  const file = path.join(siteRoot, "data/dashboard.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function loadShopifyConfig() {
  let env = {
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN,
    SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN
  };
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN) {
    env = parseEnv(await readFile(envPath, "utf8"));
  }
  const storeDomain = env.SHOPIFY_STORE_DOMAIN?.replace(/^https?:\/\//, "").split("/")[0];
  const token = env.SHOPIFY_ACCESS_TOKEN;
  if (!storeDomain || !token) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN");
  }
  return { storeDomain, token };
}

async function loadErpConfig() {
  let env = {
    ERP_DB_HOST: cleanEnvValue(process.env.ERP_DB_HOST),
    ERP_DB_PORT: cleanEnvValue(process.env.ERP_DB_PORT),
    ERP_DB_NAME: cleanEnvValue(process.env.ERP_DB_NAME),
    ERP_DB_USER: cleanEnvValue(process.env.ERP_DB_USER),
    ERP_DB_PASSWORD: cleanEnvValue(process.env.ERP_DB_PASSWORD)
  };
  if (!env.ERP_DB_HOST || !env.ERP_DB_NAME || !env.ERP_DB_USER || !env.ERP_DB_PASSWORD) {
    if (!fs.existsSync(erpEnvPath)) return null;
    env = parseEnv(await readFile(erpEnvPath, "utf8"));
  }
  const required = ["ERP_DB_HOST", "ERP_DB_NAME", "ERP_DB_USER", "ERP_DB_PASSWORD"];
  if (required.some((key) => !env[key])) return null;
  return {
    host: normalizeDbHost(env.ERP_DB_HOST),
    port: Number(env.ERP_DB_PORT || 5432),
    database: cleanEnvValue(env.ERP_DB_NAME),
    user: cleanEnvValue(env.ERP_DB_USER),
    password: cleanEnvValue(env.ERP_DB_PASSWORD),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

async function shopifyGraphql(config, query, variables) {
  let lastError;
  for (let attempt = 1; attempt <= requestMaxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(`https://${config.storeDomain}/admin/api/${apiVersion}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": config.token
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Shopify returned non-JSON response: ${response.status}`);
      }
      if (!response.ok || payload.errors) {
        const message = JSON.stringify(payload.errors || payload, null, 2);
        if (isRetryableStatus(response.status) && attempt < requestMaxAttempts) {
          throw new Error(`Retryable Shopify response ${response.status}: ${message}`);
        }
        throw new Error(message);
      }
      return payload.data;
    } catch (error) {
      lastError = error;
      if (attempt >= requestMaxAttempts) break;
      await sleep(retryBaseDelayMs * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

const productQuery = `#graphql
query Products($cursor: String) {
  products(first: 100, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      handle
      createdAt
      onlineStoreUrl
      totalInventory
      variants(first: 50) {
        nodes {
          id
          sku
          title
          price
          inventoryQuantity
        }
      }
    }
  }
}`;

const orderQuery = `#graphql
query Orders($cursor: String, $query: String!) {
  orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      cancelledAt
      displayFinancialStatus
      lineItems(first: 100) {
        nodes {
          quantity
          sku
          title
          variantTitle
          originalUnitPriceSet { shopMoney { amount } }
          variant { id }
          product { id }
        }
      }
    }
  }
}`;

async function fetchAllProducts(config) {
  const products = [];
  let cursor = null;
  do {
    const data = await shopifyGraphql(config, productQuery, { cursor });
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return products;
}

async function fetchRecentOrders(config) {
  const orders = [];
  let cursor = null;
  const query = `created_at:>=${since.toISOString().slice(0, 10)} financial_status:paid`;
  do {
    const data = await shopifyGraphql(config, orderQuery, { cursor, query });
    orders.push(...data.orders.nodes);
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);
  return orders.filter((order) => !order.cancelledAt);
}

async function fetchErpInventory() {
  const config = await loadErpConfig();
  if (!config) {
    return { rows: null, connected: false, error: "Missing ERP database configuration" };
  }
  const client = new pg.Client(config);
  try {
    await client.connect();
    const result = await client.query(`
      with stock as (
        select sku_id, stock, pre_stock, purchase_price, transfer_add_price
        from erp.admin_t_gundamit_platform_sku_stock
        where platform = '77figure'
      ),
      inbound as (
        select sku_id, max(created_time) as last_inbound_at
        from erp.admin_t_gundamit_platform_sku_record
        where platform = '77figure'
          and type = 1
        group by sku_id
      ),
      sold as (
        select
          op.sku_id,
          sum(op.product_count)::int as sold_90,
          max(od.created_time) as last_erp_sale_at
        from erp.admin_t_gundamit_platform_order_product op
        join erp.admin_t_gundamit_platform_order_detail od
          on od.id = op.order_detail_id
        where od.shop_platform = '77figure'
          and od.created_time > now() - interval '90 days'
          and coalesce(od.order_status, '') <> 'Cancelled'
          and coalesce(od.refund_status, 0) = 0
        group by op.sku_id
      )
      select
        sku.sku_code,
        sku.name_cn,
        coalesce(fig.sale_status, sku.sale_status) as sale_status,
        coalesce(nullif(fig.price, 0), nullif(sku.price, 0), 0) as erp_price,
        stock.stock,
        stock.pre_stock,
        coalesce(stock.purchase_price, sku.purchase_price, 0) as purchase_price,
        coalesce(stock.transfer_add_price, 0) as transfer_add_price,
        (stock.stock * coalesce(stock.purchase_price, sku.purchase_price, 0)) as stock_cost,
        inbound.last_inbound_at,
        coalesce(sold.sold_90, 0) as erp_sold_90,
        sold.last_erp_sale_at
      from stock
      join erp.admin_t_gundamit_platform_sku sku on sku.id = stock.sku_id
      left join erp.admin_t_dd_platform_figure_sku fig on fig.sku_code = sku.sku_code
      left join inbound on inbound.sku_id = stock.sku_id
      left join sold on sold.sku_id = stock.sku_id
      order by stock_cost desc nulls last
    `);
    return { rows: result.rows, connected: true, error: null };
  } catch (error) {
    const errorLabel = error.code || error.name || "ERROR";
    const safeMessage = error.code
      ? `${error.code} while connecting to ERP database`
      : `Unable to connect to ERP database`;
    console.error(`ERP inventory unavailable: ${errorLabel}`);
    return { rows: null, connected: false, error: safeMessage };
  } finally {
    await client.end().catch(() => {});
  }
}

function daysSince(dateValue) {
  if (!dateValue) return null;
  return (now.getTime() - new Date(dateValue).getTime()) / (24 * 60 * 60 * 1000);
}

function monthsOfStock(stock, sold90) {
  const monthly = Number(sold90 || 0) / 3;
  if (monthly <= 0) return null;
  return Number(stock || 0) / monthly;
}

function stockClearanceAction(item) {
  if (item.saleStatus !== "In Stock") return "状态检查";
  if (item.erpSold90 === 0 && item.stockAgeDays >= staleInboundDays && item.erpStock >= 3) return "建议清仓";
  if (item.stockMonths !== null && item.stockMonths >= 12) return "建议折扣";
  if (item.erpSold90 <= 1) return "低速观察";
  return "继续观察";
}

function shopifyAdminProductUrl(storeDomain, productGid) {
  const id = String(productGid || "").split("/").pop();
  return id ? `https://admin.shopify.com/store/${storeDomain.split(".")[0]}/products/${id}` : "";
}

function isFullSkuSuffixException(sku) {
  return fullSkuSuffixExceptions.has(String(sku || "").trim().toUpperCase());
}

function baseSku(sku) {
  const value = String(sku || "").trim();
  if (isFullSkuSuffixException(value)) return value;
  return value.replace(/-(D|B)$/i, "").replace(/-P$/i, "");
}

function classifySku({ sku, title = "", variantTitle = "", price = 0 }) {
  const value = String(sku || "").trim();
  const text = `${title} ${variantTitle}`;
  const amount = Number(price || 0);
  if (isFullSkuSuffixException(value)) return "normal";
  if (/-D$/i.test(value)) return "deposit";
  if (/-B$/i.test(value)) return "balance";
  if (amount > 0 && amount <= 1000 && text.includes("予約商品")) return "deposit";
  if (/-P$/i.test(value) && /(全額|全额|期間限定)/.test(variantTitle)) return "preorder_full";
  if (/-P$/i.test(value) || text.includes("予約商品")) return "preorder_unknown";
  return "normal";
}

function mergeLatest(left, right) {
  if (!left) return right || null;
  if (!right) return left || null;
  return new Date(left) > new Date(right) ? left : right;
}

function displayStatus(item) {
  const parts = [];
  if (item.normalSold90) parts.push(`普通 ${item.normalSold90}`);
  if (item.preorderFullSold90) parts.push(`全额预约 ${item.preorderFullSold90}`);
  if (item.preorderUnknownQty90) parts.push(`预约待判 ${item.preorderUnknownQty90}`);
  if (item.depositQty90) parts.push(`定金 ${item.depositQty90}`);
  if (item.balanceQty90) parts.push(`尾款 ${item.balanceQty90}`);
  return parts.join(" / ") || "无";
}

function buildDashboard(products, orders, erpInventory, shopifyConfig, previousDashboard) {
  const productGroups = new Map();
  for (const product of products) {
    for (const variant of product.variants.nodes) {
      const sku = variant.sku?.trim();
      if (!sku) continue;
      const skuBase = baseSku(sku);
      const kind = classifySku({
        sku,
        title: product.title,
        variantTitle: variant.title,
        price: variant.price
      });
      if (!productGroups.has(skuBase)) {
        productGroups.set(skuBase, {
        sku: skuBase,
        rawSkus: new Set(),
        title: product.title,
        handle: product.handle,
        productUrl: product.onlineStoreUrl,
        productId: product.id,
        shopifyAdminUrl: shopifyAdminProductUrl(shopifyConfig.storeDomain, product.id),
        productCreatedAt: product.createdAt,
        inventory: 0,
        normalInventory: 0,
        preorderFullInventory: 0,
        preorderDepositInventory: 0,
        preorderUnknownInventory: 0,
        totalInventory: Number(product.totalInventory ?? 0),
        price: Number(variant.price ?? 0),
        normalSold30: 0,
        normalSold90: 0,
        preorderFullSold30: 0,
        preorderFullSold90: 0,
        preorderUnknownQty30: 0,
        preorderUnknownQty90: 0,
        depositQty30: 0,
        depositQty90: 0,
        balanceQty30: 0,
        balanceQty90: 0,
        sold30: 0,
        sold90: 0,
        lastSaleAt: null
      });
      }
      const record = productGroups.get(skuBase);
      record.rawSkus.add(sku);
      const variantInventory = Number(variant.inventoryQuantity ?? 0);
      if (kind === "normal") record.normalInventory += variantInventory;
      else if (kind === "preorder_full") record.preorderFullInventory += variantInventory;
      else if (kind === "deposit") record.preorderDepositInventory += variantInventory;
      else if (kind === "preorder_unknown") record.preorderUnknownInventory += variantInventory;
      if (kind === "normal" || kind === "preorder_full" || kind === "preorder_unknown") record.inventory += variantInventory;
      if (kind === "normal" && !record.productUrl && product.onlineStoreUrl) record.productUrl = product.onlineStoreUrl;
      if (kind === "normal") record.price = Number(variant.price ?? record.price ?? 0);
    }
  }

  for (const order of orders) {
    const orderDate = new Date(order.createdAt);
    const is30d = orderDate >= new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    for (const item of order.lineItems.nodes) {
      const sku = item.sku?.trim();
      const skuBase = baseSku(sku);
      if (!sku || !productGroups.has(skuBase)) continue;
      const record = productGroups.get(skuBase);
      const kind = classifySku({
        sku,
        title: item.title,
        variantTitle: item.variantTitle,
        price: item.originalUnitPriceSet?.shopMoney?.amount
      });
      const qty = Number(item.quantity || 0);
      if (kind === "deposit") {
        record.depositQty90 += qty;
        if (is30d) record.depositQty30 += qty;
        record.sold90 += qty;
        if (is30d) record.sold30 += qty;
        record.lastSaleAt = mergeLatest(record.lastSaleAt, order.createdAt);
      } else if (kind === "balance") {
        record.balanceQty90 += qty;
        if (is30d) record.balanceQty30 += qty;
      } else if (kind === "preorder_full") {
        record.preorderFullSold90 += qty;
        if (is30d) record.preorderFullSold30 += qty;
        record.sold90 += qty;
        if (is30d) record.sold30 += qty;
        record.lastSaleAt = mergeLatest(record.lastSaleAt, order.createdAt);
      } else if (kind === "preorder_unknown") {
        record.preorderUnknownQty90 += qty;
        if (is30d) record.preorderUnknownQty30 += qty;
        record.sold90 += qty;
        if (is30d) record.sold30 += qty;
        record.lastSaleAt = mergeLatest(record.lastSaleAt, order.createdAt);
      } else {
        record.normalSold90 += qty;
        if (is30d) record.normalSold30 += qty;
        record.sold90 += qty;
        if (is30d) record.sold30 += qty;
        record.lastSaleAt = mergeLatest(record.lastSaleAt, order.createdAt);
      }
    }
  }

  const records = [...productGroups.values()].map((item) => ({
    ...item,
    rawSkus: [...item.rawSkus].sort(),
    salesStatusText: displayStatus(item),
    daysSinceLastSale: daysSince(item.lastSaleAt),
    productAgeDays: daysSince(item.productCreatedAt)
  }));

  const recordBySku = new Map(records.map((item) => [item.sku, item]));
  const hasFreshErpRows = Array.isArray(erpInventory.rows);
  const erpRows = (erpInventory.rows || []).map((row) => {
    const sku = String(row.sku_code || "").trim();
    const linked = recordBySku.get(sku) || null;
    const erpStock = Number(row.stock || 0);
    const erpSold90 = Number(row.erp_sold_90 || 0);
    const stockAgeDays = daysSince(row.last_inbound_at);
    const stockMonths = monthsOfStock(erpStock, erpSold90);
    const releaseAmount = Number(row.stock_cost || 0);
    return {
      sku,
      rawSkus: linked?.rawSkus || [sku],
      title: linked?.title || row.name_cn || "",
      handle: linked?.handle || "",
      productUrl: linked?.productUrl || "",
      productId: linked?.productId || "",
      shopifyAdminUrl: linked?.shopifyAdminUrl || "",
      saleStatus: row.sale_status || "",
      erpStock,
      shopifyInventory: Number(linked?.inventory ?? 0),
      shopifyTotalInventory: Number(linked?.totalInventory ?? 0),
      purchasePrice: Number(row.purchase_price || 0),
      releaseAmount,
      erpSold90,
      shopifySold90: Number(linked?.sold90 || 0),
      salesStatusText: linked?.salesStatusText || "",
      lastInboundAt: row.last_inbound_at,
      lastErpSaleAt: row.last_erp_sale_at,
      stockAgeDays,
      stockMonths,
      action: ""
    };
  });

  const soldOutAlerts = records
    .flatMap((item) => {
      const rows = [];
      const hasPreorderFullOption = item.rawSkus.some((sku) => /-P$/i.test(sku));
      const hasPreorderDepositOption = item.rawSkus.some((sku) => /-D$/i.test(sku));
      const hasPreorderOptions = hasPreorderFullOption || hasPreorderDepositOption;
      if (hasPreorderOptions) {
        if (hasPreorderFullOption && item.preorderFullSold90 > 0 && item.preorderFullInventory <= 0) {
          rows.push({
            ...item,
            alertOption: "预售全额",
            alertInventory: item.preorderFullInventory,
            sold30: item.preorderFullSold30,
            sold90: item.preorderFullSold90
          });
        }
        if (hasPreorderDepositOption && item.depositQty90 > 0 && item.preorderDepositInventory <= 0) {
          rows.push({
            ...item,
            alertOption: "预售定金",
            alertInventory: item.preorderDepositInventory,
            sold30: item.depositQty30,
            sold90: item.depositQty90
          });
        }
        return rows;
      }
      if (item.normalInventory <= 0 && item.normalSold90 > 0) {
        rows.push({
          ...item,
          alertOption: "普通库存",
          alertInventory: item.normalInventory,
          sold30: item.normalSold30,
          sold90: item.normalSold90
        });
      }
      return rows;
    })
    .map((item) => ({
      ...item,
      action: item.sold30 >= 3 ? "优先补货" : item.sold90 >= 3 ? "评估补货" : "观察需求"
    }))
    .sort((a, b) => b.sold30 - a.sold30 || b.sold90 - a.sold90)
    .slice(0, 30);

  const slowMovingAlerts = records
    .filter((item) => item.inventory > 0 && item.productAgeDays >= 60 && item.sold90 <= 1)
    .map((item) => ({
      ...item,
      action: item.sold90 === 0 && item.inventory >= 3 ? "建议清仓/折扣" : "继续观察"
    }))
    .sort((a, b) => b.inventory - a.inventory || a.sold90 - b.sold90)
    .slice(0, 30);

  const stockClearanceSuggestions = hasFreshErpRows ? erpRows
    .filter((item) => item.erpStock > 0)
    .filter((item) => item.saleStatus === "In Stock")
    .filter((item) => item.stockAgeDays === null || item.stockAgeDays >= staleInboundDays)
    .filter((item) => item.erpSold90 <= 1 || (item.stockMonths !== null && item.stockMonths >= 12))
    .map((item) => ({
      ...item,
      action: stockClearanceAction(item)
    }))
    .sort((a, b) => b.releaseAmount - a.releaseAmount || b.erpStock - a.erpStock)
    .slice(0, 50) : (previousDashboard?.stockClearanceSuggestions || []);

  const shopifyProductChecks = hasFreshErpRows ? records
    .map((item) => {
      const erp = erpRows.find((row) => row.sku === item.sku);
      const erpStock = Number(erp?.erpStock || 0);
      const shopifyInventory = Number(item.inventory || 0);
      const soldOutTitleMissing = erpStock <= 0 && shopifyInventory <= 0 && !String(item.title || "").startsWith("【品切れ】");
      const inventoryMismatch = Boolean(erp) && erpStock !== shopifyInventory;
      let issue = "";
      if (soldOutTitleMissing) issue = "售罄标题缺标记";
      else if (inventoryMismatch) issue = "库存不一致";
      return {
        ...item,
        erpStock,
        shopifyInventory,
        issue,
        severity: soldOutTitleMissing ? "critical" : inventoryMismatch ? "warning" : "normal"
      };
    })
    .filter((item) => item.issue)
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
      return Math.abs(b.erpStock - b.shopifyInventory) - Math.abs(a.erpStock - a.shopifyInventory);
    }) : (previousDashboard?.shopifyProductChecks || []);

  const fallbackSummary = previousDashboard?.summary || {};

  return {
    generatedAt: now.toISOString(),
    windowDays,
    summary: {
      trackedSkus: records.length,
      soldOutAlerts: soldOutAlerts.length,
      slowMovingAlerts: slowMovingAlerts.length,
      stockClearanceSuggestions: stockClearanceSuggestions.length,
      productCheckIssues: shopifyProductChecks.length,
      erpStockSkus: hasFreshErpRows ? erpRows.length : (fallbackSummary.erpStockSkus || 0),
      erpStockValue: hasFreshErpRows
        ? Math.round(erpRows.reduce((sum, item) => sum + item.releaseAmount, 0))
        : (fallbackSummary.erpStockValue || 0),
      clearanceReleaseValue: Math.round(stockClearanceSuggestions.reduce((sum, item) => sum + item.releaseAmount, 0)),
      unitsSold90: records.reduce((sum, item) => sum + item.sold90, 0),
      depositQty90: records.reduce((sum, item) => sum + item.depositQty90, 0),
      balanceQty90: records.reduce((sum, item) => sum + item.balanceQty90, 0)
    },
    erpInventory: {
      connected: erpInventory.connected,
      error: erpInventory.error,
      fallbackFromPreviousRun: !hasFreshErpRows,
      staleInboundDays
    },
    soldOutAlerts,
    slowMovingAlerts,
    stockClearanceSuggestions,
    shopifyProductChecks
  };
}

const config = await loadShopifyConfig();
const previousDashboard = await loadPreviousDashboard();
const [products, orders, erpInventory] = await Promise.all([
  fetchAllProducts(config),
  fetchRecentOrders(config),
  fetchErpInventory()
]);
const dashboard = buildDashboard(products, orders, erpInventory, config, previousDashboard);

await mkdir(path.join(siteRoot, "data"), { recursive: true });
await writeFile(
  path.join(siteRoot, "data/dashboard.json"),
  `${JSON.stringify(dashboard, null, 2)}\n`,
  "utf8"
);

console.log(JSON.stringify({
  generatedAt: dashboard.generatedAt,
  trackedSkus: dashboard.summary.trackedSkus,
  soldOutAlerts: dashboard.summary.soldOutAlerts,
  slowMovingAlerts: dashboard.summary.slowMovingAlerts,
  stockClearanceSuggestions: dashboard.summary.stockClearanceSuggestions,
  productCheckIssues: dashboard.summary.productCheckIssues,
  unitsSold90: dashboard.summary.unitsSold90
}, null, 2));
