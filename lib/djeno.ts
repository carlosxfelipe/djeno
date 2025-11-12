const TEMPLATES_DIR = "./templates";

type Context = Record<string, unknown>;
type FilterFn = (v: unknown, arg?: unknown) => unknown;

type IfFrame = {
  type: "if-frame";
  nodes: Node[];
  extra: {
    branches: Array<{ test: string | null; body: Node[] }>;
    current: number;
  };
};

type ForFrame = {
  type: "for";
  nodes: Node[];
  extra: { varName: string; iterableExpr: string };
};

type BlockFrame = {
  type: "block";
  nodes: Node[];
  extra: { name: string };
};

type StackFrame = IfFrame | ForFrame | BlockFrame;
type Token = { type: "text" | "var" | "tag"; content: string };

type Node =
  | { type: "text"; text: string }
  | { type: "var"; expr: string }
  | { type: "if"; branches: Array<{ test: string | null; body: Node[] }> }
  | { type: "for"; varName: string; iterableExpr: string; body: Node[] }
  | { type: "include"; path: string }
  | { type: "block"; name: string; body: Node[] }
  | { type: "extends"; path: string };

function readFile(path: string): string {
  return Deno.readTextFileSync(path);
}

function joinPath(...parts: string[]) {
  return parts.join("/").replace(/\\/g, "/");
}

function resolvePath(context: Context, path: string) {
  const parts = path.trim().split(".");
  let cur: unknown = context;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const filters: Record<string, FilterFn> = {
  upper: (v) => (typeof v === "string" ? v.toUpperCase() : v),
  lower: (v) => (typeof v === "string" ? v.toLowerCase() : v),
};

class SafeString {
  private value: string;
  constructor(v: string) {
    this.value = v;
  }
  toString() {
    return this.value;
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeClosingScript(json: string): string {
  return json.replace(/<\/script/gi, "</script");
}

filters["safe"] = (v: unknown): SafeString => {
  if (v == null) return new SafeString("");
  return new SafeString(String(v));
};

filters["escapejs"] = (v: unknown): string => {
  if (v == null) return '""';
  const s = String(v)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/<\/script/gi, "<\\/script");
  return `"${s}"`;
};

filters["raw_json"] = (v: unknown): string => {
  try {
    return escapeClosingScript(JSON.stringify(v));
  } catch {
    return "null";
  }
};

filters["raw_json_escaped"] = filters["raw_json"];

filters["json_script"] = (v: unknown, arg?: unknown): SafeString => {
  const id = typeof arg === "string"
    ? arg
    : arg == null
    ? "__data__"
    : String(arg);
  try {
    const payload = escapeClosingScript(JSON.stringify(v));
    const html = `<script id="${
      escapeHtml(
        id,
      )
    }" type="application/json">${payload}</script>`;
    return new SafeString(html);
  } catch {
    return new SafeString(
      `<script id="${escapeHtml(id)}" type="application/json">null</script>`,
    );
  }
};

function lex(template: string): Token[] {
  const tokens: Token[] = [];
  const re = /({{\s*([\s\S]+?)\s*}})|({%\s*([\s\S]+?)\s*%})/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({
        type: "text",
        content: template.slice(lastIndex, m.index),
      });
    }
    if (m[1]) {
      tokens.push({ type: "var", content: m[2].trim() });
    } else if (m[3]) {
      tokens.push({ type: "tag", content: m[4].trim() });
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < template.length) {
    tokens.push({ type: "text", content: template.slice(lastIndex) });
  }
  return tokens;
}

function parse(tokens: Token[]): Node[] {
  const out: Node[] = [];
  const stack: StackFrame[] = [];

  function pushNode(n: Node) {
    if (stack.length === 0) {
      out.push(n);
      return;
    }
    const top = stack[stack.length - 1];
    if (top.type === "if-frame") {
      top.extra.branches[top.extra.current].body.push(n);
    } else {
      top.nodes.push(n);
    }
  }

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i++];

    if (t.type === "text") {
      pushNode({ type: "text", text: t.content });
      continue;
    }

    if (t.type === "var") {
      pushNode({ type: "var", expr: t.content });
      continue;
    }

    if (t.type === "tag") {
      const parts = t.content.split(/\s+/);
      const tag = parts[0];

      if (tag === "if") {
        const test = t.content.slice(3).trim();
        const frame: IfFrame = {
          type: "if-frame",
          nodes: [],
          extra: { branches: [{ test, body: [] }], current: 0 },
        };
        stack.push(frame);
        continue;
      }

      if (tag === "elif" || tag === "else") {
        const top = stack[stack.length - 1];
        if (!top || top.type !== "if-frame") {
          throw new Error("Unexpected " + tag);
        }
        const cond = tag === "elif" ? t.content.slice(4).trim() : null;
        top.extra.branches.push({ test: cond, body: [] });
        top.extra.current = top.extra.branches.length - 1;
        continue;
      }

      if (tag === "endif") {
        const frame = stack.pop();
        if (!frame || frame.type !== "if-frame") {
          throw new Error("Unexpected endif");
        }
        const node: Node = { type: "if", branches: frame.extra.branches };
        pushNode(node);
        continue;
      }

      if (tag === "for") {
        const m = t.content.match(/^for\s+(\w+)\s+in\s+([\s\S]+)$/);
        if (!m) throw new Error("Invalid for tag");
        const varName = m[1];
        const iterableExpr = m[2].trim();
        const frame: ForFrame = {
          type: "for",
          nodes: [],
          extra: { varName, iterableExpr },
        };
        stack.push(frame);
        continue;
      }

      if (tag === "endfor") {
        const frame = stack.pop();
        if (!frame || frame.type !== "for") {
          throw new Error("Unexpected endfor");
        }
        const node: Node = {
          type: "for",
          varName: frame.extra.varName,
          iterableExpr: frame.extra.iterableExpr,
          body: frame.nodes,
        };
        pushNode(node);
        continue;
      }

      if (tag === "include") {
        const m = t.content.match(/^include\s+"([^"]+)"$/);
        if (!m) throw new Error("Invalid include");
        pushNode({ type: "include", path: m[1] });
        continue;
      }

      if (tag === "block") {
        const m = t.content.match(/^block\s+(\w+)$/);
        if (!m) throw new Error("Invalid block");
        const frame: BlockFrame = {
          type: "block",
          nodes: [],
          extra: { name: m[1] },
        };
        stack.push(frame);
        continue;
      }

      if (tag === "endblock") {
        const frame = stack.pop();
        if (!frame || frame.type !== "block") {
          throw new Error("Unexpected endblock");
        }
        const node: Node = {
          type: "block",
          name: frame.extra.name,
          body: frame.nodes,
        };
        pushNode(node);
        continue;
      }

      if (tag === "extends") {
        const m = t.content.match(/^extends\s+"([^"]+)"$/);
        if (!m) throw new Error("Invalid extends");
        pushNode({ type: "extends", path: m[1] });
        continue;
      }

      pushNode({ type: "text", text: `{% ${t.content} %}` });
    }
  }

  if (stack.length) throw new Error("Unclosed tags in template");
  return out;
}

function evalTestExpression(expr: string, context: any): boolean {
  expr = expr.trim();
  if (!expr) return false;
  const cmp = expr.match(/^(.*?)\s*(==|!=|>=|<=|>|<)\s*(.*?)$/);
  if (cmp) {
    const left = getValueFromExpr(cmp[1], context);
    const right = getValueFromExpr(cmp[3], context);
    switch (cmp[2]) {
      case "==":
        return left == right;
      case "!=":
        return left != right;
      case ">":
        return left > right;
      case "<":
        return left < right;
      case ">=":
        return left >= right;
      case "<=":
        return left <= right;
    }
  }
  const v = getValueFromExpr(expr, context);
  return !!v;
}

function getValueFromExpr(expr: string, context: any): any {
  expr = expr.trim();
  if (/^\d+(?:\.\d+)?$/.test(expr)) return Number(expr);
  const q = expr.match(/^"([\s\S]*)"$/) || expr.match(/^'([\s\S]*)'$/);
  if (q) return q[1];
  const parts = expr.split("|").map((p) => p.trim());
  let val = resolvePath(context, parts[0]);
  for (let i = 1; i < parts.length; i++) {
    const f = parts[i];
    const fname = f.split(":")[0];
    const farg = f.includes(":") ? f.split(":")[1] : undefined;
    const filterFn = filters[fname];
    if (filterFn) val = filterFn(val, farg);
  }
  return val;
}

function renderNodes(
  nodes: Node[],
  context: any,
  loader: TemplateLoader,
): string {
  let out = "";
  const blocks: Record<string, Node[]> = {};
  let hasExtends = false;
  let extendsPath = "";

  for (const n of nodes) {
    if (n.type === "block") {
      blocks[n.name] = n.body;
    }
    if (n.type === "extends") {
      hasExtends = true;
      extendsPath = n.path;
    }
  }

  if (hasExtends) {
    const parent = loader.load(extendsPath);
    return renderParentWithChild(parent.ast, context, loader, blocks);
  }

  function renderNode(n: Node): string {
    if (n.type === "text") return n.text;
    if (n.type === "var") {
      const val = getValueFromExpr(n.expr, context);
      return val == null ? "" : String(val);
    }
    if (n.type === "include") {
      const tpl = loader.load(n.path);
      return renderNodes(tpl.ast, context, loader);
    }
    if (n.type === "block") {
      return renderNodes(n.body, context, loader);
    }
    if (n.type === "if") {
      for (const br of n.branches) {
        const test = br.test;
        if (test == null) {
          return renderNodes(br.body, context, loader);
        } else if (evalTestExpression(test, context)) {
          return renderNodes(br.body, context, loader);
        }
      }
      return "";
    }
    if (n.type === "for") {
      const iterable = getValueFromExpr(n.iterableExpr, context) || [];
      let res = "";
      if (Array.isArray(iterable)) {
        for (const it of iterable) {
          const childCtx = { ...context };
          childCtx[n.varName] = it;
          res += renderNodes(n.body, childCtx, loader);
        }
      } else if (typeof iterable === "object") {
        for (const key of Object.keys(iterable)) {
          const childCtx = { ...context };
          childCtx[n.varName] = iterable[key];
          res += renderNodes(n.body, childCtx, loader);
        }
      }
      return res;
    }
    return "";
  }

  for (const n of nodes) {
    out += renderNode(n);
  }
  return out;
}

function renderParentWithChild(
  parentNodes: Node[],
  context: any,
  loader: TemplateLoader,
  childBlocks: Record<string, Node[]>,
): string {
  let out = "";
  for (const n of parentNodes) {
    if (n.type === "block") {
      if (childBlocks[n.name]) {
        out += renderNodes(childBlocks[n.name], context, loader);
      } else {
        out += renderNodes(n.body, context, loader);
      }
    } else if (n.type === "extends") {
      const parent = loader.load(n.path);
      out += renderParentWithChild(parent.ast, context, loader, childBlocks);
    } else if (n.type === "include") {
      const tpl = loader.load(n.path);
      out += renderNodes(tpl.ast, context, loader);
    } else {
      out += renderNodes([n], context, loader);
    }
  }
  return out;
}

class Template {
  path: string;
  src: string;
  ast: Node[];
  constructor(path: string, src: string, ast: Node[]) {
    this.path = path;
    this.src = src;
    this.ast = ast;
  }
}

class TemplateLoader {
  dir: string;
  cache = new Map<string, Template>();
  constructor(dir: string) {
    this.dir = dir;
  }

  load(relpath: string): Template {
    if (this.cache.has(relpath)) return this.cache.get(relpath)!;
    const full = joinPath(this.dir, relpath);
    const src = readFile(full);
    const tokens = lex(src);
    const ast = parse(tokens);
    const tpl = new Template(relpath, src, ast);
    this.cache.set(relpath, tpl);
    return tpl;
  }
}

const loader = new TemplateLoader(TEMPLATES_DIR);

function renderTemplate(path: string, context: any = {}) {
  const tpl = loader.load(path);
  const html = renderNodes(tpl.ast, context, loader);
  return html;
}

export { renderTemplate, TemplateLoader };
