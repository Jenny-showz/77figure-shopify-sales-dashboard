const apiVersion = "2026-04";
const defaultAllowedOrigins = [
  "https://jenny-showz.github.io",
  "http://localhost:4177",
  "http://127.0.0.1:4177"
];

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .concat(defaultAllowedOrigins);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = allowedOrigins(env);
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Dashboard-Action-Secret",
    "Content-Type": "application/json; charset=utf-8"
  };
  if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(request, env, status, payload) {
  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    status,
    headers: corsHeaders(request, env)
  });
}

async function shopifyGraphql(env, query, variables) {
  const storeDomain = String(env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").split("/")[0];
  if (!storeDomain || !env.SHOPIFY_ACCESS_TOKEN) {
    throw new Error("Missing Shopify configuration");
  }
  const response = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const payload = await response.json();
  if (!response.ok || payload.errors) throw new Error(JSON.stringify(payload.errors || payload));
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

function assertAuthorized(request, env) {
  if (!env.DASHBOARD_ACTION_SECRET) return;
  const supplied = request.headers.get("X-Dashboard-Action-Secret") || "";
  if (supplied !== env.DASHBOARD_ACTION_SECRET) throw new Error("Unauthorized");
}

async function handleAction(request, env) {
  assertAuthorized(request, env);
  const payload = await request.json();
  const action = String(payload.action || "");
  const productId = String(payload.productId || payload.product || "");
  if (!action || !productId) throw new Error("Missing action or productId");

  const productData = await shopifyGraphql(env, productQuery, { id: productId });
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

  const updateData = await shopifyGraphql(env, updateProductMutation, {
    product: { id: product.id, title }
  });
  const errors = updateData.productUpdate.userErrors || [];
  if (errors.length) throw new Error(JSON.stringify(errors));
  return { ok: true, changed: true, ...plan, product: updateData.productUpdate.product };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json(request, env, 200, { ok: true });
    if (request.method !== "POST" || url.pathname !== "/shopify-product-action") {
      return json(request, env, 404, { ok: false, error: "Not found" });
    }
    try {
      const result = await handleAction(request, env);
      return json(request, env, 200, result);
    } catch (error) {
      const status = error.message === "Unauthorized" ? 401 : 500;
      return json(request, env, status, { ok: false, error: error.message });
    }
  }
};
