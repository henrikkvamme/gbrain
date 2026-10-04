import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const maxFiles = 100_000;
const maxBytes = 2 * 1024 * 1024 * 1024;
const requestTimeoutMs = 30_000;

type Fetch = typeof fetch;

type SeafileDirent = {
  type: "file" | "dir";
  parent_dir: string;
  id: string;
  name: string;
  mtime: string;
  size?: number;
};

type SnapshotFile = {
  relativePath: string;
  id: string;
  modifiedAt: Date;
  size: number;
};

export type SeafileVaultSnapshot = {
  sourceRevision: string;
  files: number;
  bytes: number;
  vaultPath: string;
};

export async function mirrorSeafileVault(
  options: { baseUrl: string; repoToken: string; destination: string },
  dependencies: { fetch?: Fetch } = {},
): Promise<SeafileVaultSnapshot> {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const baseUrl = validatedBaseUrl(options.baseUrl);
  if (!options.repoToken.trim()) throw new Error("Seafile repo token is required");
  const destination = resolve(options.destination);
  const snapshots = join(destination, ".snapshots");
  const temporary = join(snapshots, `.tmp-${process.pid}-${randomUUID()}`);
  const current = join(destination, "current");
  const next = join(destination, `.current-${process.pid}-${randomUUID()}`);
  mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  rmSync(temporary, { recursive: true, force: true });

  try {
    const initialFiles = await listVisibleMarkdown(baseUrl, options.repoToken, fetch);
    const sourceRevision = listingRevision(initialFiles);
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    let bytes = 0;

    for (const file of initialFiles) {
      const downloadLink = await requestDownloadLink(
        baseUrl,
        options.repoToken,
        file.relativePath,
        fetch,
      );
      const content = await downloadSameOrigin(downloadLink, baseUrl.origin, fetch);
      if (content.byteLength !== file.size)
        throw new Error(`Seafile file size changed during snapshot: ${file.relativePath}`);
      bytes += content.byteLength;
      if (bytes > maxBytes) throw new Error(`Seafile snapshot exceeds ${maxBytes} bytes`);
      const target = join(temporary, file.relativePath);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { mode: 0o600 });
      utimesSync(target, file.modifiedAt, file.modifiedAt);
    }

    const finalFiles = await listVisibleMarkdown(baseUrl, options.repoToken, fetch);
    if (listingRevision(finalFiles) !== sourceRevision)
      throw new Error("Seafile library changed during snapshot; retry the complete snapshot");

    const version = join(snapshots, sourceRevision);
    if (existsSync(version)) rmSync(temporary, { recursive: true, force: true });
    else renameSync(temporary, version);

    symlinkSync(join(".snapshots", sourceRevision), next);
    renameSync(next, current);
    for (const entry of readdirSync(snapshots)) {
      if (entry !== sourceRevision && !entry.startsWith(".tmp-"))
        rmSync(join(snapshots, entry), { recursive: true, force: true });
    }
    return { sourceRevision, files: initialFiles.length, bytes, vaultPath: current };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(next, { force: true });
  }
}

async function listVisibleMarkdown(baseUrl: URL, repoToken: string, fetch: Fetch) {
  const url = new URL("/api/v2.1/via-repo-token/dir/", baseUrl);
  url.searchParams.set("path", "/");
  url.searchParams.set("recursive", "1");
  const response = await authenticatedJson(url, repoToken, fetch);
  const dirents = (response as { dirent_list?: unknown }).dirent_list;
  if (!Array.isArray(dirents)) throw new Error("Seafile directory response is invalid");
  if (dirents.length > maxFiles) throw new Error(`Seafile listing exceeds ${maxFiles} entries`);
  const files: SnapshotFile[] = [];
  const paths = new Set<string>();
  for (const value of dirents) {
    if (!value || typeof value !== "object") throw new Error("Seafile directory entry is invalid");
    const entry = value as Partial<SeafileDirent>;
    if (entry.type !== "file") continue;
    const relativePath = relativePathFor(entry.parent_dir, entry.name);
    if (
      relativePath.split("/").some((part) => part.startsWith(".")) ||
      !relativePath.toLowerCase().endsWith(".md")
    )
      continue;
    if (paths.has(relativePath)) throw new Error(`Duplicate Seafile path: ${relativePath}`);
    paths.add(relativePath);
    if (typeof entry.id !== "string" || !/^[a-f0-9]{40}$/i.test(entry.id))
      throw new Error(`Seafile file ID is invalid: ${relativePath}`);
    if (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0)
      throw new Error(`Seafile file size is invalid: ${relativePath}`);
    if (typeof entry.mtime !== "string")
      throw new Error(`Seafile file modification time is invalid: ${relativePath}`);
    const modifiedAt = new Date(entry.mtime);
    if (Number.isNaN(modifiedAt.getTime()))
      throw new Error(`Seafile file modification time is invalid: ${relativePath}`);
    files.push({ relativePath, id: entry.id, modifiedAt, size: Number(entry.size) });
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > maxBytes) throw new Error(`Seafile snapshot exceeds ${maxBytes} bytes`);
  return files;
}

async function requestDownloadLink(
  baseUrl: URL,
  repoToken: string,
  relativePath: string,
  fetch: Fetch,
) {
  const url = new URL("/api/v2.1/via-repo-token/download-link/", baseUrl);
  url.searchParams.set("path", `/${relativePath}`);
  const value = await authenticatedJson(url, repoToken, fetch);
  if (typeof value !== "string") throw new Error("Seafile download-link response is invalid");
  const download = new URL(value, baseUrl);
  assertSameOrigin(download, baseUrl.origin);
  return download;
}

async function authenticatedJson(url: URL, repoToken: string, fetch: Fetch) {
  const response = await fetch(url, {
    headers: { accept: "application/json", authorization: `Bearer ${repoToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`Seafile request failed with status ${response.status}`);
  return (await response.json()) as unknown;
}

async function downloadSameOrigin(initialUrl: URL, origin: string, fetch: Fetch) {
  let url = initialUrl;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    assertSameOrigin(url, origin);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Seafile download redirect is missing a location");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`Seafile download failed with status ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("Seafile download exceeded the redirect limit");
}

function validatedBaseUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error("Seafile base URL must be an HTTPS origin");
  url.pathname = "/";
  return url;
}

function relativePathFor(parent: unknown, name: unknown) {
  if (typeof parent !== "string" || typeof name !== "string")
    throw new Error("Seafile path is invalid");
  const normalizedParent = parent.replace(/^\/+|\/+$/g, "");
  const relativePath = normalizedParent ? `${normalizedParent}/${name}` : name;
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Seafile path is unsafe");
  return relativePath;
}

function assertSameOrigin(url: URL, origin: string) {
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password)
    throw new Error("Seafile download link is outside the Seafile origin");
}

function listingRevision(files: SnapshotFile[]) {
  return createHash("sha256")
    .update(
      files
        .map(
          ({ relativePath, id, modifiedAt, size }) =>
            `${relativePath}\0${id}\0${modifiedAt.toISOString()}\0${size}`,
        )
        .join("\n"),
    )
    .digest("hex");
}
