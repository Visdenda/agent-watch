/**
 * HTML → Markdown 轻量转换器（Markdown for Agents 内容协商用；自 apps/web/worker 泛化）。
 *
 * 只转自家营销页的可预测 JSX 输出，不追求通用 HTML 覆盖：
 * 支持 h1-6 / p / div / section / ul-ol-li（嵌套）/ table（GFM）/
 * blockquote / pre-code / 行内 strong-em-code-a-img。
 * 零依赖、纯字符串处理，workerd 内可跑（不碰 DOM）。
 * 作用域假设（与 Next SSR 转义行为一致）：脚本/属性值内不出现字面 `</script>` 与裸 `>`，
 * 否则按未知标签透明处理、最坏多一段文本噪音，不会破环。
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#([0-9]+);/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, name: string) => NAMED_ENTITIES[name] ?? "");
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    const raw = m[2];
    const value = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
    attrs[m[1].toLowerCase()] ??= value;
  }
  return attrs;
}

function resolveUrl(href: string, pageUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || /^(javascript|data|vbscript):/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, pageUrl).href;
  } catch {
    return trimmed;
  }
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function yamlValue(value: string): string {
  // 纯量含 ": "（冒号+空白）/ 行内注释 / 首字符特殊时才加引号；
  // URL 里的裸冒号（如 https://）保持不引，对齐 CF 示例输出。
  const needsQuotes =
    value !== value.trim() ||
    /[\n"']/.test(value) ||
    /:\s/.test(value) ||
    /\s#/.test(value) ||
    /^[-?:,[\]{}&*!|>%@`#]/.test(value);
  return needsQuotes ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

export interface MarkdownDocument {
  title?: string;
  description?: string;
  image?: string;
  jsonLd: string[];
  markdown: string;
  tokens: number;
}

/** head 区元信息 + JSON-LD 提取（转换前对全文跑一次）。 */
export function extractHead(
  html: string,
): Pick<MarkdownDocument, "title" | "description" | "image" | "jsonLd"> {
  const metas: Record<string, string> = {};
  // 属性值可能含转义后的 >（如 &gt;），用引号感知匹配防提前截断。
  const metaRe = /<meta\s(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = metaRe.exec(html)) !== null) {
    const attrs = parseAttrs(mm[0]);
    const key = (attrs.name ?? attrs.property ?? "").toLowerCase();
    if (!attrs.content) continue;
    if (key === "title" || key === "description" || key.startsWith("og:")) {
      metas[key] ??= decodeEntities(attrs.content);
    }
  }
  const titleTag = /<title[^>]*>([^<]*)<\/title\s*>/i.exec(html)?.[1];
  const jsonLd: string[] = [];
  const ldRe =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = ldRe.exec(html)) !== null) {
    const raw = lm[1].trim();
    if (!raw) continue;
    try {
      JSON.parse(raw);
      jsonLd.push(raw);
    } catch {
      // 非法 JSON-LD 直接丢弃，不污染尾块。
    }
  }
  return {
    title:
      metas.title ?? metas["og:title"] ?? (titleTag ? decodeEntities(titleTag.trim()) : undefined),
    description: metas.description ?? metas["og:description"],
    image: metas["og:image"],
    jsonLd,
  };
}

/** 去 chrome：注释 / 脚本样式 / 导航页眉页脚 / 表单控件 / 图标 svg / 嵌入帧。 */
export function stripChrome(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  s = s.replace(
    /<(style|noscript|template|svg|canvas|video|audio|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  s = s.replace(/<(header|footer|nav)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<(select|textarea|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<input\b[^>]*>/gi, "");
  s = s.replace(/<label\b[^>]*>([\s\S]*?)<\/label\s*>/gi, "$1");
  s = s.replace(/<picture\b[^>]*>([\s\S]*?)<\/picture\s*>/gi, "$1");
  return s;
}

/** 内容根：页面级 <main> 优先（首页有），否则 body，否则全文。 */
export function contentRoot(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html);
  if (main) return main[1];
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
  return body ? body[1] : html;
}

const BLOCK_OPEN = new Set([
  "p",
  "div",
  "section",
  "article",
  "aside",
  "figure",
  "figcaption",
  "main",
  "details",
  "summary",
  "dl",
  "dt",
  "dd",
]);

/** 单遍 tokenizer：块级换行 + 行内标记，保持 ul/ol/table/a 嵌套正确。 */
export function fragmentToMarkdown(fragment: string, pageUrl: string): string {
  const out: string[] = [];
  const fenced: string[] = [];
  const listStack: Array<{ ordered: boolean; count: number }> = [];
  const linkBufs: string[][] = [];
  const linkHrefs: Array<string | null> = [];
  let table: { rows: string[][]; row: string[] | null; cell: string[] | null } | null = null;
  let inPre = false;
  let preLang = "";
  const preBuf: string[] = [];
  let bq = 0;
  let lineStart = true;

  const sink = (): string[] => {
    if (inPre) return preBuf;
    if (table?.cell) return table.cell;
    const linkBuf = linkBufs[linkBufs.length - 1];
    if (linkBuf) return linkBuf;
    return out;
  };

  const emit = (text: string): void => {
    const target = sink();
    if (target !== out || bq === 0) {
      if (text) target.push(text);
      return;
    }
    // blockquote 行首补 "> "（纯换行块不补，避免悬空 "> " 与下块重复）。
    if (text.trim() !== "") {
      const prefixed = lineStart && !text.startsWith("\n") ? `> ${text}` : text;
      target.push(prefixed.replace(/\n(?=[^\n])/g, "\n> "));
    } else if (text) {
      target.push(text);
    }
    lineStart = text === "" ? lineStart : text.endsWith("\n");
  };

  const flushPre = (): void => {
    const code = preBuf.join("").replace(/^\n+|\s+$/g, "");
    if (code) {
      fenced.push(`\`\`\`${preLang}\n${code}\n\`\`\``);
      out.push(`\n\n\u0000FENCED${fenced.length - 1}\u0000\n\n`);
    }
    preBuf.length = 0;
  };

  const flushTable = (): void => {
    if (table && table.rows.length > 0) {
      const rows = table.rows.map((r) => r.map(escapeCell));
      const width = Math.max(...rows.map((r) => r.length));
      const norm = rows.map((r) => {
        const copy = r.slice();
        while (copy.length < width) copy.push("");
        return copy;
      });
      const [head, ...body] = norm;
      // GFM 必须有表头行：无 thead 时首行顶上，与 CF 转换行为一致可预期。
      const lines = [
        `| ${head.join(" | ")} |`,
        `| ${head.map(() => "---").join(" | ")} |`,
        ...body.map((r) => `| ${r.join(" | ")} |`),
      ];
      out.push(`\n\n${lines.join("\n")}\n\n`);
    }
    table = null;
  };

  const tokenRe = /(<[^>]*>|[^<]+)/g;
  let tok: RegExpExecArray | null;
  while ((tok = tokenRe.exec(fragment)) !== null) {
    const chunk = tok[0];
    if (!chunk.startsWith("<")) {
      emit(decodeEntities(chunk));
      continue;
    }
    const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(chunk);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const isClose = chunk[1] === "/";
    const attrs = name === "a" || name === "img" || name === "pre" ? parseAttrs(chunk) : {};

    if (inPre && name !== "pre") {
      // pre 内只认纯文本，标签原样丢弃（code 标签透明，顺手取语言）。
      if (name === "code" && !isClose && !preLang) {
        const langMatch = /language-([\w+-]+)/.exec(parseAttrs(chunk).class ?? "");
        if (langMatch) preLang = langMatch[1];
      }
      continue;
    }

    const heading = /^h([1-6])$/.exec(name);
    if (heading) {
      emit(isClose ? "\n\n" : `\n\n${"#".repeat(Number(heading[1]))} `);
      continue;
    }
    if (name === "br") {
      emit("\n");
      continue;
    }
    if (name === "hr") {
      emit("\n\n---\n\n");
      continue;
    }
    if (name === "ul" || name === "ol") {
      if (!isClose) {
        listStack.push({ ordered: name === "ol", count: 0 });
        emit("\n");
      } else {
        listStack.pop();
        emit("\n");
      }
      continue;
    }
    if (name === "li") {
      if (!isClose) {
        const top = listStack[listStack.length - 1];
        let bullet = "- ";
        if (top?.ordered) {
          top.count += 1;
          bullet = `${top.count}. `;
        }
        emit(`\n${"  ".repeat(Math.max(listStack.length - 1, 0))}${bullet}`);
      }
      continue;
    }
    if (name === "a") {
      if (!isClose) {
        // React 属性转义（&amp; 等）先解码，否则含查询串的链接会坏。
        const rawHref = attrs.href ? decodeEntities(attrs.href) : "";
        linkBufs.push([]);
        linkHrefs.push(rawHref ? resolveUrl(rawHref, pageUrl) : null);
      } else {
        const buf = linkBufs.pop();
        const href = linkHrefs.pop();
        if (buf) {
          const text = buf.join("").replace(/\s+/g, " ").trim();
          if (text) emit(href ? `[${text}](${href})` : text);
        }
      }
      continue;
    }
    if (name === "img") {
      if (!isClose) {
        const alt = (attrs.alt ?? "").replace(/[\[\]]/g, "").trim();
        const rawSrc = attrs.src ? decodeEntities(attrs.src) : "";
        const src = rawSrc ? resolveUrl(rawSrc, pageUrl) : null;
        if (alt && src) emit(`![${alt}](${src})`);
      }
      continue;
    }
    if (name === "pre") {
      if (!isClose) {
        const langMatch = /language-([\w+-]+)/.exec(attrs.class ?? "");
        preLang = langMatch ? langMatch[1] : "";
        inPre = true;
      } else {
        inPre = false;
        flushPre();
      }
      continue;
    }
    if (name === "strong" || name === "b") {
      emit("**");
      continue;
    }
    if (name === "em" || name === "i") {
      emit("*");
      continue;
    }
    if (name === "code") {
      emit("`");
      continue;
    }
    if (name === "s" || name === "strike" || name === "del") {
      emit("~~");
      continue;
    }
    if (name === "blockquote") {
      if (!isClose) {
        bq += 1;
        emit("\n\n");
      } else {
        bq = Math.max(bq - 1, 0);
        emit("\n\n");
      }
      continue;
    }
    if (name === "table") {
      if (!isClose) table = { rows: [], row: null, cell: null };
      else flushTable();
      continue;
    }
    if (name === "tr") {
      if (table && !isClose) table.row = [];
      else if (table?.row && isClose) {
        table.rows.push(table.row);
        table.row = null;
      }
      continue;
    }
    if (name === "th" || name === "td") {
      if (!table) continue;
      if (!isClose) {
        table.cell = [];
      } else if (table.cell && table.row) {
        table.row.push(table.cell.join(""));
        table.cell = null;
      }
      continue;
    }
    if (BLOCK_OPEN.has(name)) {
      emit("\n\n");
      continue;
    }
    // 其余行内/未知标签透明：只保留子文本。
  }
  if (inPre) {
    inPre = false;
    flushPre();
  }
  if (table) flushTable();

  let md = out.join("");
  md = md
    .split("\n")
    .map((line) => {
      const indent = /^ */.exec(line)?.[0] ?? "";
      return (
        indent +
        line
          .slice(indent.length)
          .replace(/[ \t]{2,}/g, " ")
          .trimEnd()
      );
    })
    .join("\n");
  md = md.replace(/\n{3,}/g, "\n\n").trim();
  fenced.forEach((block, i) => {
    md = md.split(`\u0000FENCED${i}\u0000`).join(block);
  });
  return md;
}

export function buildMarkdownDocument(html: string, pageUrl: string): MarkdownDocument | null {
  const head = extractHead(html);
  const image = head.image ? (resolveUrl(head.image, pageUrl) ?? head.image) : undefined;
  const body = fragmentToMarkdown(contentRoot(stripChrome(html)), pageUrl);
  const sections: string[] = [];
  const frontmatterLines: string[] = [];
  if (head.title) frontmatterLines.push(`title: ${yamlValue(head.title)}`);
  if (head.description) frontmatterLines.push(`description: ${yamlValue(head.description)}`);
  if (image) frontmatterLines.push(`image: ${yamlValue(image)}`);
  if (frontmatterLines.length > 0) sections.push(`---\n${frontmatterLines.join("\n")}\n---`);
  if (body) sections.push(body);
  if (head.jsonLd.length > 0) sections.push(`\`\`\`json\n${head.jsonLd.join("\n")}\n\`\`\``);
  if (sections.length === 0) return null;
  const markdown = `${sections.join("\n\n").trim()}\n`;
  return {
    ...head,
    image,
    markdown,
    tokens: Math.max(1, Math.ceil(markdown.length / 4)),
  };
}
