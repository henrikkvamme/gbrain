import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyKnowledgeBundle,
  prepareObsidianBundle,
  previewObsidian,
  type CommandRunner,
} from "../../deploy/runtime/ingestion/gbrain-ingestion";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(name: string) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function note(root: string, path: string, content: string, modifiedAt = new Date("2026-07-16T12:00:00Z")) {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
  utimesSync(target, modifiedAt, modifiedAt);
}

describe("Obsidian bundle preparation", () => {
  test("selects useful recent notes and explains every rejection", async () => {
    const vault = temporaryRoot("obsidian-vault");
    note(vault, "Projects/Widget.md", "# Widget\n\nUse lifecycle-based GBrain sources.\n");
    note(vault, "Old.md", "# Old\n\nHistorical note.\n", new Date("2024-01-01T00:00:00Z"));
    note(vault, "Empty.md", "  \n");
    note(vault, "Sketch.excalidraw.md", "# Drawing\n\nGenerated canvas data.\n");
    note(vault, ".obsidian/workspace.md", "# Internal\n\nPlugin state.\n");
    note(vault, "99 System/Templates/Project.md", "# Template\n\nSystem machinery.\n");
    note(
      vault,
      "99 System/Guidance/GBrain Operations.md",
      "---\ngbrain: include\n---\n# GBrain Operations\n\nUseful operating guidance.\n",
    );
    note(vault, "10 Inbox/Agent Inbox/Draft.md", "# Draft\n\nPending agent review.\n");
    note(vault, "10 Inbox/Capture/Loose.md", "# Loose\n\nUnreviewed capture.\n");
    note(vault, "Secret.md", "# Token\n\napi_key = super-secret-value-123456789\n");

    const preview = await previewObsidian({ vault, since: "2025-07-17T00:00:00Z" });

    expect(preview.selected.map((record) => record.relativePath)).toEqual([
      "99 System/Guidance/GBrain Operations.md",
      "Projects/Widget.md",
    ]);
    expect(preview.rejected.map((record) => record.reason).sort()).toEqual([
      "agent_inbox",
      "credential_like_text",
      "empty_or_tiny",
      "generated_excalidraw",
      "hidden_path",
      "inbox_path",
      "older_than_since",
      "system_path",
    ]);
  });

  test("keeps Inbox behind review even when a note requests GBrain inclusion", async () => {
    const vault = temporaryRoot("obsidian-vault");
    note(
      vault,
      "10 Inbox/Agent Inbox/Draft.md",
      "---\ngbrain: include\n---\n# Draft\n\nPending agent review.\n",
    );

    const preview = await previewObsidian({ vault });

    expect(preview.selected).toEqual([]);
    expect(preview.rejected).toMatchObject([
      { relativePath: "10 Inbox/Agent Inbox/Draft.md", reason: "agent_inbox" },
    ]);
  });

  test("requires the System opt-in to be an explicit top-level frontmatter property", async () => {
    const vault = temporaryRoot("obsidian-vault");
    note(
      vault,
      "99 System/Guidance/Windows Runbook.md",
      "---\r\ngbrain: include\r\n---\r\n# Windows Runbook\r\n\r\nUseful operating guidance.\r\n",
    );
    note(
      vault,
      "99 System/Templates/Nested.md",
      "---\ndescription: |\n  gbrain: include\n---\n# Nested\n\nSystem machinery.\n",
    );
    note(
      vault,
      "99 System/Templates/Malformed.md",
      "---\ngbrain: include\n# Malformed\n\nMissing the closing delimiter.\n",
    );

    const preview = await previewObsidian({ vault });

    expect(preview.selected.map((record) => record.relativePath)).toEqual([
      "99 System/Guidance/Windows Runbook.md",
    ]);
    expect(preview.rejected).toMatchObject([
      { relativePath: "99 System/Templates/Malformed.md", reason: "system_path" },
      { relativePath: "99 System/Templates/Nested.md", reason: "system_path" },
    ]);
  });

  test("renders deterministic provenance without exposing the local vault path", async () => {
    const vault = temporaryRoot("obsidian-vault");
    const bundle = temporaryRoot("gbrain-bundle");
    const state = join(temporaryRoot("gbrain-state"), "obsidian.json");
    note(vault, "Areas/Health.md", "---\ntags: [health]\n---\n# Health\n\nWalk after lunch.\n");

    const prepared = await prepareObsidianBundle({ vault, bundle, state });
    const page = readFileSync(join(bundle, prepared.manifest.pages[0]!.bundlePath), "utf8");

    expect(prepared.manifest.generation).toBe(1);
    expect(prepared.manifest.pages[0]!.targetPath).toMatch(/^obsidian\/[a-f0-9]{16}\.md$/);
    expect(page).toContain('source_system: "obsidian"');
    expect(page).toContain('type: "note"');
    expect(page).toContain('created: "2026-07-16T12:00:00.000Z"');
    expect(page).toContain('adapter_key: "obsidian-notes"');
    expect(page).toContain('source_uri: "obsidian://Areas/Health.md"');
    expect(page).toContain("# Health");
    expect(page).not.toContain(vault);

    const secondBundle = temporaryRoot("gbrain-bundle");
    const second = await prepareObsidianBundle({ vault, bundle: secondBundle, state });
    expect(second.manifest.generation).toBe(1);
    expect(second.manifest.sourceRevision).toBe(prepared.manifest.sourceRevision);
    expect(readFileSync(join(secondBundle, second.manifest.pages[0]!.bundlePath), "utf8")).toBe(page);

    utimesSync(join(vault, "Areas/Health.md"), new Date(), new Date());
    const touchedBundle = temporaryRoot("gbrain-bundle");
    const touched = await prepareObsidianBundle({ vault, bundle: touchedBundle, state });
    expect(touched.manifest.generation).toBe(1);
    expect(touched.manifest.sourceRevision).toBe(prepared.manifest.sourceRevision);
  });

  test("puts the canonical title in the indexed body exactly once", async () => {
    const vault = temporaryRoot("obsidian-vault");
    const bundle = temporaryRoot("gbrain-bundle");
    const state = join(temporaryRoot("gbrain-state"), "obsidian.json");
    note(vault, "Christmas card.md", "Remember to send this in December.\n");
    note(vault, "Health.md", "# Health\n\nWalk after lunch.\n");

    const prepared = await prepareObsidianBundle({ vault, bundle, state });
    const rendered = prepared.manifest.pages.map((page) =>
      readFileSync(join(bundle, page.bundlePath), "utf8"),
    );

    expect(rendered.find((page) => page.includes('title: "Christmas card"'))).toContain(
      "# Christmas card\n",
    );
    expect(rendered.find((page) => page.includes('title: "Health"'))?.match(/^# Health$/gm)).toHaveLength(1);
  });

  test("renders resolvable Obsidian wiki links as GBrain relationships", async () => {
    const vault = temporaryRoot("obsidian-vault");
    const bundle = temporaryRoot("gbrain-bundle");
    const state = join(temporaryRoot("gbrain-state"), "obsidian.json");
    note(vault, "Areas/Health.md", "# Health\n\nWalk after lunch.\n");
    note(
      vault,
      "Projects/Widget.md",
      "# Widget\n\nSee [[Areas/Health|health habits]], [[Missing]], and [[Widget]].\n",
    );

    const prepared = await prepareObsidianBundle({ vault, bundle, state });
    const health = prepared.manifest.pages.find((page) => page.externalId === "Areas/Health.md")!;
    const bender = prepared.manifest.pages.find((page) => page.externalId === "Projects/Widget.md")!;
    const rendered = readFileSync(join(bundle, bender.bundlePath), "utf8");

    expect(rendered).toContain(
      `related: ["indexes/source-index","${health.targetPath.replace(/\.md$/, "")}"]`,
    );
    expect(rendered).not.toContain(bender.targetPath.replace(/\.md$/, ""));
  });

  test("builds retrieval fixtures from normalized, distinctive title terms", async () => {
    const vault = temporaryRoot("obsidian-vault");
    const bundle = temporaryRoot("gbrain-bundle");
    const state = join(temporaryRoot("gbrain-state"), "obsidian.json");
    note(
      vault,
      "Refleksjonsnotat - Alice Example.md",
      "A personal reflection with a punctuation-heavy title.\n",
    );
    note(vault, "Should research.md", "A generic research reminder.\n");
    for (let index = 0; index < 29; index += 1) {
      note(
        vault,
        `DistinctiveToken${index}.md`,
        index < 3
          ? `Useful detail ${index}. This note says should research as ordinary body text.\n`
          : `Useful detail ${index} with unrelated authored context.\n`,
      );
    }

    await prepareObsidianBundle({ vault, bundle, state });
    const fixtures = readFileSync(join(bundle, "evaluation.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { query: string });

    expect(fixtures).toHaveLength(30);
    expect(fixtures.map(({ query }) => query)).toContain("Refleksjonsnotat Alice Example");
    expect(fixtures.map(({ query }) => query)).not.toContain("Should research");
  });

  test("recovers generation and source timestamps from the applied source repository", async () => {
    const vault = temporaryRoot("obsidian-vault");
    const bundle = temporaryRoot("gbrain-bundle");
    const state = join(temporaryRoot("gbrain-state"), "obsidian.json");
    note(vault, "Projects/Widget.md", "# Widget\n\nUse lifecycle-based GBrain sources.\n");
    const first = await prepareObsidianBundle({ vault, bundle, state });
    const repo = initializedRepo();
    await applyKnowledgeBundle(
      { bundle, repo, gbrainBin: "gbrain" },
      { run: recordingRunner([]) },
    );

    const serverVault = temporaryRoot("seafile-vault");
    note(
      serverVault,
      "Projects/Widget.md",
      "# Widget\n\nUse lifecycle-based GBrain sources.\n",
      new Date("2026-07-20T12:34:56Z"),
    );
    const recoveredState = join(temporaryRoot("recovered-state"), "obsidian.json");
    const recoveredBundle = temporaryRoot("recovered-bundle");

    const recovered = await prepareObsidianBundle({
      vault: serverVault,
      bundle: recoveredBundle,
      state: recoveredState,
      seedRepo: repo,
    });

    expect(recovered.manifest.generation).toBe(first.manifest.generation);
    expect(recovered.manifest.sourceRevision).toBe(first.manifest.sourceRevision);
    expect(recovered.manifest.pages[0]!.sourceModifiedAt).toBe(
      first.manifest.pages[0]!.sourceModifiedAt,
    );
  });
});

describe("GBrain bundle application", () => {
  test("commits pages, syncs embeddings, then reconciles frontmatter links", async () => {
    const { bundle } = await fixtureBundle();
    const repo = initializedRepo();
    const commands: string[][] = [];
    const runner = recordingRunner(commands);

    const result = await applyKnowledgeBundle({ bundle, repo, gbrainBin: "gbrain" }, { run: runner });

    expect(result).toMatchObject({
      discovered: 1,
      selected: 1,
      rejected: 0,
      created: 1,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      synced: true,
    });
    expect(readFileSync(join(repo, ".bender-ingestion/adapters/obsidian-notes.json"), "utf8")).toContain(
      '"generation": 1',
    );
    expect(commands.find((command) => command[1] === "sync")).toEqual([
      "gbrain",
      "sync",
      "--source",
      "bender-authored",
      "--dir",
      repo,
      "--no-extract",
    ]);
    expect(commands.find((command) => command[1] === "extract")).toEqual([
      "gbrain",
      "extract",
      "all",
      "--source",
      "db",
      "--source-id",
      "bender-authored",
      "--include-frontmatter",
    ]);
    expect(commands.at(-1)).toEqual([
      "gbrain",
      "eval",
      "retrieval-quality",
      join(bundle, "evaluation.jsonl"),
      "--json",
      "--source",
      "bender-authored",
    ]);
  });

  test("retries a generation whose files committed before sync failed", async () => {
    const { bundle } = await fixtureBundle();
    const repo = initializedRepo();
    const commands: string[][] = [];
    const recorder = recordingRunner(commands);
    const failing: CommandRunner = async (command, args, options) => {
      if (command === "gbrain" && args[0] === "sync") return { exitCode: 1, stdout: "", stderr: "fixture crash" };
      return recorder(command, args, options);
    };
    await expect(applyKnowledgeBundle({ bundle, repo, gbrainBin: "gbrain" }, { run: failing })).rejects.toThrow("fixture crash");
    const retry = await applyKnowledgeBundle({ bundle, repo, gbrainBin: "gbrain" }, { run: recorder });
    expect(retry.unchanged).toBe(1);
    expect(retry.committed).toBe(false);
    expect(retry.synced).toBe(true);
  });

  test("rejects bundle symlinks before running any consumer command", async () => {
    const { bundle } = await fixtureBundle();
    const repo = initializedRepo();
    const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
    const path = join(bundle, manifest.pages[0].bundlePath);
    const copy = join(temporaryRoot("external-content"), "page.md");
    writeFileSync(copy, readFileSync(path));
    rmSync(path);
    symlinkSync(copy, path);
    const commands: string[][] = [];
    await expect(applyKnowledgeBundle({ bundle, repo, gbrainBin: "gbrain" }, { run: recordingRunner(commands) })).rejects.toThrow();
    expect(commands).toHaveLength(0);
  });

  test("accepts an identical retry, rejects stale replacement, and still syncs retry", async () => {
    const { bundle, vault, state } = await fixtureBundle();
    const repo = initializedRepo();
    const commands: string[][] = [];
    const runner = recordingRunner(commands);
    await applyKnowledgeBundle({ bundle, repo, gbrainBin: "gbrain" }, { run: runner });

    const retry = await applyKnowledgeBundle({ bundle, repo, gbrainBin: "gbrain" }, { run: runner });
    expect(retry.unchanged).toBe(1);
    expect(retry.committed).toBe(false);
    expect(commands.filter((command) => command[1] === "sync")).toHaveLength(2);

    const nextRunBundle = temporaryRoot("next-run-bundle");
    await prepareObsidianBundle({ vault, bundle: nextRunBundle, state });
    const nextRun = await applyKnowledgeBundle(
      { bundle: nextRunBundle, repo, gbrainBin: "gbrain" },
      { run: runner },
    );
    expect(nextRun.committed).toBe(false);

    note(vault, "Note.md", "# Changed\n\nA replacement using a stale generation.\n");
    const staleBundle = temporaryRoot("stale-bundle");
    await prepareObsidianBundle({ vault, bundle: staleBundle, state });
    const manifestPath = join(staleBundle, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.generation = 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      applyKnowledgeBundle({ bundle: staleBundle, repo, gbrainBin: "gbrain" }, { run: runner }),
    ).rejects.toThrow("stale generation");
  });

  test("deletes only pages owned by the adapter", async () => {
    const { bundle, vault, state } = await fixtureBundle();
    const repo = initializedRepo();
    const runner = recordingRunner([]);
    await applyKnowledgeBundle({ bundle, repo, gbrainBin: "gbrain" }, { run: runner });
    mkdirSync(join(repo, "drive"), { recursive: true });
    writeFileSync(join(repo, "drive/keep.md"), "# Keep Drive\n");
    rmSync(join(vault, "Note.md"));
    const emptyBundle = temporaryRoot("empty-bundle");
    await prepareObsidianBundle({ vault, bundle: emptyBundle, state });

    const result = await applyKnowledgeBundle(
      { bundle: emptyBundle, repo, gbrainBin: "gbrain" },
      { run: runner },
    );

    expect(result.deleted).toBe(1);
    expect(Bun.file(join(repo, "drive/keep.md")).size).toBeGreaterThan(0);
  });

  test("rejects corrupt deletion ownership and locally modified pages before mutation", async () => {
    const { bundle, vault, state } = await fixtureBundle();
    const repo = initializedRepo();
    const runner = recordingRunner([]);
    await applyKnowledgeBundle({ bundle, repo, gbrainBin: "gbrain" }, { run: runner });
    const checkpointPath = join(repo, ".bender-ingestion/adapters/obsidian-notes.json");
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    const ownedPath = checkpoint.pages[0].targetPath;
    writeFileSync(join(repo, ownedPath), "# Local edit\n");
    rmSync(join(vault, "Note.md"));
    const emptyBundle = temporaryRoot("empty-bundle");
    await prepareObsidianBundle({ vault, bundle: emptyBundle, state });

    await expect(
      applyKnowledgeBundle({ bundle: emptyBundle, repo, gbrainBin: "gbrain" }, { run: runner }),
    ).rejects.toThrow("locally modified");

    checkpoint.pages[0].targetPath = "drive/other.md";
    writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    await expect(
      applyKnowledgeBundle({ bundle: emptyBundle, repo, gbrainBin: "gbrain" }, { run: runner }),
    ).rejects.toThrow("outside the Obsidian adapter prefix");
  });

  test("rejects path traversal and modified bundle content", async () => {
    const { bundle } = await fixtureBundle();
    const repo = initializedRepo();
    const manifestPath = join(bundle, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.pages[0].targetPath = "../escape.md";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(
      applyKnowledgeBundle({ bundle, repo, gbrainBin: "gbrain" }, { run: recordingRunner([]) }),
    ).rejects.toThrow("unsafe path");
  });

  test("validates the complete bundle before touching the repository", async () => {
    const vault = temporaryRoot("obsidian-vault");
    const bundle = temporaryRoot("gbrain-bundle");
    const state = join(temporaryRoot("gbrain-state"), "obsidian.json");
    note(vault, "One.md", "# One\n\nFirst useful note.\n");
    note(vault, "Two.md", "# Two\n\nSecond useful note.\n");
    const prepared = await prepareObsidianBundle({ vault, bundle, state });
    writeFileSync(join(bundle, prepared.manifest.pages[1]!.bundlePath), "tampered\n");
    const repo = initializedRepo();

    await expect(
      applyKnowledgeBundle({ bundle, repo, gbrainBin: "gbrain" }, { run: recordingRunner([]) }),
    ).rejects.toThrow("Bundle hash mismatch");

    expect(readdirSync(repo).sort()).toEqual([".git", "README.md"]);
  });
});

async function fixtureBundle() {
  const vault = temporaryRoot("obsidian-vault");
  const bundle = temporaryRoot("gbrain-bundle");
  const state = join(temporaryRoot("gbrain-state"), "obsidian.json");
  note(vault, "Note.md", "# Useful note\n\nA useful authored note.\n");
  await prepareObsidianBundle({ vault, bundle, state });
  return { bundle, vault, state };
}

function initializedRepo() {
  const repo = temporaryRoot("gbrain-repo");
  Bun.spawnSync(["git", "init", "--initial-branch=main", repo]);
  writeFileSync(join(repo, "README.md"), "# Brain\n");
  Bun.spawnSync(["git", "-C", repo, "add", "README.md"]);
  Bun.spawnSync([
    "git",
    "-C",
    repo,
    "-c",
    "user.name=Fixture importer",
    "-c",
    "user.email=importer@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Initialize",
  ]);
  return repo;
}

function recordingRunner(commands: string[][]): CommandRunner {
  return async (command, args, options) => {
    commands.push([command, ...args]);
    if (command === "gbrain") {
      const stdout =
        args[0] === "eval"
          ? JSON.stringify({
              report: {
                total: 1,
                families: [
                  {
                    n: 1,
                    hit_at_1: 1,
                    hit_at_3: 1,
                    mrr: 1,
                    recall_at_10: 1,
                  },
                ],
              },
              gate: { pass: true, warnings: [], breaches: [] },
            })
          : "{}";
      return { exitCode: 0, stdout, stderr: "" };
    }
    const result = Bun.spawnSync([command, ...args], { cwd: options?.cwd });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
}
