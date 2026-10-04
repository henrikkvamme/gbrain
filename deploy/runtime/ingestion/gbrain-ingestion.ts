import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { containsCredentialLikeText } from "./credential-safety";
import { mirrorSeafileVault } from "./seafile-vault-snapshot";

const adapterKey = "obsidian-notes";
const gbrainSourceId = "bender-authored";
const importerVersion = 1;
const maxPages = 100_000;
const maxBundleBytes = 2 * 1024 * 1024 * 1024;

type AdapterProfile = {
  adapterKey: string;
  displayName: string;
  gbrainSourceId: string;
  pathPrefix: `${string}/`;
  trustDefault: string;
  cadenceSeconds: number;
  commitLabel: string;
};

const adapterProfiles: Record<string, AdapterProfile> = {
  "obsidian-notes": {
    adapterKey: "obsidian-notes",
    displayName: "Obsidian",
    gbrainSourceId: "bender-authored",
    pathPrefix: "obsidian/",
    trustDefault: "authored",
    cadenceSeconds: 3600,
    commitLabel: "Obsidian",
  },
  "gmail-threads": {
    adapterKey: "gmail-threads",
    displayName: "Gmail",
    gbrainSourceId: "bender-communications",
    pathPrefix: "gmail/",
    trustDefault: "external_untrusted",
    cadenceSeconds: 900,
    commitLabel: "Gmail",
  },
};

type RejectionReason =
  | "agent_inbox"
  | "credential_like_text"
  | "empty_or_tiny"
  | "generated_excalidraw"
  | "hidden_path"
  | "inbox_path"
  | "older_than_since"
  | "system_path"
  | "symlink"
  | "not_markdown";

export type ObsidianPreviewRecord = {
  relativePath: string;
  modifiedAt: string;
  bytes: number;
};

export type ObsidianPreview = {
  selected: ObsidianPreviewRecord[];
  rejected: Array<ObsidianPreviewRecord & { reason: RejectionReason }>;
};

export type BundlePage = {
  adapterKey: string;
  title: string;
  externalId: string;
  sourceUri: string;
  sourceModifiedAt: string;
  contentHash: string;
  bundlePath: string;
  targetPath: string;
  bytes: number;
};

export type KnowledgeBundleManifest = {
  schemaVersion: 1;
  adapterKey: string;
  gbrainSourceId: string;
  generation: number;
  sourceRevision: string;
  importerVersion: number;
  completeSnapshot: true;
  runId: string;
  createdAt: string;
  stats: {
    selected: number;
    rejected: number;
    rejectedByReason: Record<string, number>;
    bytes: number;
  };
  evaluation: { bundlePath: string; contentHash: string; questions: number };
  pages: BundlePage[];
};

type AdapterCheckpoint = {
  schemaVersion: 1;
  adapterKey: string;
  generation: number;
  sourceRevision: string;
  importerVersion: number;
  gbrainSourceId: string;
  pathPrefix: string;
  selectionPolicyVersion: 1;
  trustDefault: string;
  aclScope: "personal";
  cadenceSeconds: number;
  pages: Array<Pick<BundlePage, "externalId" | "targetPath" | "contentHash">>;
  tombstones: Array<
    Pick<BundlePage, "externalId" | "targetPath" | "contentHash"> & { deletedAtGeneration: number }
  >;
};

type LocalAdapterState = {
  generation: number;
  sourceRevision?: string;
  records: Record<string, { rawContentHash: string; sourceModifiedAt: string }>;
};

export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<CommandResult>;

export type ApplyResult = {
  adapterKey: string;
  sourceRevision: string;
  generation: number;
  discovered: number;
  selected: number;
  rejected: number;
  rejectedByReason: KnowledgeBundleManifest["stats"]["rejectedByReason"];
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  committed: boolean;
  synced: true;
  embeddings: "enabled";
  evaluation:
    | { status: "not_run"; questions: 0 }
    | {
        status: "passed";
        questions: number;
        hitAt1: number;
        hitAt3: number;
        mrr: number;
        recallAt10: number;
        warnings: number;
      };
};

if (import.meta.main) {
  await runCli().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    await reportHealthSignal("obsidian-notes", "failed", { error: sanitizeError(message) }).catch(
      () => undefined,
    );
    process.exitCode = 1;
  });
}

export async function previewObsidian(options: {
  vault: string;
  since?: string;
}): Promise<ObsidianPreview> {
  const vault = resolve(options.vault);
  const since = options.since ? new Date(options.since) : undefined;
  if (!existsSync(vault) || !statSync(vault).isDirectory())
    throw new Error(`Obsidian vault is not a directory: ${vault}`);
  if (since && Number.isNaN(since.getTime()))
    throw new Error(`Invalid --since timestamp: ${options.since}`);
  const selected: ObsidianPreviewRecord[] = [];
  const rejected: ObsidianPreview["rejected"] = [];

  for (const absolutePath of walk(vault)) {
    const relativePath = portablePath(relative(vault, absolutePath));
    const stat = lstatSync(absolutePath);
    const record = { relativePath, modifiedAt: stat.mtime.toISOString(), bytes: stat.size };
    const reason = rejectionReason(absolutePath, relativePath, stat.isSymbolicLink(), since);
    if (reason) rejected.push({ ...record, reason });
    else selected.push(record);
  }
  selected.sort(comparePath);
  rejected.sort(comparePath);
  return { selected, rejected };
}

export async function prepareObsidianBundle(options: {
  vault: string;
  bundle: string;
  state: string;
  since?: string;
  seedRepo?: string;
}): Promise<{ manifest: KnowledgeBundleManifest; preview: ObsidianPreview }> {
  const preview = await previewObsidian(options);
  if (preview.selected.length > maxPages) throw new Error(`Bundle exceeds ${maxPages} pages`);
  const previousState = readLocalState(options.state, options.seedRepo);
  const bundle = resolve(options.bundle);
  const temporaryBundle = `${bundle}.tmp-${process.pid}`;
  rmSync(temporaryBundle, { recursive: true, force: true });
  mkdirSync(join(temporaryBundle, "pages"), { recursive: true, mode: 0o700 });
  const pages: BundlePage[] = [];
  const searchTermsByPath = new Map<string, Set<string>>();
  const records: LocalAdapterState["records"] = {};
  let bundleBytes = 0;

  const notes = preview.selected.map((record) => {
    const raw = readFileSync(join(resolve(options.vault), record.relativePath), "utf8");
    const externalId = record.relativePath;
    const id = sha256(`${adapterKey}\0${externalId}`).slice(0, 16);
    const targetPath = `obsidian/${id}.md`;
    const sourceUri = `obsidian://${encodeURI(record.relativePath)}`;
    const title = titleForNote(record.relativePath, raw);
    const rawContentHash = sha256(normalizeText(raw));
    const sourceModifiedAt =
      previousState.records[externalId]?.rawContentHash === rawContentHash
        ? previousState.records[externalId]!.sourceModifiedAt
        : record.modifiedAt;
    records[externalId] = { rawContentHash, sourceModifiedAt };
    return {
      raw,
      externalId,
      targetPath,
      targetSlug: targetPath.replace(/\.md$/, ""),
      sourceUri,
      title,
      rawContentHash,
      sourceModifiedAt,
    };
  });
  const wikiLinkIndex = createWikiLinkIndex(notes);

  for (const note of notes) {
    const rendered = renderPage({
      title: note.title,
      externalId: note.externalId,
      sourceUri: note.sourceUri,
      sourceModifiedAt: note.sourceModifiedAt,
      contentHash: note.rawContentHash,
      content: stripSourceFrontmatter(note.raw),
      relatedSlugs: [
        ...new Set([
          ...resolveWikiLinkSlugs(note.raw, note.targetSlug, wikiLinkIndex),
          "indexes/source-index",
        ]),
      ].sort(),
    });
    const bundlePath = `pages/${note.targetPath}`;
    const bytes = Buffer.byteLength(rendered);
    bundleBytes += bytes;
    if (bundleBytes > maxBundleBytes) throw new Error(`Bundle exceeds ${maxBundleBytes} bytes`);
    const destination = join(temporaryBundle, bundlePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, rendered, { mode: 0o600 });
    searchTermsByPath.set(
      note.targetPath,
      new Set(evaluationTitleTerms(rendered).map((term) => term.toLocaleLowerCase())),
    );
    pages.push({
      adapterKey,
      title: note.title,
      externalId: note.externalId,
      sourceUri: note.sourceUri,
      sourceModifiedAt: note.sourceModifiedAt,
      contentHash: sha256(rendered),
      bundlePath,
      targetPath: note.targetPath,
      bytes,
    });
  }

  const sourceRevision = sha256(
    pages.map((page) => `${page.externalId}\0${page.contentHash}`).join("\n"),
  );
  const rejectedByReason: KnowledgeBundleManifest["stats"]["rejectedByReason"] = {};
  for (const record of preview.rejected)
    rejectedByReason[record.reason] = (rejectedByReason[record.reason] ?? 0) + 1;
  const generation =
    previousState.sourceRevision === sourceRevision
      ? previousState.generation
      : previousState.generation + 1;
  const documentFrequency = new Map<string, number>();
  for (const terms of searchTermsByPath.values()) {
    for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const evaluationGroups = new Map<string, string[]>();
  for (const page of pages) {
    if (!isEvaluationTitle(page.title)) continue;
    const query = evaluationQueryForTitle(page.title);
    const relevant = evaluationGroups.get(query) ?? [];
    relevant.push(page.targetPath.replace(/\.md$/, ""));
    evaluationGroups.set(query, relevant);
  }
  const evaluationLines = [...evaluationGroups]
    .sort(
      ([left], [right]) =>
        evaluationTitleScore(right, documentFrequency, pages.length) -
          evaluationTitleScore(left, documentFrequency, pages.length) || left.localeCompare(right),
    )
    .slice(0, 30)
    .map(([title, relevant]) =>
      JSON.stringify({
        family: "title-substring",
        query: title,
        relevant,
      }),
    );
  const evaluationContent = evaluationLines.length ? `${evaluationLines.join("\n")}\n` : "";
  const evaluationPath = "evaluation.jsonl";
  writeFileSync(join(temporaryBundle, evaluationPath), evaluationContent, { mode: 0o600 });
  const manifest: KnowledgeBundleManifest = {
    schemaVersion: 1,
    adapterKey,
    gbrainSourceId,
    generation,
    sourceRevision,
    importerVersion,
    completeSnapshot: true,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    stats: {
      selected: pages.length,
      rejected: preview.rejected.length,
      rejectedByReason,
      bytes: bundleBytes,
    },
    evaluation: {
      bundlePath: evaluationPath,
      contentHash: sha256(evaluationContent),
      questions: evaluationLines.length,
    },
    pages,
  };
  writeFileSync(join(temporaryBundle, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  rmSync(bundle, { recursive: true, force: true });
  renameSync(temporaryBundle, bundle);
  mkdirSync(dirname(resolve(options.state)), { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(options.state),
    `${JSON.stringify({ schemaVersion: 1, generation, sourceRevision, records })}\n`,
    { mode: 0o600 },
  );
  return { manifest, preview };
}

export async function applyKnowledgeBundle(
  options: { bundle: string; repo: string; gbrainBin: string },
  dependencies: { run?: CommandRunner } = {},
): Promise<ApplyResult> {
  const run = dependencies.run ?? defaultCommandRunner;
  const bundle = resolve(options.bundle);
  const repo = resolve(options.repo);
  const manifest = readManifest(join(bundle, "manifest.json"));
  const profile = adapterProfileFor(manifest.adapterKey);
  const checkpointPath = join(repo, ".bender-ingestion", "adapters", `${manifest.adapterKey}.json`);
  const checkpoint = readCheckpoint(checkpointPath, profile);
  if (checkpoint) {
    if (manifest.generation < checkpoint.generation)
      throw new Error(
        `stale generation ${manifest.generation}; current is ${checkpoint.generation}`,
      );
    if (
      manifest.generation === checkpoint.generation &&
      manifest.sourceRevision !== checkpoint.sourceRevision
    ) {
      throw new Error(`stale generation ${manifest.generation} has a different source revision`);
    }
  }

  const verifiedPages = new Map<string, Buffer>();
  const externalIds = new Set<string>();
  let verifiedBytes = 0;
  for (const page of manifest.pages) {
    assertSafeRelativePath(page.bundlePath);
    assertSafeRelativePath(page.targetPath);
    if (!page.targetPath.startsWith(profile.pathPrefix))
      throw new Error(
        `Page target is outside the ${profile.displayName} adapter prefix: ${page.targetPath}`,
      );
    if (page.adapterKey !== manifest.adapterKey)
      throw new Error(`Page adapter mismatch for ${page.targetPath}`);
    if (typeof page.title !== "string" || !normalizeTitle(page.title))
      throw new Error(`Page title is invalid for ${page.targetPath}`);
    if (externalIds.has(page.externalId) || verifiedPages.has(page.targetPath))
      throw new Error(`Duplicate page identity or target: ${page.targetPath}`);
    externalIds.add(page.externalId);
    assertNoSymlinkComponents(bundle, page.bundlePath);
    const content = readFileSync(join(bundle, page.bundlePath));
    verifiedBytes += content.byteLength;
    if (verifiedBytes > maxBundleBytes) throw new Error(`Bundle exceeds ${maxBundleBytes} bytes`);
    if (sha256(content) !== page.contentHash || content.byteLength !== page.bytes)
      throw new Error(`Bundle hash mismatch for ${page.bundlePath}`);
    verifiedPages.set(page.targetPath, content);
  }
  const verifiedRevision = sha256(
    manifest.pages.map((page) => `${page.externalId}\0${page.contentHash}`).join("\n"),
  );
  if (verifiedRevision !== manifest.sourceRevision)
    throw new Error("Bundle source revision does not match its verified pages");
  if (verifiedBytes !== manifest.stats.bytes) throw new Error("Bundle byte total is invalid");
  assertSafeRelativePath(manifest.evaluation.bundlePath);
  const evaluationPath = join(bundle, manifest.evaluation.bundlePath);
  assertNoSymlinkComponents(bundle, manifest.evaluation.bundlePath);
  const evaluationContent = readFileSync(evaluationPath);
  if (sha256(evaluationContent) !== manifest.evaluation.contentHash)
    throw new Error("Bundle evaluation fixture hash mismatch");
  const questionCount = evaluationContent
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim()).length;
  if (questionCount !== manifest.evaluation.questions)
    throw new Error("Bundle evaluation question count is invalid");

  const nextPaths = new Set(manifest.pages.map((page) => page.targetPath));
  const deletionPlan: string[] = [];
  const checkpointExternalIds = new Set<string>();
  const checkpointPaths = new Set<string>();
  for (const oldPage of checkpoint?.pages ?? []) {
    validateOwnedCheckpointPage(repo, oldPage, profile);
    if (checkpointExternalIds.has(oldPage.externalId) || checkpointPaths.has(oldPage.targetPath))
      throw new Error(`Duplicate checkpoint page: ${oldPage.targetPath}`);
    checkpointExternalIds.add(oldPage.externalId);
    checkpointPaths.add(oldPage.targetPath);
    if (nextPaths.has(oldPage.targetPath)) continue;
    const target = join(repo, oldPage.targetPath);
    if (existsSync(target)) {
      if (sha256(readFileSync(target)) !== oldPage.contentHash)
        throw new Error(`Refusing to delete locally modified page: ${oldPage.targetPath}`);
      deletionPlan.push(target);
    }
  }
  for (const tombstone of checkpoint?.tombstones ?? [])
    validateOwnedCheckpointPage(repo, tombstone, profile);
  for (const page of manifest.pages) assertNoSymlinkComponents(repo, page.targetPath);

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const page of manifest.pages) {
    const content = verifiedPages.get(page.targetPath)!;
    const target = join(repo, page.targetPath);
    if (!existsSync(target)) created += 1;
    else if (readFileSync(target).equals(content)) unchanged += 1;
    else updated += 1;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: 0o600 });
  }

  for (const target of deletionPlan) rmSync(target);
  const deleted = deletionPlan.length;
  const nextCheckpoint: AdapterCheckpoint = {
    schemaVersion: 1,
    adapterKey: manifest.adapterKey,
    generation: manifest.generation,
    sourceRevision: manifest.sourceRevision,
    importerVersion: manifest.importerVersion,
    gbrainSourceId: manifest.gbrainSourceId,
    pathPrefix: profile.pathPrefix,
    selectionPolicyVersion: 1,
    trustDefault: profile.trustDefault,
    aclScope: "personal",
    cadenceSeconds: profile.cadenceSeconds,
    pages: manifest.pages.map(({ externalId, targetPath, contentHash }) => ({
      externalId,
      targetPath,
      contentHash,
    })),
    tombstones: [
      ...(checkpoint?.tombstones ?? []),
      ...(checkpoint?.pages ?? [])
        .filter((page) => !nextPaths.has(page.targetPath))
        .map((page) => ({ ...page, deletedAtGeneration: manifest.generation })),
    ],
  };
  mkdirSync(dirname(checkpointPath), { recursive: true, mode: 0o700 });
  writeFileSync(checkpointPath, `${JSON.stringify(nextCheckpoint, null, 2)}\n`, { mode: 0o600 });

  await checked(
    run,
    "git",
    [
      "add",
      "-A",
      "--",
      profile.pathPrefix.slice(0, -1),
      `.bender-ingestion/adapters/${manifest.adapterKey}.json`,
    ],
    repo,
  );
  const status = await checked(
    run,
    "git",
    [
      "status",
      "--short",
      "--",
      profile.pathPrefix.slice(0, -1),
      `.bender-ingestion/adapters/${manifest.adapterKey}.json`,
    ],
    repo,
  );
  const committed = status.stdout.trim().length > 0;
  if (committed) {
    await checked(
      run,
      "git",
      [
        "-c",
        "user.name=Knowledge importer",
        "-c",
        "user.email=importer@localhost",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--only",
        profile.pathPrefix.slice(0, -1),
        `.bender-ingestion/adapters/${manifest.adapterKey}.json`,
        "-m",
        `Ingest ${profile.commitLabel} generation ${manifest.generation}`,
      ],
      repo,
    );
  }
  await checked(run, options.gbrainBin, [
    "sync",
    "--source",
    manifest.gbrainSourceId,
    "--dir",
    repo,
    "--no-extract",
  ]);
  await checked(run, options.gbrainBin, [
    "extract",
    "all",
    "--source",
    "db",
    "--source-id",
    manifest.gbrainSourceId,
    "--include-frontmatter",
  ]);
  let evaluation: ApplyResult["evaluation"] = { status: "not_run", questions: 0 };
  if (manifest.evaluation.questions > 0) {
    const evaluationCommand = await checked(run, options.gbrainBin, [
      "eval",
      "retrieval-quality",
      evaluationPath,
      "--json",
      "--source",
      manifest.gbrainSourceId,
    ]);
    evaluation = parseEvaluationReport(evaluationCommand.stdout, manifest.evaluation.questions);
  }
  return {
    adapterKey: manifest.adapterKey,
    sourceRevision: manifest.sourceRevision,
    generation: manifest.generation,
    discovered: manifest.stats.selected + manifest.stats.rejected,
    selected: manifest.stats.selected,
    rejected: manifest.stats.rejected,
    rejectedByReason: manifest.stats.rejectedByReason,
    created,
    updated,
    deleted,
    unchanged,
    committed,
    synced: true,
    embeddings: "enabled",
    evaluation,
  };
}

export async function applyKnowledgeBundleReported(options: {
  bundle: string;
  repo: string;
  gbrainBin: string;
}) {
  const manifest = readManifest(join(resolve(options.bundle), "manifest.json"));
  const report = await startReportedRun(manifest);
  try {
    const result = await applyKnowledgeBundle(options);
    await completeReportedRun(report, { status: "succeeded", result });
    await reportHealthSignal(manifest.adapterKey, "ok", result);
    return result;
  } catch (error) {
    const message = sanitizeError(error instanceof Error ? error.message : String(error));
    await completeReportedRun(report, { status: "failed", error: message }).catch(
      () => undefined,
    );
    await reportHealthSignal(manifest.adapterKey, "failed", { error: message }).catch(
      () => undefined,
    );
    throw error;
  }
}

async function runCli() {
  const [command, ...args] = Bun.argv.slice(2);
  const flags = parseFlags(args);
  if (command === "preview") {
    const result = await previewObsidian({
      vault: requiredFlag(flags, "vault"),
      since: flags.since,
    });
    outputJson(result);
    return;
  }
  if (command === "prepare") {
    const result = await prepareObsidianBundle({
      vault: requiredFlag(flags, "vault"),
      bundle: requiredFlag(flags, "bundle"),
      state: requiredFlag(flags, "state"),
      since: flags.since,
      seedRepo: flags["seed-repo"],
    });
    outputJson({
      manifest: result.manifest,
      rejectedPreview: result.preview.rejected.slice(0, 20),
    });
    return;
  }
  if (command === "prepare-seafile") {
    const repoToken = Bun.env.SEAFILE_REPO_TOKEN;
    if (!repoToken) throw new Error("SEAFILE_REPO_TOKEN is required");
    const snapshot = await mirrorSeafileVault({
      baseUrl: requiredFlag(flags, "host"),
      repoToken,
      destination: requiredFlag(flags, "vault"),
    });
    const result = await prepareObsidianBundle({
      vault: snapshot.vaultPath,
      bundle: requiredFlag(flags, "bundle"),
      state: requiredFlag(flags, "state"),
      since: flags.since,
      seedRepo: requiredFlag(flags, "seed-repo"),
    });
    outputJson({
      snapshot,
      manifest: result.manifest,
      rejectedPreview: result.preview.rejected.slice(0, 20),
    });
    return;
  }
  if (command === "apply") {
    const result = await applyKnowledgeBundleReported({
      bundle: requiredFlag(flags, "bundle"),
      repo: requiredFlag(flags, "repo"),
      gbrainBin: requiredFlag(flags, "gbrain-bin"),
    });
    outputJson(result);
    return;
  }
  throw new Error(
    "Usage: gbrain-ingestion.ts <preview|prepare|prepare-seafile|apply> --vault|--bundle|--state|--repo|--gbrain-bin",
  );
}

function rejectionReason(
  absolutePath: string,
  relativePath: string,
  symlink: boolean,
  since?: Date,
): RejectionReason | undefined {
  if (symlink) return "symlink";
  if (relativePath.split("/").some((part) => part.startsWith("."))) return "hidden_path";
  if (!relativePath.toLowerCase().endsWith(".md")) return "not_markdown";
  const normalizedPath = relativePath.normalize("NFC").toLowerCase();
  const content = readFileSync(absolutePath, "utf8");
  if (isWithinPath(normalizedPath, "99 system") && !hasGbrainIncludeProperty(content))
    return "system_path";
  if (isWithinPath(normalizedPath, "10 inbox/agent inbox")) return "agent_inbox";
  if (isWithinPath(normalizedPath, "10 inbox")) return "inbox_path";
  if (relativePath.toLowerCase().endsWith(".excalidraw.md")) return "generated_excalidraw";
  if (since && statSync(absolutePath).mtime < since) return "older_than_since";
  if (normalizeText(content).length < 12) return "empty_or_tiny";
  if (containsCredentialLikeText(content)) return "credential_like_text";
  return undefined;
}

function isWithinPath(normalizedPath: string, root: string) {
  return normalizedPath === root || normalizedPath.startsWith(`${root}/`);
}

function hasGbrainIncludeProperty(content: string) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") return false;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return false;
  for (const line of lines.slice(1, end)) {
    if (line !== line.trimStart()) continue;
    if (/^gbrain\s*:\s*include\s*(?:#.*)?$/iu.test(line.trimEnd())) return true;
  }
  return false;
}

function* walk(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

function renderPage(input: {
  title: string;
  externalId: string;
  sourceUri: string;
  sourceModifiedAt: string;
  contentHash: string;
  content: string;
  relatedSlugs: string[];
}) {
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(input.title)}`,
    'type: "note"',
    `created: ${JSON.stringify(input.sourceModifiedAt)}`,
    'source_system: "obsidian"',
    `adapter_key: ${JSON.stringify(adapterKey)}`,
    `external_id: ${JSON.stringify(input.externalId)}`,
    `source_uri: ${JSON.stringify(input.sourceUri)}`,
    `updated_at_source: ${JSON.stringify(input.sourceModifiedAt)}`,
    `revision_id: ${JSON.stringify(input.contentHash)}`,
    `content_hash: ${JSON.stringify(input.contentHash)}`,
    'trust: "authored"',
    'acl_scope: "personal"',
    ...(input.relatedSlugs.length > 0
      ? [`related: ${JSON.stringify(input.relatedSlugs)}`]
      : []),
    `importer_version: ${importerVersion}`,
    "---",
    "",
  ].join("\n");
  const content = normalizeText(input.content);
  const canonicalTitlePresent = [...content.matchAll(/^#\s+(.+)$/gm)].some(
    (match) => normalizeTitle(match[1] ?? "") === normalizeTitle(input.title),
  );
  const body = canonicalTitlePresent ? content : `# ${input.title}\n\n${content}`;
  return `${frontmatter}${body}\n`;
}

type WikiLinkIndex = {
  byPath: Map<string, string>;
  byBasename: Map<string, string[]>;
};

function createWikiLinkIndex(
  notes: Array<{ externalId: string; targetSlug: string }>,
): WikiLinkIndex {
  const byPath = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const note of notes) {
    const stem = note.externalId.replace(/\.md$/iu, "");
    byPath.set(normalizeWikiLinkTarget(stem), note.targetSlug);
    const name = normalizeWikiLinkTarget(basename(stem));
    byBasename.set(name, [...(byBasename.get(name) ?? []), note.targetSlug]);
  }
  return { byPath, byBasename };
}

function resolveWikiLinkSlugs(content: string, selfSlug: string, index: WikiLinkIndex) {
  const related = new Set<string>();
  for (const match of normalizeText(content).matchAll(/\[\[([^\]]+)\]\]/gu)) {
    const rawTarget = (match[1] ?? "").split("|", 1)[0]!.split("#", 1)[0]!.trim();
    if (!rawTarget) continue;
    const normalized = normalizeWikiLinkTarget(rawTarget.replace(/\.md$/iu, ""));
    const exact = index.byPath.get(normalized);
    const basenameMatches =
      index.byBasename.get(normalizeWikiLinkTarget(basename(normalized))) ?? [];
    const target = exact ?? (basenameMatches.length === 1 ? basenameMatches[0] : undefined);
    if (target && target !== selfSlug) related.add(target);
  }
  return [...related].sort();
}

function normalizeWikiLinkTarget(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC").toLocaleLowerCase();
}

function stripSourceFrontmatter(content: string) {
  const normalized = normalizeText(content);
  if (!normalized.startsWith("---\n")) return normalized;
  const end = normalized.indexOf("\n---\n", 4);
  return end === -1 ? normalized : normalized.slice(end + 5).trimStart();
}

function titleForNote(relativePath: string, content: string) {
  const heading = stripSourceFrontmatter(content)
    .match(/^#\s+(.+)$/m)?.[1]
    ?.trim();
  return normalizeTitle(heading || basename(relativePath, ".md"));
}

function normalizeTitle(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function evaluationTitleTerms(title: string) {
  return title.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isEvaluationTitle(title: string) {
  const terms = evaluationTitleTerms(title);
  return terms.join("").length >= 6 && terms.some((term) => term.length >= 4);
}

function evaluationQueryForTitle(title: string) {
  return evaluationTitleTerms(title).join(" ");
}

function evaluationTitleScore(
  query: string,
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
) {
  const terms = evaluationTitleTerms(query);
  const total = terms.reduce((score, term) => {
    const frequency = documentFrequency.get(term.toLocaleLowerCase()) ?? documentCount;
    return score + Math.log((documentCount + 1) / (frequency + 0.5));
  }, 0);
  return total / terms.length;
}

function readManifest(path: string): KnowledgeBundleManifest {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as KnowledgeBundleManifest;
  const profile = adapterProfileFor(manifest.adapterKey);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.gbrainSourceId !== profile.gbrainSourceId ||
    manifest.completeSnapshot !== true
  ) {
    throw new Error("Unsupported or invalid bundle manifest");
  }
  if (!Number.isSafeInteger(manifest.generation) || manifest.generation < 1)
    throw new Error("Invalid bundle generation");
  if (typeof manifest.runId !== "string" || !/^[0-9a-f-]{36}$/i.test(manifest.runId))
    throw new Error("Invalid bundle run ID");
  if (!Array.isArray(manifest.pages) || manifest.pages.length > maxPages)
    throw new Error("Invalid bundle pages");
  if (
    !manifest.evaluation ||
    !Number.isSafeInteger(manifest.evaluation.questions) ||
    manifest.evaluation.questions < 0 ||
    manifest.evaluation.questions > 50
  )
    throw new Error("Invalid bundle evaluation fixture");
  return manifest;
}

function readCheckpoint(
  path: string,
  profile: AdapterProfile = adapterProfileFor(adapterKey),
): AdapterCheckpoint | undefined {
  if (!existsSync(path)) return undefined;
  const checkpoint = JSON.parse(readFileSync(path, "utf8")) as AdapterCheckpoint;
  if (
    checkpoint.schemaVersion !== 1 ||
    checkpoint.adapterKey !== profile.adapterKey ||
    checkpoint.gbrainSourceId !== profile.gbrainSourceId ||
    checkpoint.pathPrefix !== profile.pathPrefix ||
    !Array.isArray(checkpoint.pages)
  )
    throw new Error("Invalid adapter checkpoint");
  return checkpoint;
}

function readLocalState(path: string, seedRepo?: string): LocalAdapterState {
  if (!existsSync(path))
    return seedRepo ? recoverLocalStateFromRepo(resolve(seedRepo)) : { generation: 0, records: {} };
  const value = JSON.parse(readFileSync(path, "utf8")) as {
    generation?: unknown;
    sourceRevision?: unknown;
    records?: unknown;
  };
  if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 0)
    throw new Error("Invalid local generation state");
  if (value.sourceRevision !== undefined && typeof value.sourceRevision !== "string")
    throw new Error("Invalid local source revision");
  if (value.records !== undefined && (typeof value.records !== "object" || value.records === null))
    throw new Error("Invalid local record state");
  return {
    generation: Number(value.generation),
    sourceRevision: value.sourceRevision,
    records: (value.records as LocalAdapterState["records"] | undefined) ?? {},
  };
}

function recoverLocalStateFromRepo(repo: string): LocalAdapterState {
  const profile = adapterProfileFor(adapterKey);
  const checkpoint = readCheckpoint(
    join(repo, ".bender-ingestion", "adapters", `${adapterKey}.json`),
    profile,
  );
  if (!checkpoint) return { generation: 0, records: {} };
  if (
    !Number.isSafeInteger(checkpoint.generation) ||
    checkpoint.generation < 1 ||
    typeof checkpoint.sourceRevision !== "string" ||
    !/^[a-f0-9]{64}$/i.test(checkpoint.sourceRevision)
  )
    throw new Error("Invalid adapter checkpoint generation state");
  const records: LocalAdapterState["records"] = {};
  const targetPaths = new Set<string>();
  for (const page of checkpoint.pages) {
    validateOwnedCheckpointPage(repo, page, profile);
    if (records[page.externalId] || targetPaths.has(page.targetPath))
      throw new Error(`Duplicate applied source page: ${page.targetPath}`);
    targetPaths.add(page.targetPath);
    const rendered = readFileSync(join(repo, page.targetPath), "utf8");
    if (sha256(rendered) !== page.contentHash)
      throw new Error(`Applied source page does not match its checkpoint: ${page.targetPath}`);
    const externalId = renderedFrontmatterString(rendered, "external_id");
    const sourceModifiedAt = renderedFrontmatterString(rendered, "updated_at_source");
    const rawContentHash = renderedFrontmatterString(rendered, "content_hash");
    if (externalId !== page.externalId)
      throw new Error(`Applied source page identity is invalid: ${page.targetPath}`);
    if (
      Number.isNaN(new Date(sourceModifiedAt).getTime()) ||
      !/^[a-f0-9]{64}$/i.test(rawContentHash)
    )
      throw new Error(`Applied source page provenance is invalid: ${page.targetPath}`);
    records[externalId] = { rawContentHash, sourceModifiedAt };
  }
  return {
    generation: checkpoint.generation,
    sourceRevision: checkpoint.sourceRevision,
    records,
  };
}

function renderedFrontmatterString(rendered: string, key: string) {
  if (!rendered.startsWith("---\n")) throw new Error("Applied source page has no frontmatter");
  const end = rendered.indexOf("\n---\n", 4);
  if (end === -1) throw new Error("Applied source page has invalid frontmatter");
  const match = rendered.slice(4, end).match(new RegExp(`^${key}: (.+)$`, "m"));
  if (!match) throw new Error(`Applied source page is missing ${key}`);
  const value = JSON.parse(match[1]!) as unknown;
  if (typeof value !== "string") throw new Error(`Applied source page has invalid ${key}`);
  return value;
}

function assertSafeRelativePath(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`unsafe path in bundle: ${path}`);
  }
}

function validateOwnedCheckpointPage(
  repo: string,
  page: Pick<BundlePage, "externalId" | "targetPath" | "contentHash">,
  profile: AdapterProfile,
) {
  assertSafeRelativePath(page.targetPath);
  if (!page.targetPath.startsWith(profile.pathPrefix))
    throw new Error(
      `Checkpoint path is outside the ${profile.displayName} adapter prefix: ${page.targetPath}`,
    );
  if (!page.externalId || !/^[a-f0-9]{64}$/i.test(page.contentHash))
    throw new Error(`Invalid checkpoint receipt for ${page.targetPath}`);
  assertNoSymlinkComponents(repo, page.targetPath);
}

function adapterProfileFor(key: string) {
  const profile = adapterProfiles[key];
  if (!profile) throw new Error(`Unsupported knowledge adapter: ${key}`);
  return profile;
}

function assertNoSymlinkComponents(root: string, relativePath: string) {
  let current = root;
  for (const part of relativePath.split("/")) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error(`Symlinked repository path is not allowed: ${relativePath}`);
  }
}

function parseEvaluationReport(
  stdout: string,
  expectedQuestions: number,
): ApplyResult["evaluation"] {
  const payload = JSON.parse(stdout) as {
    report?: {
      total?: unknown;
      families?: Array<{
        n?: unknown;
        hit_at_1?: unknown;
        hit_at_3?: unknown;
        mrr?: unknown;
        recall_at_10?: unknown;
      }>;
    };
    gate?: { pass?: unknown; warnings?: unknown[]; breaches?: unknown[] };
  };
  if (
    payload.report?.total !== expectedQuestions ||
    payload.gate?.pass !== true ||
    !Array.isArray(payload.report.families) ||
    (payload.gate.breaches?.length ?? 0) > 0
  )
    throw new Error("GBrain retrieval evaluation returned an invalid or failing report");
  const weighted = (key: "hit_at_1" | "hit_at_3" | "mrr" | "recall_at_10") => {
    const total = payload.report!.families!.reduce((sum, family) => {
      const count = Number(family.n);
      const value = Number(family[key]);
      if (!Number.isFinite(count) || !Number.isFinite(value))
        throw new Error("GBrain retrieval evaluation contains invalid metrics");
      return sum + count * value;
    }, 0);
    return total / expectedQuestions;
  };
  return {
    status: "passed",
    questions: expectedQuestions,
    hitAt1: weighted("hit_at_1"),
    hitAt3: weighted("hit_at_3"),
    mrr: weighted("mrr"),
    recallAt10: weighted("recall_at_10"),
    warnings: payload.gate.warnings?.length ?? 0,
  };
}

async function checked(run: CommandRunner, command: string, args: string[], cwd?: string) {
  const result = await run(command, args, { cwd });
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.slice(-1000)}`);
  return result;
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<CommandResult> {
  const process = Bun.spawn([command, ...args], {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

type ReportedRun = { config: ReporterConfig; attemptId?: string; alreadyCompleted: boolean };
type ReporterConfig = { baseUrl: string; token: string };

async function startReportedRun(
  manifest: KnowledgeBundleManifest,
): Promise<ReportedRun | undefined> {
  const config = reporterConfig();
  if (!config) return undefined;
  const profile = adapterProfileFor(manifest.adapterKey);
  const origin = `gbrain-ingestion:${manifest.adapterKey}:${manifest.runId}`;
  const existingResponse = await getJson(config, "/api/work-items");
  const workItems = Array.isArray(existingResponse.workItems)
    ? (existingResponse.workItems as Array<Record<string, unknown>>)
    : [];
  const completed = workItems.find((work) => work.origin === origin && work.status === "completed");
  if (completed) return { config, alreadyCompleted: true };
  const running = workItems.find((work) => work.origin === origin && work.status === "running");
  let work = running;
  if (!work) {
    work = await postJson(config, "/api/work-items", {
      title: `Refresh ${profile.displayName} knowledge in GBrain`,
      intent: `Apply a verified ${profile.displayName} snapshot to the ${profile.gbrainSourceId} GBrain source.`,
      kind: "tool_execution",
      status: "running",
      priority: "low",
      visibility: "hidden",
      notificationPolicy: "none",
      origin,
    });
  }
  const attemptsResponse = await getJson(
    config,
    `/api/work-attempts?workItemId=${encodeURIComponent(String(work.id))}`,
  );
  const attempts = Array.isArray(attemptsResponse.attempts)
    ? (attemptsResponse.attempts as Array<Record<string, unknown>>)
    : [];
  const runningAttempt = attempts.find((attempt) => attempt.status === "running");
  if (runningAttempt)
    return { config, attemptId: String(runningAttempt.id), alreadyCompleted: false };
  const attempt = await postJson(config, "/api/work-attempts", {
    workItemId: String(work.id),
    executor: "provider_adapter",
    interface: "system",
    intent: `Apply and synchronize a complete ${profile.displayName} snapshot.`,
    sourceId: manifest.adapterKey,
  });
  return { config, attemptId: String(attempt.id), alreadyCompleted: false };
}

async function completeReportedRun(
  report: ReportedRun | undefined,
  outcome: { status: "succeeded"; result: ApplyResult } | { status: "failed"; error: string },
) {
  if (!report || report.alreadyCompleted || !report.attemptId) return;
  await postJson(
    report.config,
    `/api/work-attempts/${encodeURIComponent(report.attemptId)}/complete`,
    outcome,
  );
}

async function reportHealthSignal(
  adapter: string,
  status: "ok" | "failed",
  evidence: Record<string, unknown>,
) {
  const config = reporterConfig();
  if (!config) return;
  const profile = adapterProfileFor(adapter);
  const hour = new Date().toISOString().slice(0, 13);
  await postJson(config, "/api/health-signals", {
    idempotencyKey: `bender-gbrain-ingestion:${adapter}:${status}:${hour}`,
    correlationKey: `bender-gbrain-ingestion:${adapter}`,
    source: "bender-gbrain-ingestion",
    component: adapter,
    signalType: "gbrain_ingestion_run",
    status,
    severity: status === "ok" ? "info" : "warning",
    summary:
      status === "ok"
        ? `${profile.displayName} knowledge was synchronized to GBrain.`
        : `${profile.displayName} knowledge synchronization failed.`,
    evidence,
    codeFixable: false,
    requiresAction: false,
    suspectedOwner: "bender-gbrain",
    verificationCommand:
      adapter === "gmail-threads"
        ? "systemctl --user status bender-gbrain-gmail-import.service"
        : "systemctl --user status bender-gbrain-seafile-import.service",
    observedAt: new Date().toISOString(),
  });
}

function reporterConfig() {
  const baseUrl = process.env.PLANET_EXPRESS_URL?.replace(/\/$/, "");
  const token = process.env.PLANET_EXPRESS_TOKEN;
  return baseUrl && token ? { baseUrl, token } : undefined;
}

async function getJson(config: ReporterConfig, path: string) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Planet Express ${path} failed with ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

async function postJson(config: ReporterConfig, path: string, body: unknown) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Planet Express ${path} failed with ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function parseFlags(args: string[]) {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value)
      throw new Error(`Invalid argument near ${name ?? "end"}`);
    flags[name.slice(2)] = value;
  }
  return flags;
}

function requiredFlag(flags: Record<string, string>, name: string) {
  const value = flags[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

function portablePath(value: string) {
  return sep === "/" ? value : value.split(sep).join("/");
}

function comparePath(left: { relativePath: string }, right: { relativePath: string }) {
  return left.relativePath.localeCompare(right.relativePath);
}

function outputJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function sanitizeError(value: string) {
  return value.replace(/\/Users\/[^/]+/g, "/Users/<redacted>").slice(0, 500);
}
