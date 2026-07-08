/**
 * Batch-generation queue state machine (pure logic, unit-tested).
 * The adapter/service-worker drives it; this module only holds state + transitions.
 */

export type JobState = "pending" | "generating" | "done" | "failed"

export type Job = {
  id: string
  sourceId: string
  sourceTitle: string
  artifactType: string
  state: JobState
  attempts: number
  /** Filled in when the generated artifact is identified (powers rename-by-source). */
  artifactId?: string
  error?: string
}

export type BatchState = {
  batchId: string
  notebookId: string
  jobs: Job[]
  status: "idle" | "running" | "paused_rate_limit" | "finished"
  createdAt: number
}

export const MAX_ATTEMPTS = 2 // initial try + one retry

export function createBatch(args: {
  batchId: string
  notebookId: string
  artifactType: string
  sources: Array<{ id: string; title: string }>
  now?: number
}): BatchState {
  return {
    batchId: args.batchId,
    notebookId: args.notebookId,
    status: "idle",
    createdAt: args.now ?? Date.now(),
    jobs: args.sources.map((s, i) => ({
      id: `${args.batchId}:${i}`,
      sourceId: s.id,
      sourceTitle: s.title,
      artifactType: args.artifactType,
      state: "pending",
      attempts: 0,
    })),
  }
}

/** Returns the next pending job, or null. Does not mutate. */
export function nextPending(batch: BatchState): Job | null {
  return batch.jobs.find((j) => j.state === "pending") ?? null
}

export function startJob(batch: BatchState, jobId: string): BatchState {
  return update(batch, jobId, (j) => {
    if (j.state !== "pending") throw new Error(`cannot start job in state ${j.state}`)
    return { ...j, state: "generating", attempts: j.attempts + 1 }
  }, { status: "running" })
}

export function completeJob(batch: BatchState, jobId: string, artifactId?: string): BatchState {
  const next = update(batch, jobId, (j) => {
    if (j.state !== "generating") throw new Error(`cannot complete job in state ${j.state}`)
    return { ...j, state: "done", artifactId }
  })
  return finalizeIfDone(next)
}

/**
 * Fail a job. If it has attempts left it goes back to `pending` (retry-once);
 * otherwise it is marked `failed` and the batch moves on.
 */
export function failJob(batch: BatchState, jobId: string, error: string): BatchState {
  const next = update(batch, jobId, (j) => {
    if (j.state !== "generating") throw new Error(`cannot fail job in state ${j.state}`)
    return j.attempts < MAX_ATTEMPTS
      ? { ...j, state: "pending", error }
      : { ...j, state: "failed", error }
  })
  return finalizeIfDone(next)
}

/** Rate limit detected: current job returns to pending, batch pauses. */
export function pauseForRateLimit(batch: BatchState, jobId: string): BatchState {
  return update(batch, jobId, (j) => {
    if (j.state !== "generating") throw new Error(`cannot pause job in state ${j.state}`)
    // A rate limit is not the job's fault - don't count the attempt.
    return { ...j, state: "pending", attempts: Math.max(0, j.attempts - 1) }
  }, { status: "paused_rate_limit" })
}

export function resume(batch: BatchState): BatchState {
  if (batch.status !== "paused_rate_limit") return batch
  return { ...batch, status: "running" }
}

export function summary(batch: BatchState): {
  total: number
  done: number
  failed: number
  pending: number
  generating: number
} {
  const s = { total: batch.jobs.length, done: 0, failed: 0, pending: 0, generating: 0 }
  for (const j of batch.jobs) {
    if (j.state === "done") s.done++
    else if (j.state === "failed") s.failed++
    else if (j.state === "pending") s.pending++
    else s.generating++
  }
  return s
}

function finalizeIfDone(batch: BatchState): BatchState {
  const open = batch.jobs.some((j) => j.state === "pending" || j.state === "generating")
  return open ? batch : { ...batch, status: "finished" }
}

function update(
  batch: BatchState,
  jobId: string,
  fn: (j: Job) => Job,
  patch?: Partial<Pick<BatchState, "status">>,
): BatchState {
  const idx = batch.jobs.findIndex((j) => j.id === jobId)
  if (idx === -1) throw new Error(`unknown job ${jobId}`)
  const jobs = batch.jobs.slice()
  jobs[idx] = fn(jobs[idx])
  return { ...batch, jobs, ...(patch ?? {}) }
}
