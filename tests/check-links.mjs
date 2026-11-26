// Static internal link + basic SEO check over every HTML file in the repo.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const root = new URL("..", import.meta.url).pathname;
const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    if (["node_modules", ".git", "tests"].includes(f)) continue;
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".html")) files.push(p);
  }
})(root);
const redirects = new Set(vercel.redirects.map((r) => r.source));
function resolves(path) {
  path = decodeURIComponent(path.split("#")[0].split("?")[0]);
  if (path === "" || path === "/") return true;
  if (path.startsWith("/api/")) return existsSync(join(root, path + ".js"));
  if (redirects.has(path)) return true;
  if (existsSync(join(root, path)) && statSync(join(root, path)).isFile()) return true;
  if (existsSync(join(root, path + ".html"))) return true;
  return false;
}
let broken = 0, checked = 0, seo = 0;
for (const f of files) {
  const html = readFileSync(f, "utf8");
  const rel = f.slice(root.length);
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const u = m[1];
    if (!u.startsWith("/") || u.startsWith("//")) continue;
    checked++;
    if (!resolves(u)) { broken++; console.log(`BROKEN ${rel} -> ${u}`); }
  }
  const indexable = !/name="robots" content="noindex/.test(html) && !/^google/.test(rel);
  if (indexable) {
    if (!/<title>[^<]{5,}<\/title>/.test(html)) { seo++; console.log(`SEO ${rel}: missing title`); }
    if (!/name="description" content="[^"]{20,}"/.test(html)) { seo++; console.log(`SEO ${rel}: missing meta description`); }
    if (!/rel="canonical"/.test(html)) { seo++; console.log(`SEO ${rel}: missing canonical`); }
  }
}
console.log(`files=${files.length} internal_links=${checked} broken=${broken} seo_issues=${seo}`);
process.exit(broken || seo ? 1 : 0);
