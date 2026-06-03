import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(siteRoot, "../../..");
const envPath = path.join(workspaceRoot, ".secrets/.env.shopify-tracking-uploader");
const apiVersion = "2026-04";
const port = Number(process.env.DASHBOARD_ACTION_PORT || 8787);
const host = process.env.DASHBOARD_ACTION_HOST || "127.0.0.1";
const allowedOrigins = new Set([
  "https://jenny-showz.github.io",
  "http://localhost:4177",
  "http://127.0.0.1:4177"
]);

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
  let env = {
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN,
    SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN
  };
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN) {
    env = parseEnv(await readFile(envPath, "utf8"));
  }
  const storeDomain = env.SHOPIFY_STORE_DOMAIN?.replace(/^https?:\/\//, "").split("/")[0];
  const token = env.SHOPIFY_ACCESS_TOKEN;
  if (!storeDomain || !token) throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN");
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
  const payload = await response.json();
  if (!response.ok || payload.errors) throw new Error(JSON.stringify(payload.errors || payload, null, 2));
  return payload.data;
}

const productQuery = `#graphql
query Product($id: ID!) {
  product(id: $id) {
    id
    title
    handle
  }
}`;

const updateProductMutation = `#graphql
mutation UpdateProduct($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id title handle }
    userErrors { field message }
  }
}`;

function nextTitle(action, title) {
  const soldOutPrefix = "【品切れ】";
  const clean = String(title || "").replace(/^【品切れ】\s*/, "");
  if (action === "mark-sold-out") return `${soldOutPrefix}${clean}`;
  if (action === "end-preorder") return String(title || "").replace("【予約商品】", "【予約受付終了】");
  if (action === "restock") return clean;
  throw new Error(`Unsupported action: ${action}`);
}

function setCors(response, request) {
  const origin = request.headers.origin;
  if (allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function send(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function handleAction(payload) {
  const action = String(payload.action || "");
  const productId = String(payload.productId || payload.product || "");
  if (!action || !productId) throw new Error("Missing action or productId");

  const config = await loadConfig();
  const productData = await shopifyGraphql(config, productQuery, { id: productId });
  const product = productData.product;
  if (!product) throw new Error(`Product not found: ${productId}`);

  const title = nextTitle(action, product.title);
  const plan = {
    action,
    product: product.id,
    handle: product.handle,
    beforeTitle: product.title,
    afterTitle: title
  };
  if (product.title === title) return { ok: true, changed: false, ...plan };

  const updateData = await shopifyGraphql(config, updateProductMutation, {
    product: { id: product.id, title }
  });
  const errors = updateData.productUpdate.userErrors || [];
  if (errors.length) throw new Error(JSON.stringify(errors, null, 2));
  return { ok: true, changed: true, ...plan, product: updateData.productUpdate.product };
}

const server = http.createServer(async (request, response) => {
  setCors(response, request);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    send(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || request.url !== "/shopify-product-action") {
    send(response, 404, { ok: false, error: "Not found" });
    return;
  }
  try {
    const payload = await readJson(request);
    const result = await handleAction(payload);
    send(response, 200, result);
  } catch (error) {
    send(response, 500, { ok: false, error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Dashboard action server listening on http://${host}:${port}`);
});
