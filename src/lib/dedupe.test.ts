import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeUrl, normalizeTitle, findDuplicateGroups, deletableIds } from "./dedupe.ts"

test("normalizeUrl strips www, hash, trailing slash, tracking params", () => {
  assert.equal(
    normalizeUrl("https://www.Example.com/path/?utm_source=x&fbclid=abc#sec"),
    "example.com/path",
  )
})

test("normalizeUrl treats http/https as equal and sorts params", () => {
  assert.equal(normalizeUrl("http://a.com/p?b=2&a=1"), normalizeUrl("https://a.com/p/?a=1&b=2"))
})

test("normalizeUrl keeps meaningful params", () => {
  assert.equal(normalizeUrl("https://a.com/p?id=7"), "a.com/p?id=7")
})

test("youtube urls normalize to video id", () => {
  const a = normalizeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=xyz")
  const b = normalizeUrl("https://youtu.be/dQw4w9WgXcQ?si=abc")
  assert.equal(a, "youtube:dQw4w9WgXcQ")
  assert.equal(a, b)
})

test("invalid urls return null", () => {
  assert.equal(normalizeUrl("not a url"), null)
  assert.equal(normalizeUrl("ftp://a.com/x"), null)
})

test("normalizeTitle ignores case, whitespace, common extensions", () => {
  assert.equal(normalizeTitle("  My  Paper.PDF "), "my paper")
  assert.equal(normalizeTitle("my paper"), "my paper")
})

test("groups duplicates by url and by title, keeps first as keeper", () => {
  const groups = findDuplicateGroups([
    { id: "1", title: "A", url: "https://www.a.com/x?utm_source=t" },
    { id: "2", title: "B", url: "https://a.com/x" },
    { id: "3", title: "Notes.pdf" },
    { id: "4", title: "notes" },
    { id: "5", title: "unique", url: "https://a.com/y" },
  ])
  assert.equal(groups.length, 2)
  const urlGroup = groups.find((g) => g.matchedOn === "url")!
  assert.deepEqual(urlGroup.sources.map((s) => s.id), ["1", "2"])
  const titleGroup = groups.find((g) => g.matchedOn === "title")!
  assert.deepEqual(titleGroup.sources.map((s) => s.id), ["3", "4"])
  assert.deepEqual(deletableIds(groups).sort(), ["2", "4"])
})

test("no false positives for distinct sources", () => {
  const groups = findDuplicateGroups([
    { id: "1", title: "A", url: "https://a.com/1" },
    { id: "2", title: "B", url: "https://a.com/2" },
    { id: "3", title: "C" },
  ])
  assert.equal(groups.length, 0)
})
