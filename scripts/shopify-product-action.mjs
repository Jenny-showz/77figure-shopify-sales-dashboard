import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(siteRoot, "../../..");
const envPath = path.join(workspaceRoot, ".secrets/.env.shopify-tracking-uploader");
const apiVersion = "2026-04";

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

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--commit") {
      args.commit = true;
      continue;
    }
    if (arg.startsWith("--")) {
      args[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return args;
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
  if (action === "restock") return clean;
  throw new Error(`Unsupported action: ${action}`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.action || !args.product) {
  throw new Error("Usage: node scripts/shopify-product-action.mjs --action mark-sold-out|restock --product gid://shopify/Product/... [--commit]");
}

const config = await loadConfig();
const productData = await shopifyGraphql(config, productQuery, { id: args.product });
const product = productData.product;
if (!product) throw new Error(`Product not found: ${args.product}`);

const title = nextTitle(args.action, product.title);
const plan = {
  mode: args.commit ? "commit" : "dry-run",
  action: args.action,
  product: product.id,
  handle: product.handle,
  beforeTitle: product.title,
  afterTitle: title
};
console.log(JSON.stringify(plan, null, 2));

if (!args.commit || product.title === title) {
  if (!args.commit) console.log("DRY_RUN_ONLY: add --commit to execute");
  process.exit(0);
}

const updateData = await shopifyGraphql(config, updateProductMutation, {
  product: { id: product.id, title }
});
const errors = updateData.productUpdate.userErrors || [];
if (errors.length) throw new Error(JSON.stringify(errors, null, 2));
console.log(JSON.stringify({ ok: true, product: updateData.productUpdate.product }, null, 2));
