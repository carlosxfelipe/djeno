import { renderTemplate } from "@lib/djeno.ts";

export function getHomeHtml() {
  const context = {
    title: "Home",
    user: { name: "Isabelle" },
    items: ["Item 1", "Item 2", "Item 3"],
    page_data: { message: "Oi do servidor!", count: 42 },
  };
  return renderTemplate("index.html", context);
}
