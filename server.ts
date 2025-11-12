import { Hono } from "https://deno.land/x/hono@v3.11.7/mod.ts";
import type { Context } from "https://deno.land/x/hono@v3.11.7/mod.ts";
import { getHomeHtml } from "./views/home.ts";

const app = new Hono();

app.get("/", (c: Context) => {
  const html = getHomeHtml();
  return c.html(html);
});

app.get("*", (c: Context) => c.text("Not found", 404));

console.log("Serving with Hono on http://localhost:8000");
Deno.serve({ port: 8000 }, app.fetch);
