import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createBatch,
  nextPending,
  startJob,
  completeJob,
  failJob,
  pauseForRateLimit,
  resume,
  summary,
} from "./queue.ts"

const mk = () =>
  createBatch({
    batchId: "b1",
    notebookId: "nb1",
    artifactType: "audio_overview",
    sources: [
      { id: "s1", title: "One" },
      { id: "s2", title: "Two" },
    ],
    now: 0,
  })

test("createBatch: all jobs pending, batch idle", () => {
  const b = mk()
  assert.equal(b.status, "idle")
  assert.deepEqual(b.jobs.map((j) => j.state), ["pending", "pending"])
})

test("happy path: start -> complete both -> finished", () => {
  let b = mk()
  const j1 = nextPending(b)!
  b = startJob(b, j1.id)
  assert.equal(b.status, "running")
  b = completeJob(b, j1.id, "artifact-1")
  const j2 = nextPending(b)!
  b = startJob(b, j2.id)
  b = completeJob(b, j2.id, "artifact-2")
  assert.equal(b.status, "finished")
  assert.deepEqual(summary(b), { total: 2, done: 2, failed: 0, pending: 0, generating: 0 })
  assert.equal(b.jobs[0].artifactId, "artifact-1")
})

test("retry once: first failure returns to pending, second marks failed", () => {
  let b = mk()
  const j1 = nextPending(b)!
  b = startJob(b, j1.id)
  b = failJob(b, j1.id, "boom")
  assert.equal(b.jobs[0].state, "pending")
  b = startJob(b, j1.id)
  b = failJob(b, j1.id, "boom again")
  assert.equal(b.jobs[0].state, "failed")
  // batch continues with the second job
  assert.ok(nextPending(b))
})

test("one failed job never stalls the batch", () => {
  let b = mk()
  const j1 = nextPending(b)!
  b = startJob(b, j1.id)
  b = failJob(b, j1.id, "x")
  b = startJob(b, j1.id)
  b = failJob(b, j1.id, "x")
  const j2 = nextPending(b)!
  assert.equal(j2.sourceId, "s2")
  b = startJob(b, j2.id)
  b = completeJob(b, j2.id)
  assert.equal(b.status, "finished")
  assert.deepEqual(summary(b), { total: 2, done: 1, failed: 1, pending: 0, generating: 0 })
})

test("rate limit: pauses batch, does not consume an attempt", () => {
  let b = mk()
  const j1 = nextPending(b)!
  b = startJob(b, j1.id)
  b = pauseForRateLimit(b, j1.id)
  assert.equal(b.status, "paused_rate_limit")
  assert.equal(b.jobs[0].state, "pending")
  assert.equal(b.jobs[0].attempts, 0)
  b = resume(b)
  assert.equal(b.status, "running")
  // job can be started twice more (attempt 1 + retry) before failing for good
  b = startJob(b, j1.id)
  b = failJob(b, j1.id, "e")
  b = startJob(b, j1.id)
  b = failJob(b, j1.id, "e")
  assert.equal(b.jobs[0].state, "failed")
})

test("invalid transitions throw", () => {
  let b = mk()
  const j1 = nextPending(b)!
  assert.throws(() => completeJob(b, j1.id))
  b = startJob(b, j1.id)
  assert.throws(() => startJob(b, j1.id))
  assert.throws(() => startJob(b, "nope"))
})
