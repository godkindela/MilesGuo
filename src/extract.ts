const ARTICLE_PATH_RE = /\/cn\/milesguo\/\d+\.html/gi;
const PAGINATION_PATH_RE = /(?:href|value)=["'](list_\d+_\d+\.html)["']/gi;
const SITEMAP_LOC_RE = /<loc>([^<]+)<\/loc>/gi;

export function extractArticleLinks(html: string, seed: string, limit = 50): string[] {
  const found = new Set<string>();
  const base = new URL(seed);

  for (const m of html.matchAll(ARTICLE_PATH_RE)) {
    if (!m[0]) continue;
    const absolute = new URL(m[0], base.origin).toString();
    const u = new URL(absolute);
    if (u.hostname !== base.hostname) continue;
    found.add(u.toString());
    if (found.size >= limit) break;
  }

  return [...found];
}

export function extractPaginationLinks(html: string, seed: string): string[] {
  const found = new Set<string>();
  const base = new URL(seed);

  for (const m of html.matchAll(PAGINATION_PATH_RE)) {
    const rel = m[1];
    if (!rel) continue;
    const absolute = new URL(rel, seed).toString();
    const u = new URL(absolute);
    if (u.hostname !== base.hostname) continue;
    found.add(u.toString());
  }

  return [...found];
}

export function extractSitemapArticleLinks(xml: string, seed: string, limit = 50): string[] {
  const base = new URL(seed);
  const found = new Set<string>();

  for (const m of xml.matchAll(SITEMAP_LOC_RE)) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    const absolute = new URL(raw, base.origin).toString();
    const u = new URL(absolute);
    if (u.hostname !== base.hostname) continue;
    if (!/\/cn\/milesguo\/\d+\.html$/i.test(u.pathname)) continue;
    found.add(u.toString());
    if (found.size >= limit) break;
  }

  return [...found];
}

export function buildR2Key(pageUrl: string): string {
  const u = new URL(pageUrl);
  let path = u.pathname;

  if (!path || path === "/") {
    path = "/index.md";
  } else if (/\.html?$/i.test(path)) {
    path = path.replace(/\.html?$/i, ".md");
  } else if (!path.endsWith("/")) {
    path = `${path}/index.md`;
  } else {
    path = `${path}index.md`;
  }

  return `gwins${path}`.replace(/\/+/g, "/");
}

export function extractTitleFromHtml(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return null;
  return decodeHtml(m[1]).trim() || null;
}

export function extractMainArticleHtml(html: string): string {
  const marker = "<!--1-->";
  const first = html.indexOf(marker);
  const second = first >= 0 ? html.indexOf(marker, first + marker.length) : -1;

  let segment = html;
  if (first >= 0 && second > first) {
    segment = html.slice(first + marker.length, second);
  }

  segment = segment
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<ins[\s\S]*?<\/ins>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<a[^>]*>\s*<\/a>/gi, "")
    .replace(/&nbsp;/gi, " ");

  return `<html><body>${segment}</body></html>`;
}

export function cleanMarkdown(input: string): string {
  const lines = input.split("\n");
  const cleaned = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;

    if (/^\|?\s*!\[\]\(\/images\//i.test(trimmed)) return false;
    if (/\[(首页|郭文贵视频|名词解释|人物|公司|国家地区|图书|音乐)\]\(\/.*\)/.test(trimmed)) return false;
    if (/^友情链接[:：]/.test(trimmed)) return false;
    if (/^[-| ]+$/.test(trimmed) && trimmed.includes("|")) return false;
    if (/^\|?\s*\[\]\(\/\)\s*\|?$/.test(trimmed)) return false;

    return true;
  });

  return cleaned
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
}
