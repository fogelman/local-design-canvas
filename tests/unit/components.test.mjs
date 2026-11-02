import { test } from "node:test";
import assert from "node:assert/strict";
import { fillTemplate, parseAttrs, splitSlots, expandComponents, listComponents } from "../../src/components.mjs";
import { makeCanvas, cleanup } from "../helpers.mjs";

test("parseAttrs reads quoted, unquoted and bare attributes", () => {
  assert.deepEqual(parseAttrs(` label="Hi there" size=sm checked data-x='1'`), { label: "Hi there", size: "sm", checked: "true", "data-x": "1" });
});

test("fillTemplate: values, defaults and escaping", () => {
  assert.equal(fillTemplate("<b>{{name}}</b>", { name: "<Ana>" }, {}), "<b>&lt;Ana&gt;</b>");
  assert.equal(fillTemplate("{{size|md}}", {}, {}), "md");
  assert.equal(fillTemplate("{{size|md}}", { size: "" }, {}), "md", "an empty value falls back to the default");
});

test("fillTemplate: conditional sections", () => {
  const tpl = "{{?href}}link{{/href}}{{!href}}button{{/href}}";
  assert.equal(fillTemplate(tpl, { href: "a.html" }, {}), "link");
  assert.equal(fillTemplate(tpl, {}, {}), "button");
  assert.equal(fillTemplate(tpl, { href: "false" }, {}), "button");
});

test("fillTemplate: lists with parts, active marker and defaults", () => {
  const tpl = `{{@items|Home:home,Orders:orders::<a class="$=active" data-i="$2">$</a>}}`;
  assert.equal(fillTemplate(tpl, { active: "Orders" }, {}), `<a class="" data-i="home">Home</a><a class="on" data-i="orders">Orders</a>`);
  assert.equal(fillTemplate("{{@cols:<th>$</th>}}", { cols: "A, B" }, {}), "<th>A</th><th>B</th>");
});

test("fillTemplate: default and named slots with fallbacks", () => {
  const tpl = `<div><slot>empty</slot><slot name="actions">none</slot></div>`;
  assert.equal(fillTemplate(tpl, {}, { "": "body", actions: "<button>x</button>" }), "<div>body<button>x</button></div>");
  assert.equal(fillTemplate(tpl, {}, {}), "<div>emptynone</div>");
});

test("splitSlots only takes templates that are direct children, not ones inside nested components", () => {
  const slots = splitSlots(`<template slot="nav">N</template>body<ds-header><template slot="actions">A</template></ds-header>`);
  assert.equal(slots.nav, "N");
  assert.equal(slots.actions, undefined);
  assert.match(slots[""], /^body<ds-header><template slot="actions">A<\/template><\/ds-header>$/);
});

test("expandComponents: nesting, slots, data-ds markers, class merge and missing components", () => {
  const dir = makeCanvas({
    "_ds/components/atoms/button.html": `<!-- <ds-button>Label</ds-button> -->\n<button class="btn {{variant}}"><slot>Button</slot></button>`,
    "_ds/components/organisms/bar.html": `<header class="bar"><slot name="actions"></slot><slot></slot></header>`,
  });
  try {
    const ctx = { roots: [`${dir}/_ds/components`] };
    const html = expandComponents(`<ds-bar class="top"><template slot="actions"><ds-button variant="ghost">Go</ds-button></template>Title</ds-bar><ds-nope></ds-nope>`, ctx);
    assert.match(html, /^<header data-ds="organisms\/bar" class="top bar">/);
    assert.match(html, /<button data-ds="atoms\/button" class="btn ghost">Go<\/button>Title<\/header>/);
    assert.match(html, /data-ds-missing="nope"/);
    assert.ok(!html.includes("<ds-"), "every component tag is expanded");
    assert.deepEqual(listComponents(dir), [["atoms/button", "<ds-button>Label</ds-button>"], ["organisms/bar", ""]]);
  } finally { cleanup(dir); }
});

test("expandComponents stops runaway recursion", () => {
  const dir = makeCanvas({ "_ds/components/atoms/loop.html": `<i><ds-loop></ds-loop></i>` });
  try {
    const html = expandComponents(`<ds-loop></ds-loop>`, { roots: [`${dir}/_ds/components`] });
    assert.ok(html.length < 5000);
  } finally { cleanup(dir); }
});
