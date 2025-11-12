const TEMPLATES_DIR = "./templates";

type Context = Record<string, unknown>;
type FilterFn = (v: unknown, arg?: unknown) => unknown;
type UnknownFunc = (...args: unknown[]) => unknown;

type TokenPos = { line: number; col: number; index: number };
type Token = {
  type: "text" | "var" | "tag" | "comment";
  content: string;
  pos: TokenPos;
};

type Node =
  | { type: "text"; text: string }
  | { type: "var"; expr: string; pos?: TokenPos }
  | {
      type: "if";
      branches: Array<{ test: string | null; body: Node[] }>;
      pos?: TokenPos;
    }
  | {
      type: "for";
      varNames: string[];
      iterableExpr: string;
      body: Node[];
      pos?: TokenPos;
    }
  | { type: "include"; path: string; pos?: TokenPos }
  | { type: "block"; name: string; body: Node[]; pos?: TokenPos }
  | { type: "extends"; path: string; pos?: TokenPos };

type IfFrame = {
  type: "if-frame";
  nodes: Node[];
  extra: {
    branches: Array<{ test: string | null; body: Node[] }>;
    current: number;
    tokenPos?: TokenPos;
  };
};

type ForFrame = {
  type: "for";
  nodes: Node[];
  extra: { varNames: string[]; iterableExpr: string; tokenPos?: TokenPos };
};

type BlockFrame = {
  type: "block";
  nodes: Node[];
  extra: { name: string; tokenPos?: TokenPos };
};

type StackFrame = IfFrame | ForFrame | BlockFrame;

function readFile(path: string): string {
  return Deno.readTextFileSync(path);
}

function joinPath(...parts: string[]) {
  return parts.join("/").replace(/\\/g, "/");
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
  return json.replace(/<\/script/gi, "<\\/script");
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

filters["raw_json"] = (v: unknown): SafeString => {
  try {
    return new SafeString(escapeClosingScript(JSON.stringify(v)));
  } catch {
    return new SafeString("null");
  }
};

filters["raw_json_escaped"] = filters["raw_json"];

filters["json_script"] = (v: unknown, arg?: unknown): SafeString => {
  const id =
    typeof arg === "string" ? arg : arg == null ? "__data__" : String(arg);
  try {
    const payload = escapeClosingScript(JSON.stringify(v));
    const html = `<script id="${escapeHtml(
      id
    )}" type="application/json">${payload}</script>`;
    return new SafeString(html);
  } catch {
    return new SafeString(
      `<script id="${escapeHtml(
        String(id)
      )}" type="application/json">null</script>`
    );
  }
};

function countLineCol(s: string, index: number): TokenPos {
  let line = 1;
  let col = 1;
  for (let i = 0; i < index; i++) {
    const ch = s[i];
    if (ch === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col, index };
}

function lex(template: string): Token[] {
  const tokens: Token[] = [];
  const re = /({{\s*([\s\S]*?)\s*}})|({%\s*([\s\S]*?)\s*%})|({#([\s\S]*?)#})/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m.index > lastIndex) {
      const pos = countLineCol(template, lastIndex);
      tokens.push({
        type: "text",
        content: template.slice(lastIndex, m.index),
        pos,
      });
    }
    if (m[1]) {
      const pos = countLineCol(template, m.index);
      tokens.push({ type: "var", content: m[2].trim(), pos });
    } else if (m[3]) {
      const pos = countLineCol(template, m.index);
      tokens.push({ type: "tag", content: m[4].trim(), pos });
    } else if (m[5]) {
      const pos = countLineCol(template, m.index);
      tokens.push({ type: "comment", content: m[6], pos });
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < template.length) {
    const pos = countLineCol(template, lastIndex);
    tokens.push({ type: "text", content: template.slice(lastIndex), pos });
  }
  return tokens;
}

function splitUnquoted(input: string, sep: string) {
  const parts: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      buf += ch;
      escape = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === sep) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((p) => p.trim());
}

type ChainStep =
  | { kind: "name"; name: string }
  | { kind: "prop"; name: string }
  | { kind: "index"; expr: string }
  | { kind: "call" };

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

    if (t.type === "comment") {
      continue;
    }

    if (t.type === "text") {
      pushNode({ type: "text", text: t.content });
      continue;
    }

    if (t.type === "var") {
      pushNode({ type: "var", expr: t.content, pos: t.pos });
      continue;
    }

    if (t.type === "tag") {
      const parts = splitUnquoted(t.content, " ");
      const tag = parts[0];

      if (tag === "if") {
        const test = t.content.slice(2).trim();
        const frame: IfFrame = {
          type: "if-frame",
          nodes: [],
          extra: { branches: [{ test, body: [] }], current: 0 },
        };
        frame.extra.tokenPos = t.pos;
        stack.push(frame);
        continue;
      }

      if (tag === "elif" || tag === "else") {
        const top = stack[stack.length - 1];
        if (!top || top.type !== "if-frame") {
          throw new Error(`Unexpected ${tag} at ${t.pos.line}:${t.pos.col}`);
        }
        const cond = tag === "elif" ? t.content.slice(4).trim() : null;
        top.extra.branches.push({ test: cond, body: [] });
        top.extra.current = top.extra.branches.length - 1;
        continue;
      }

      if (tag === "endif") {
        const frame = stack.pop();
        if (!frame || frame.type !== "if-frame") {
          throw new Error(`Unexpected endif at ${t.pos.line}:${t.pos.col}`);
        }
        const node: Node = {
          type: "if",
          branches: frame.extra.branches,
          pos: frame.extra.tokenPos,
        };
        pushNode(node);
        continue;
      }

      if (tag === "for") {
        const m = t.content.match(/^for\s+(.+?)\s+in\s+([\s\S]+)$/);
        if (!m)
          throw new Error(`Invalid for tag at ${t.pos.line}:${t.pos.col}`);
        const varNames = m[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const iterableExpr = m[2].trim();
        const frame: ForFrame = {
          type: "for",
          nodes: [],
          extra: { varNames, iterableExpr },
        };
        frame.extra.tokenPos = t.pos;
        stack.push(frame);
        continue;
      }

      if (tag === "endfor") {
        const frame = stack.pop();
        if (!frame || frame.type !== "for")
          throw new Error(`Unexpected endfor at ${t.pos.line}:${t.pos.col}`);
        const node: Node = {
          type: "for",
          varNames: frame.extra.varNames,
          iterableExpr: frame.extra.iterableExpr,
          body: frame.nodes,
          pos: frame.extra.tokenPos,
        };
        pushNode(node);
        continue;
      }

      if (tag === "include") {
        const m = t.content.match(/^include\s+["']([\s\S]+?)["']$/);
        if (!m)
          throw new Error(`Invalid include at ${t.pos.line}:${t.pos.col}`);
        pushNode({ type: "include", path: m[1], pos: t.pos });
        continue;
      }

      if (tag === "block") {
        const m = t.content.match(/^block\s+(\w+)$/);
        if (!m) throw new Error(`Invalid block at ${t.pos.line}:${t.pos.col}`);
        const frame: BlockFrame = {
          type: "block",
          nodes: [],
          extra: { name: m[1] },
        };
        frame.extra.tokenPos = t.pos;
        stack.push(frame);
        continue;
      }

      if (tag === "endblock") {
        const frame = stack.pop();
        if (!frame || frame.type !== "block")
          throw new Error(`Unexpected endblock at ${t.pos.line}:${t.pos.col}`);
        const node: Node = {
          type: "block",
          name: frame.extra.name,
          body: frame.nodes,
          pos: frame.extra.tokenPos,
        };
        pushNode(node);
        continue;
      }

      if (tag === "extends") {
        const m = t.content.match(/^extends\s+["']([\s\S]+?)["']$/);
        if (!m)
          throw new Error(`Invalid extends at ${t.pos.line}:${t.pos.col}`);
        pushNode({ type: "extends", path: m[1], pos: t.pos });
        continue;
      }

      pushNode({ type: "text", text: `{% ${t.content} %}` });
    }
  }

  if (stack.length) {
    const top = stack[stack.length - 1];
    const pos = top.extra.tokenPos ?? { line: 0, col: 0, index: 0 };
    throw new Error(`Unclosed tag at ${pos.line}:${pos.col}`);
  }
  return out;
}

function safeCompare(left: unknown, right: unknown, op: string): boolean {
  if (typeof left === "number" && typeof right === "number") {
    switch (op) {
      case ">":
        return left > right;
      case "<":
        return left < right;
      case ">=":
        return left >= right;
      case "<=":
        return left <= right;
      case "==":
        return left == right;
      case "!=":
        return left != right;
    }
  }
  const L = left == null ? "" : String(left);
  const R = right == null ? "" : String(right);
  switch (op) {
    case ">":
      return L > R;
    case "<":
      return L < R;
    case ">=":
      return L >= R;
    case "<=":
      return L <= R;
    case "==":
      return L == R;
    case "!=":
      return L != R;
  }
  return false;
}

function evalTestExpression(expr: string, context: Context): boolean {
  expr = expr.trim();
  if (!expr) return false;
  const cmp = expr.match(/^(.*?)\s*(==|!=|>=|<=|>|<)\s*(.*?)$/);
  if (cmp) {
    const left = getValueFromExpr(cmp[1], context);
    const right = getValueFromExpr(cmp[3], context);
    return safeCompare(left, right, cmp[2]);
  }
  const v = getValueFromExpr(expr, context);
  return !!v;
}

function getValueFromExpr(expr: string, context: Context): unknown {
  expr = expr.trim();
  if (expr === "true") return true;
  if (expr === "false") return false;
  if (expr === "null" || expr === "undefined") return null;
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  const q = expr.match(/^"(.*)"$|^'(.*)'$/s);
  if (q) return q[1] ?? q[2];
  const chain: ChainStep[] = [];
  let i = 0;
  const nameMatch = expr.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
  if (!nameMatch) return undefined;
  const curName = nameMatch[0];
  i = curName.length;
  chain.push({ kind: "name", name: curName });
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ".") {
      i++;
      const m = expr.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
      if (!m) return undefined;
      chain.push({ kind: "prop", name: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === "[") {
      i++;
      let depth = 1;
      let j = i;
      while (j < expr.length && depth > 0) {
        if (expr[j] === "[") depth++;
        if (expr[j] === "]") depth--;
        j++;
      }
      if (depth !== 0) return undefined;
      const inner = expr.slice(i, j - 1).trim();
      chain.push({ kind: "index", expr: inner });
      i = j;
      continue;
    }
    if (expr.slice(i).startsWith("()")) {
      chain.push({ kind: "call" });
      i += 2;
      continue;
    }
    break;
  }
  let cur: unknown = context;
  const first = chain.shift();
  if (!first) return undefined;
  if (first.kind !== "name") return undefined;
  cur = (context as Record<string, unknown>)[first.name];
  for (const step of chain) {
    if (cur == null) return undefined;
    if (step.kind === "prop") {
      if (typeof cur === "object" || typeof cur === "function") {
        cur = (cur as Record<string, unknown>)[step.name];
      } else {
        return undefined;
      }
    } else if (step.kind === "index") {
      const idx = getValueFromExpr(step.expr, context);
      if (typeof idx === "string" || typeof idx === "number") {
        if (typeof cur === "object" || typeof cur === "function") {
          cur = (cur as Record<string, unknown>)[String(idx)];
        } else {
          return undefined;
        }
      } else {
        return undefined;
      }
    } else if (step.kind === "call") {
      if (typeof cur === "function") {
        try {
          cur = (cur as UnknownFunc).call(context);
        } catch {
          cur = undefined;
        }
      } else {
        cur = undefined;
      }
    }
  }
  return cur;
}

function applyFilters(
  value: unknown,
  filterExprs: string[],
  context: Context
): unknown {
  let val: unknown = value;
  for (const f of filterExprs) {
    if (!f) continue;
    const idx = f.indexOf(":");
    let fname = f;
    let farg: unknown = undefined;
    if (idx !== -1) {
      fname = f.slice(0, idx).trim();
      const rawArg = f.slice(idx + 1).trim();
      farg = getValueFromExpr(rawArg, context);
    }
    const fn = filters[fname];
    if (fn) {
      val = fn(val, farg);
    }
  }
  return val;
}

function evalVarExpression(expr: string, context: Context): unknown {
  const parts = splitUnquoted(expr, "|");
  const main = parts[0];
  const filterExprs = parts.slice(1);
  const value = getValueFromExpr(main, context);
  const filtered = applyFilters(value, filterExprs, context);
  return filtered;
}

function renderNodes(
  nodes: Node[],
  context: Context,
  loader: TemplateLoader
): string {
  let out = "";
  const blocks: Record<string, Node[]> = {};
  let hasExtends = false;
  let extendsPath = "";

  for (const n of nodes) {
    if (n.type === "block") blocks[n.name] = n.body;
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
      const val = evalVarExpression(n.expr, context);
      if (val == null) return "";
      if (val instanceof SafeString) return val.toString();
      try {
        return escapeHtml(String(val));
      } catch {
        return "";
      }
    }
    if (n.type === "include") {
      const tpl = loader.load(n.path);
      return renderNodes(tpl.ast, context, loader);
    }
    if (n.type === "block") return renderNodes(n.body, context, loader);
    if (n.type === "if") {
      for (const br of n.branches) {
        const test = br.test;
        if (test == null) return renderNodes(br.body, context, loader);
        if (evalTestExpression(test, context))
          return renderNodes(br.body, context, loader);
      }
      return "";
    }
    if (n.type === "for") {
      const iterable = getValueFromExpr(n.iterableExpr, context) || [];
      let res = "";
      if (Array.isArray(iterable)) {
        for (const it of iterable) {
          const childCtx: Context = { ...context };
          if (n.varNames.length === 1) {
            childCtx[n.varNames[0]] = it;
          } else {
            if (Array.isArray(it)) {
              for (let j = 0; j < n.varNames.length; j++) {
                childCtx[n.varNames[j]] = it[j];
              }
            } else {
              for (let j = 0; j < n.varNames.length; j++) {
                childCtx[n.varNames[j]] = undefined;
              }
            }
          }
          res += renderNodes(n.body, childCtx, loader);
        }
      } else if (iterable && typeof iterable === "object") {
        const entries = Object.entries(iterable as Record<string, unknown>);
        for (const [k, v] of entries) {
          const childCtx: Context = { ...context };
          if (n.varNames.length === 1) {
            childCtx[n.varNames[0]] = v;
          } else if (n.varNames.length >= 2) {
            childCtx[n.varNames[0]] = k;
            childCtx[n.varNames[1]] = v;
          }
          res += renderNodes(n.body, childCtx, loader);
        }
      }
      return res;
    }
    return "";
  }

  for (const n of nodes) out += renderNode(n);
  return out;
}

function renderParentWithChild(
  parentNodes: Node[],
  context: Context,
  loader: TemplateLoader,
  childBlocks: Record<string, Node[]>
): string {
  let out = "";
  for (const n of parentNodes) {
    if (n.type === "block") {
      if (childBlocks[n.name])
        out += renderNodes(childBlocks[n.name], context, loader);
      else out += renderNodes(n.body, context, loader);
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

function renderTemplate(path: string, context: Context = {}): string {
  const tpl = loader.load(path);
  const html = renderNodes(tpl.ast, context, loader);
  return html;
}

export { renderTemplate, TemplateLoader, SafeString };
