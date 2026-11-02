// Atomic-design components: <ds-name> tags expanded from <canvas>/_ds/components when a frame is served or shot.
import fs from "node:fs";
import path from "node:path";
import { shot } from "./shot.mjs";
// ---------- components (atomic design) ----------
// A frame can write <ds-field label="E-mail"></ds-field>; when the frame is served (or shot), the tag expands from
// the project's _ds/components/{atoms,molecules,organisms,templates}/field.html (the page's _ds first, then the
// canvas root's). The browser only ever sees static html, so comments, snapshots and shots work as usual.
// Component files: an optional first-line comment documents usage (`canvas ds` lists it), then html with
//   {{prop}} {{prop|default}}      value of an attribute (html-escaped); the default also covers an empty value
//   {{?prop}}…{{/prop}}            only when the attribute is set (and not "false"); {{!prop}}…{{/prop}} only when not
//   {{@prop:<th>$</th>}}           repeat for each comma-separated item of the attribute, $ = the item;
//   {{@prop|A,B::…}}               with a default list (note the ::); items may have parts ("Label:icon": $ = Label, $2 = icon);
//                                  $=other → "on" when the item's first part equals attribute `other`
//   <slot></slot>                  the tag's children; <slot name="actions">fallback</slot> for <template slot="actions">
// The root element gets data-ds="<level>/<name>" (and the tag's class), so comments know which component they hit.
export const DS_LEVELS = ["atoms", "molecules", "organisms", "templates", ""];
export const dsRoots = (fileDir, root) => [...new Set([path.join(fileDir, "_ds", "components"), path.join(root, "_ds", "components")])].filter((d) => fs.existsSync(d));
export function findComponent(roots, name) {
  for (const r of roots) for (const lvl of DS_LEVELS) {
    const file = path.join(r, lvl, `${name}.html`);
    if (fs.existsSync(file)) return { file, id: lvl ? `${lvl}/${name}` : name };
  }
  return null;
}
export const escHtml = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function parseAttrs(str) {
  const out = {};
  for (const m of str.matchAll(/([^\s="'/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "true";
  return out;
}
export const isSet = (v) => v !== undefined && v !== "" && v !== "false";
export function fillTemplate(tpl, props, slots) {
  tpl = tpl.replace(/\{\{([?!])([\w-]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, op, k, inner) => (isSet(props[k]) === (op === "?") ? inner : ""));
  tpl = tpl.replace(/\{\{@([\w-]+)(?:\|([\s\S]*?)::|:)([\s\S]*?)\}\}/g, (_, k, d, pattern) =>
    String(isSet(props[k]) ? props[k] : d ?? "").split(",").map((x) => x.trim()).filter(Boolean)
      .map((x) => { const part = x.split(":").map((y) => escHtml(y.trim()));
        return pattern.replace(/\$=([\w-]+)/g, (_, key) => (x.split(":")[0].trim() === props[key] ? "on" : "")).replace(/\$([2-9])/g, (_, n) => part[n - 1] ?? "").replaceAll("$", part[0]); }).join(""));
  tpl = tpl.replace(/\{\{([\w-]+)(?:\|([^}]*))?\}\}/g, (_, k, d) => escHtml(isSet(props[k]) ? props[k] : d ?? ""));
  return tpl.replace(/<slot(?:\s+name="([^"]+)")?\s*(?:\/>|>([\s\S]*?)<\/slot>)/g, (_, n, fallback) => slots[n || ""] ?? fallback ?? "");
}
// <template slot="x"> children of THIS tag become named slots; the rest is the default slot. Templates nested inside
// another <ds-…> belong to that component, so ds depth is tracked while scanning.
export function splitSlots(inner) {
  const slots = {}, tokens = /<ds-[a-z0-9-]+(?:\s[^>]*?)?(\/?)>|<\/ds-[a-z0-9-]+\s*>|<template\s+slot="([^"]+)"\s*>|<template(?:\s[^>]*)?>|<\/template\s*>/gi;
  let ds = 0, open = null, nested = 0, rest = "", last = 0, t;
  while ((t = tokens.exec(inner))) {
    const tag = t[0];
    if (/^<ds-/i.test(tag)) { if (!t[1]) ds++; continue; }
    if (/^<\/ds-/i.test(tag)) { ds--; continue; }
    if (ds) continue;
    if (/^<template/i.test(tag)) {
      if (open) nested++;
      else if (t[2]) { rest += inner.slice(last, t.index); open = { name: t[2], start: t.index + tag.length }; }
      continue;
    }
    if (open && nested) { nested--; continue; }
    if (open) { slots[open.name] = inner.slice(open.start, t.index); last = t.index + tag.length; open = null; }
  }
  rest += inner.slice(last);
  if (rest.trim()) slots[""] = rest;
  return slots;
}

export function renderComponent(name, props, inner, ctx, depth) {
  const c = findComponent(ctx.roots, name);
  if (!c) return `<div data-ds-missing="${escHtml(name)}" style="outline:2px dashed #e5484d;padding:4px 6px;color:#e5484d;font:12px monospace">missing component &lt;ds-${escHtml(name)}&gt;</div>`;
  const slots = splitSlots(inner);
  let html = fillTemplate(fs.readFileSync(c.file, "utf8").replace(/^\s*<!--[\s\S]*?-->\s*/, ""), props, slots).trim();
  html = html.replace(/^<([a-z][\w-]*)/i, `<$1 data-ds="${c.id}"`);
  if (props.class) html = /^<[^>]*\sclass="/i.test(html) ? html.replace(/^(<[^>]*?\sclass=")/i, `$1${escHtml(props.class)} `) : html.replace(/^(<[a-z][\w-]*)/i, `$1 class="${escHtml(props.class)}"`);
  return expandComponents(html, ctx, depth + 1);
}
export function expandComponents(html, ctx, depth = 0) {
  if (depth > 16 || !html.includes("<ds-")) return html;
  const open = /<ds-([a-z0-9-]+)((?:\s[^>]*?)?)(\/?)>/gi;
  let out = "", i = 0, m;
  while ((m = open.exec(html))) {
    const [whole, name, attrs, selfClosing] = m;
    let end = m.index + whole.length, inner = "";
    if (!selfClosing) {
      const tags = new RegExp(`<ds-${name}(?=[\\s/>])[^>]*?(/?)>|</ds-${name}\\s*>`, "gi");
      tags.lastIndex = end;
      let depthTag = 1, t;
      while ((t = tags.exec(html))) {
        if (t[0][1] === "/") { if (--depthTag === 0) { inner = html.slice(end, t.index); end = t.index + t[0].length; break; } }
        else if (!t[1]) depthTag++;
      }
      if (depthTag) { inner = html.slice(end); end = html.length; }
    }
    out += html.slice(i, m.index) + renderComponent(name, parseAttrs(attrs), inner, ctx, depth);
    i = end;
    open.lastIndex = end;
  }
  return out + html.slice(i);
}
export const expandFile = (file, root) => expandComponents(fs.readFileSync(file, "utf8"), { roots: dsRoots(path.dirname(file), root) });
export function listComponents(dir) {
  const rows = [];
  for (const r of dsRoots(dir, dir)) for (const lvl of DS_LEVELS.filter(Boolean)) {
    const d = path.join(r, lvl);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".html")).sort()) {
      const head = fs.readFileSync(path.join(d, f), "utf8").match(/^\s*<!--\s*([\s\S]*?)\s*-->/);
      rows.push([`${lvl}/${f.replace(/\.html$/, "")}`, head ? head[1].replace(/\s+/g, " ") : ""]);
    }
  }
  return rows;
}
