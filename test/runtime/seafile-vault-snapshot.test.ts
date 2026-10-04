import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorSeafileVault } from "../../deploy/runtime/ingestion/seafile-vault-snapshot";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(name: string) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

const plan = Buffer.from("# Plan\n\nUse the Seafile snapshot adapter.\n");
const entries = [
  {
    type: "file",
    parent_dir: "/Projects",
    id: "a".repeat(40),
    name: "Plan.md",
    mtime: "2026-07-20T16:00:00+02:00",
    size: plan.byteLength,
  },
  {
    type: "file",
    parent_dir: "/.obsidian",
    id: "b".repeat(40),
    name: "private.md",
    mtime: "2026-07-20T16:00:00+02:00",
    size: 20,
  },
  {
    type: "file",
    parent_dir: "/Attachments",
    id: "c".repeat(40),
    name: "diagram.pdf",
    mtime: "2026-07-20T16:00:00+02:00",
    size: 100,
  },
];

describe("Seafile vault snapshot", () => {
  test("atomically mirrors only visible Markdown through a scoped repo token", async () => {
    const destination = temporaryRoot("seafile-vault");
    writeFileSync(join(destination, "stale.md"), "stale\n");
    const requests: Array<{ url: string; authorization: string | null }> = [];

    const result = await mirrorSeafileVault(
      {
        baseUrl: "https://seafile.example.test",
        repoToken: "repo-secret",
        destination,
      },
      {
        fetch: fakeFetch(requests, () => entries),
      },
    );

    expect(result).toMatchObject({ files: 1, bytes: plan.byteLength });
    expect(result.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.vaultPath).toBe(join(destination, "current"));
    expect(lstatSync(result.vaultPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(result.vaultPath)).toBe(join(".snapshots", result.sourceRevision));
    expect(readFileSync(join(result.vaultPath, "Projects/Plan.md"), "utf8")).toBe(
      plan.toString(),
    );
    expect(existsSync(join(result.vaultPath, "stale.md"))).toBe(false);
    expect(existsSync(join(result.vaultPath, ".obsidian/private.md"))).toBe(false);
    expect(existsSync(join(result.vaultPath, "Attachments/diagram.pdf"))).toBe(false);
    expect(statSync(join(result.vaultPath, "Projects/Plan.md")).mtime.toISOString()).toBe(
      "2026-07-20T14:00:00.000Z",
    );
    expect(requests.filter(({ url }) => url.includes("/download/"))).toEqual([
      { url: "https://seafile.example.test/download/Plan.md", authorization: null },
    ]);
    expect(
      requests
        .filter(({ url }) => url.includes("/api/v2.1/via-repo-token/"))
        .every(({ authorization }) => authorization === "Bearer repo-secret"),
    ).toBe(true);
  });

  test("keeps the prior snapshot when Seafile changes during download", async () => {
    const destination = temporaryRoot("seafile-vault");
    writeFileSync(join(destination, "existing.md"), "keep me\n");
    let listCount = 0;
    const changedEntries = () => {
      listCount += 1;
      return listCount === 1 ? entries : [{ ...entries[0]!, id: "d".repeat(40) }];
    };

    await expect(
      mirrorSeafileVault(
        {
          baseUrl: "https://seafile.example.test",
          repoToken: "repo-secret",
          destination,
        },
        { fetch: fakeFetch([], changedEntries) },
      ),
    ).rejects.toThrow("changed during snapshot");

    expect(readFileSync(join(destination, "existing.md"), "utf8")).toBe("keep me\n");
    expect(existsSync(join(destination, "Projects/Plan.md"))).toBe(false);
  });

  test("rejects download links outside the configured Seafile origin", async () => {
    const destination = temporaryRoot("seafile-vault");
    writeFileSync(join(destination, "existing.md"), "keep me\n");

    await expect(
      mirrorSeafileVault(
        {
          baseUrl: "https://seafile.example.test",
          repoToken: "repo-secret",
          destination,
        },
        {
          fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith("/dir/"))
              return Response.json({ dirent_list: [entries[0]] });
            if (url.pathname.endsWith("/download-link/"))
              return Response.json("https://attacker.example/download/Plan.md");
            return fakeFetch([], () => entries)(input, init);
          }) as typeof fetch,
        },
      ),
    ).rejects.toThrow("outside the Seafile origin");

    expect(readFileSync(join(destination, "existing.md"), "utf8")).toBe("keep me\n");
  });
});

function fakeFetch(
  requests: Array<{ url: string; authorization: string | null }>,
  listEntries: () => typeof entries,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ url: url.toString(), authorization });
    if (url.pathname.endsWith("/dir/")) return Response.json({ dirent_list: listEntries() });
    if (url.pathname.endsWith("/download-link/"))
      return Response.json("https://seafile.example.test/download/Plan.md");
    if (url.pathname === "/download/Plan.md") return new Response(plan);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
