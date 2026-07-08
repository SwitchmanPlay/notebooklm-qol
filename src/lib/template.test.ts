import { test } from "node:test"
import assert from "node:assert/strict"
import {
  applyTemplate,
  cleanName,
  uniqueName,
  toFilename,
  templatePreview,
  DEFAULT_TEMPLATE,
  MAX_NAME_LEN,
} from "./template.ts"

const d = new Date(2026, 6, 5) // 2026-07-05

test("substitutes all variables", () => {
  const out = applyTemplate("{source} \u2014 {type} \u2014 {date} #{n}", {
    source: "My Paper",
    type: "Audio Overview",
    date: d,
    n: 3,
  })
  assert.equal(out, "My Paper \u2014 Audio Overview \u2014 2026-07-05 #3")
})

test("default template", () => {
  const out = applyTemplate(DEFAULT_TEMPLATE, { source: "Ch 1", type: "Video Overview", date: d })
  assert.equal(out, "Ch 1 \u2014 Video Overview")
})

test("truncates long source titles with ellipsis", () => {
  const long = "word ".repeat(40).trim() // 199 chars
  const out = applyTemplate("{source}", { source: long, date: d })
  assert.ok(out.length <= 61 + 1)
  assert.ok(out.endsWith("\u2026"))
})

test("caps total name length", () => {
  const out = applyTemplate("{source} {source} {source}", { source: "x".repeat(60), date: d })
  assert.ok(out.length <= MAX_NAME_LEN + 1)
})

test("cleanName strips control chars and collapses whitespace", () => {
  assert.equal(cleanName("a\u0000b\n  c\t d "), "a b c d")
})

test("missing vars become empty, result still clean", () => {
  const out = applyTemplate("{source} \u2014 {type}", { date: d })
  assert.equal(out, "\u2014")
})

test("uniqueName appends (2), (3) case-insensitively", () => {
  assert.equal(uniqueName("Report", []), "Report")
  assert.equal(uniqueName("Report", ["report"]), "Report (2)")
  assert.equal(uniqueName("Report", ["report", "Report (2)"]), "Report (3)")
})

test("toFilename strips illegal filesystem chars", () => {
  assert.equal(toFilename('a/b\\c:d*e?f"g<h>i|j', "mp3"), "a_b_c_d_e_f_g_h_i_j.mp3")
  assert.equal(toFilename("   ", "mp3"), "untitled.mp3")
  assert.equal(toFilename("name...", "zip"), "name.zip")
})

test("templatePreview renders without errors", () => {
  assert.ok(templatePreview(DEFAULT_TEMPLATE).includes("Audio Overview"))
})
