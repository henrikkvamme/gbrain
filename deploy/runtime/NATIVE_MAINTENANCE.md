# Protected native maintenance transport

The product supervisor owns a separate control listener on port 3133. It is
opt-in (`GBRAIN_ENABLE_NATIVE=true`), never an MCP operation, and never relaxes
`remote=true` protections. Root must provision private HTTPS routing to this
listener without a public unauthenticated route or logging request bodies.

Set exact `GBRAIN_NATIVE_BRAIN` and `GBRAIN_NATIVE_CLIENT`, with distinct strong
`GBRAIN_NATIVE_SCHEDULER_TOKEN` and `GBRAIN_NATIVE_EXECUTOR_TOKEN` (32+ base64url
characters). Scheduler may submit/status fixed runs; executor may poll/result
fixed inference. A third, randomly generated relay role exists only inside the
worker environment for infer/inference. Role authorization precedes body parsing.
There is no arbitrary command, path, model, source or phase selector.

Fixed runs preserve native operations:

- `communications-dream`: exact application-confirmed generation/revision for
  `bender-communications`, then the existing full `runCycle`.
- `behavior-dream`: `bender-behavior`, native `propose_takes` only.
- `behavior-publish`: additive bounded observation/feedback/daily-review Markdown
  paths only, atomic fsynced replacement, path-limited Git commit, normal hooks,
  existing `runSync --no-pull` afterward. Symlink projections are refused.
- `behavior-search`: original workflow-friction query, scoped remote search,
  limit 20. No protected local operation is granted to ordinary MCP.

The supervisor retains the SAME external flock inode across clean HTTP exit,
verified detached group drain, native child execution and HTTP restart. Do not
run replicas, overlap rolling updates, start a second CLI owner, or add a nested
child flock that deadlocks against the parent's retained lock. The native child
is stdin-gated until its Linux boot/start-time/group/session fence is journaled.
The durable journal is the single writer ledger, not an inference-cache receipt.
Restart proves uncertain owners absent before admitting any engine/HTTP owner;
missing launch identity, reused PID or surviving descendants fail closed.

All native agent inference is the existing gateway's text-only Codex invocation
relayed to the Mac's managed executable, with unchanged `gpt-5.6-luna@low` or
`gpt-5.6-sol@high` pairs. This server relay contains no harness. The worker loads
the existing file+database configuration and connects to existing PGlite without
schema initialization/migration/re-embedding. Embeddings stay on existing Ollama.
Non-Codex inference, alternate pairs, tools, OCR and query expansion fail closed
in this child only; existing configuration is never rewritten. Refusals caught by
a native phase still make the whole run fail rather than return false success.

Full communications dream preflights tool-dependent phases: configured session
corpus synthesis and enabled patterns require durable subagent tool loops that
the existing text-only Codex recipe cannot provide. Root must verify the actual
copied database flags before enabling this listener. If enabled, preserve the
configuration and hold activation; implementing a Mac durable tool-loop protocol
requires a separate product decision. Do not disable phases or switch providers
to make a run pass. Consolidation and other existing text/native deterministic
phases retain their original algorithms; failures cannot be hidden by relay cache.

Admission is single-run; immutable canonical run digest and monotonically
increasing sequence fence replay. Identical completed submit returns its receipt;
changed replay or stale generation rejects. Each inference binds run, execution
epoch, request UUID, digest and deadline. Identical result replay is accepted;
changed, expired or obsolete result is refused. Wire 2 MiB, prompt 1 MiB, result
512 KiB, 128 pages / 64 KiB each, one-hour run, five-minute inference, 4096 runs,
64 MiB journal. All journals use atomic rename plus file/directory fsync.

The server checks current applied Gmail watermark under writer admission. The
managed producer wrapper must retain its reconcile/maintenance exclusion until
the Mac's daily communications completion commits, preventing an incremental
apply from superseding the anchored receipt. The Mac scheduler must resume its
pending request before issuing fresh work. Verified terminal failures permit
bounded fresh attempts; uncertain ownership never permits replay execution.
Native interrupted phases are at-least-once, not a distributed transaction.

Keep existing storage paths and the 5 GiB guard. Native credentials and state
belong in managed private provisioning, not Git. No live DB mount/copy to Mac,
VPS harness, account refresh, model pull or automatic brain initialization.
Disable native admission and prove all children drained before rollback. Retain
journals/receipts and do not restore an older database over successful writes.
Only then re-enable legacy protected jobs on their original shared lock.

Source gates use `test/runtime/native-control.test.ts`,
`native-policy.serial.test.ts`, lifecycle/process-owner tests, and Linux-only
`native-owner-linux.test.ts`/`process-owner.serial.test.ts` in a network-disabled
cached runtime container. The consumer's loopback conformance gate runs actual
control protocol with a fake Mac executable. Full repository release gates and
managed deployment/live acceptance remain separate gates.
