import { renderTemplate } from "@lib/djeno.ts";

export function getAboutHtml() {
  const context = {
    title: "Sobre o djeno.ts",
  };
  return renderTemplate("about.html", context);
}
