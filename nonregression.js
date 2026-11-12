"use strict";
// Non-régression statique : prouve que les fichiers modifiés n'ont reçu que des AJOUTS (hors lignes explicitement listées).
// Usage : node tests/nonregression.js <dossier-des-fichiers-originaux> <dossier-des-fichiers-modifiés>
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs"), path = require("path");
const [orig, next] = process.argv.slice(2);
if (!orig || !next) { console.error("Usage: node tests/nonregression.js <originaux> <modifiés>"); process.exit(2); }
let fail = 0; const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };
const removed = (f) => { const r = spawnSync("diff", [path.join(orig, f), path.join(next, f)], { encoding: "utf8", maxBuffer: 1 << 28 }); return r.stdout.split("\n").filter((l) => l.startsWith("< ")).map((l) => l.slice(2)); };
for (const f of ["index.js", "sw.js"]) { const r = spawnSync(process.execPath, ["--check", path.join(next, f)], { encoding: "utf8" }); ok(r.status === 0, `${f} : syntaxe valide`); }
ok(spawnSync(process.execPath, ["--check", path.join(next, "programmer.js")]).status === 0, "programmer.js : syntaxe valide");
const html = fs.readFileSync(path.join(next, "Luba.html"), "utf8");
let scriptsOk = true; for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) { try { new Function(m[1]); } catch { scriptsOk = false; } }
ok(scriptsOk, "Luba.html : tous les blocs <script> inline sont syntaxiquement valides");
const rIdx = removed("index.js"); ok(rIdx.length === 2 && rIdx.some((l) => /async exec\(args, ctx\) \{ const t = await repo\.createTask/.test(l)) && rIdx.some((l) => /allowedHeaders/.test(l)), `index.js : 2 lignes remplacées seulement (outil create_task → pont Push ; CORS + en-tête X-Timezone) — retirées : ${rIdx.length}`);
const rSw = removed("sw.js"); ok(rSw.length <= 4, `sw.js : ${rSw.length} ligne(s) modifiée(s) (en-tête, transmission de reminderId, tag/data du push)`);
const rHtml = removed("Luba.html"); ok(rHtml.length === 0, `Luba.html : 0 ligne retirée (ajouts uniquement) — retirées : ${rHtml.length}`);
const idx0 = fs.readFileSync(path.join(orig, "index.js"), "utf8"), idx1 = fs.readFileSync(path.join(next, "index.js"), "utf8");
const routeRe = /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g; const rs0 = new Set([...idx0.matchAll(routeRe)].map((m) => m[1] + " " + m[2])), rs1 = new Set([...idx1.matchAll(routeRe)].map((m) => m[1] + " " + m[2]));
ok([...rs0].every((r) => rs1.has(r)), `index.js : les ${rs0.size} routes existantes sont toujours déclarées`);
const nav0 = ["chat", "lubacode", "websearch", "settings"].every((p) => html.includes(`data-page="${p}"`)); ok(nav0, "Luba.html : navigation existante (Chat, Luba Code, Recherches Web, Paramètres) intacte");
const order = html.indexOf('data-page="websearch"') < html.indexOf('data-page="programmer"') && html.indexOf('data-page="programmer"') < html.indexOf('class="sidebar-section">Récents'); ok(order, "Luba.html : « Luba Programmer » est placé juste sous « Recherches Web & Images »");
const apis = [...idx0.matchAll(/(?:^|\n)\s*(?:function|async function)\s+(\w+)/g)].map((m) => m[1]); ok(apis.every((n) => new RegExp("(?:function)\\s+" + n + "\\b").test(idx1)), `index.js : les ${apis.length} fonctions de premier niveau d'origine existent toujours`);
console.log(fail ? `\n${fail} échec(s)` : "\nNon-régression statique : OK"); process.exit(fail ? 1 : 0);
