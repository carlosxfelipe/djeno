import { Hono } from "hono";
import type { Context } from "hono";
import { getHomeHtml } from "@views/home.ts";
import { getAboutHtml } from "@views/about.ts";

const app = new Hono();

app.get("/", (c: Context) => {
  const html = getHomeHtml();
  return c.html(html);
});

app.get("/about", (c: Context) => {
  const html = getAboutHtml();
  return c.html(html);
});

app.get("*", (c: Context) => c.text("Not found", 404));

console.log("Serving with Hono on http://localhost:8000");
Deno.serve({ port: 8000 }, app.fetch);
