// Cloudflare Pages Function：把 /api/* 反代到云服务器后端
// 环境变量 KY_BACKEND_ORIGIN 指定后端基址（默认 kaoyan-api.chatbi.icu）
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const backend = (env && env.KY_BACKEND_ORIGIN) || "https://kaoyan-api.chatbi.icu";
  const base = backend.replace(/\/+$/, "");
  const target = base + url.pathname + url.search;

  const headers = new Headers(request.headers);
  headers.delete("host");

  const init = {
    method: request.method,
    headers,
    redirect: "follow",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  const upstream = await fetch(target, init);
  const respHeaders = new Headers(upstream.headers);
  // 同源部署由 Pages 域提供，无需 CORS；Set-Cookie 与 SSE 流式原样透传
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}
