import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(siteRoot, "../../../..");
const envPath = path.join(workspaceRoot, ".secrets/.env.shopify-tracking-uploader");
const apiVersion = "2026-04";
const windowDays = 90;
const now = new Date();
const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

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

async function loadConfig() {
  const env = parseEnv(await readFile(envPath, "utf8"));
  const storeDomain = env.SHOPIFY_STORE_DOMAIN?.replace(/^https?:\/\//, "").split("/")[0];
  const token = env.SHOPIFY_ACCESS_TOKEN;
  if (!storeDomain || !token) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN");
  }
  return { storeDomain, token };
}

async function shopifyGraphql(config, query, variables) {
  const response = await fetch(`https://${config.storeDomain}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.token
    },
    body: JSON.stringify({ query, variables })
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Shopify returned non-JSON response: ${response.status}`);
  }
  if (!response.ok || payload.errors) {
    throw new Error(JSON.stringify(payload.errors || payload, null, 2));
  }
  return payload.data;
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

function daysSince(dateValue) {
  if (!dateValue) return null;
  return (now.getTime() - new Date(dateValue).getTime()) / (24 * 60 * 60 * 1000);
}

function buildDashboard(products, orders) {
  const variants = new Map();
  for (const product of products) {
    for (const variant of product.variants.nodes) {
      const sku = variant.sku?.trim();
      if (!sku) continue;
      variants.set(sku, {
        sku,
        title: product.title,
        handle: product.handle,
        productUrl: product.onlineStoreUrl,
        productCreatedAt: product.createdAt,
        inventory: Number(variant.inventoryQuantity ?? 0),
        totalInventory: Number(product.totalInventory ?? 0),
        price: Number(variant.price ?? 0),
        sold30: 0,
        sold90: 0,
        lastSaleAt: null
      });
    }
  }

  for (const order of orders) {
    const orderDate = new Date(order.createdAt);
    const is30d = orderDate >= new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    for (const item of order.lineItems.nodes) {
      const sku = item.sku?.trim();
      if (!sku || !variants.has(sku)) continue;
      const record = variants.get(sku);
      const qty = Number(item.quantity || 0);
      record.sold90 += qty;
      if (is30d) record.sold30 += qty;
      if (!record.lastSaleAt || orderDate > new Date(record.lastSaleAt)) {
        record.lastSaleAt = order.createdAt;
      }
    }
  }

  const records = [...variants.values()].map((item) => ({
    ...item,
    daysSinceLastSale: daysSince(item.lastSaleAt),
    productAgeDays: daysSince(item.productCreatedAt)
  }));

  const soldOutAlerts = records
    .filter((item) => item.inventory <= 0 && item.sold90 > 0)
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

  return {
    generatedAt: now.toISOString(),
    windowDays,
    summary: {
      trackedSkus: records.length,
      soldOutAlerts: soldOutAlerts.length,
      slowMovingAlerts: slowMovingAlerts.length,
      unitsSold90: records.reduce((sum, item) => sum + item.sold90, 0)
    },
    soldOutAlerts,
    slowMovingAlerts
  };
}

const config = await loadConfig();
const [products, orders] = await Promise.all([
  fetchAllProducts(config),
  fetchRecentOrders(config)
]);
const dashboard = buildDashboard(products, orders);

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
  unitsSold90: dashboard.summary.unitsSold90
}, null, 2));
