#!/usr/bin/env python3
"""Build a deterministic Docker archive from the pinned, already imported Nix closure."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
MIN_FREE = 5 * 1024**3


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def sha256_file(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def query(*args):
    return subprocess.check_output(["nix-store", *args], text=True, stderr=subprocess.PIPE,
                                   timeout=60).splitlines()


def verify(pin, store_path):
    if store_path != pin["storePath"]:
        raise ValueError("source path differs from the committed closure pin")
    entries = {entry["path"]: entry for entry in pin["closure"]}
    if set(query("--query", "--requisites", store_path)) != set(entries):
        raise ValueError("closure inventory differs from the committed pin")
    for path, entry in sorted(entries.items()):
        if sorted(query("--query", "--references", path)) != entry["references"]:
            raise ValueError("closure references differ from the committed pin")
        # Hash bytes, not the store database's remembered hash. Dumping a NAR
        # includes executable bits and symlink targets, independent of mtimes.
        with tempfile.TemporaryFile() as nar:
            subprocess.run(["nix-store", "--dump", path], stdout=nar,
                           stderr=subprocess.PIPE, check=True, timeout=60)
            size = nar.tell()
            nar.seek(0)
            digest = hashlib.file_digest(nar, "sha256").hexdigest()
        if size != entry["narBytes"] or digest != entry["narSha256"]:
            raise ValueError("closure NAR bytes differ from the committed pin")
    return entries


def add_bytes(archive, name, data, mode=0o444):
    info = tarfile.TarInfo(name)
    info.mode, info.size = mode, len(data)
    archive.addfile(info, io.BytesIO(data))


def normalized(info):
    # Store optimization may hardlink identical files across paths. Emit their
    # bytes independently so local deduplication cannot change the image hash.
    if info.islnk():
        info.type, info.linkname = tarfile.REGTYPE, ""
        info.size = Path("/" + info.name).stat().st_size
    if not (info.isfile() or info.isdir() or info.issym()):
        raise ValueError("unsupported file type in runtime closure")
    info.uid = info.gid = info.mtime = 0
    info.uname = info.gname = ""
    info.pax_headers = {}
    info.mode = 0o555 if info.isdir() or info.issym() or info.mode & 0o111 else 0o444
    return info


def write_layer(path, pin, provenance):
    with tarfile.open(path, "w", format=tarfile.GNU_FORMAT) as archive:
        for entry in pin["closure"]:
            archive.add(entry["path"], arcname=entry["path"].lstrip("/"), filter=normalized)
        for name in ["bin", "etc", "etc/ollama-runtime", "models", "tmp"]:
            info = tarfile.TarInfo(name)
            info.type = tarfile.DIRTYPE
            info.mode = 0o1777 if name == "tmp" else 0o755
            archive.addfile(info)
        info = tarfile.TarInfo("bin/ollama")
        info.type, info.linkname, info.mode = tarfile.SYMTYPE, pin["executable"], 0o555
        archive.addfile(info)
        add_bytes(archive, "etc/passwd", b"root:x:0:0:root:/tmp:/bin/false\nruntime:x:1001:1001:runtime:/tmp:/bin/false\n")
        add_bytes(archive, "etc/group", b"root:x:0:\nruntime:x:1001:\n")
        add_bytes(archive, "etc/ollama-runtime/provenance.json", canonical(provenance))


def build(output, store_path):
    pin_bytes = (HERE / "closure.json").read_bytes()
    pin = json.loads(pin_bytes)
    store_path = store_path or pin["storePath"]
    # Reject a wrong source before invoking Nix or touching the output.
    if store_path != pin["storePath"]:
        raise ValueError("source path differs from the committed closure pin")
    if output.exists():
        raise ValueError("output already exists; choose a fresh archive path")
    if not output.parent.is_dir():
        raise ValueError("output parent must be an existing directory")
    required = 3 * sum(entry["narBytes"] for entry in pin["closure"])
    if shutil.disk_usage(output.parent).free < MIN_FREE + required:
        raise ValueError("insufficient disk: packaging must leave at least 5 GiB free")
    verify(pin, store_path)
    provenance = {
        "closure": pin,
        "closureSha256": hashlib.sha256(pin_bytes).hexdigest(),
        "packagerSha256": sha256_file(HERE / "image.py"),
        "declarationSha256": sha256_file(HERE / "closure.nix"),
    }
    with tempfile.TemporaryDirectory(prefix="ollama-image-", dir=output.parent) as temporary:
        layer = Path(temporary) / "layer.tar"
        write_layer(layer, pin, provenance)
        layer_hash = sha256_file(layer)
        config = {
            "created": "1970-01-01T00:00:00Z", "architecture": "amd64", "os": "linux",
            "config": {
                "User": "1001:1001", "Entrypoint": ["/bin/ollama"], "Cmd": ["serve"],
                "Env": ["HOME=/tmp", "PATH=/bin", "OLLAMA_HOST=0.0.0.0:11434", "OLLAMA_MODELS=/models"],
                "Labels": {"org.opencontainers.image.title": "Ollama CPU runtime",
                           "org.opencontainers.image.version": pin["version"],
                           "org.opencontainers.image.source": "https://cache.nixos.org",
                           "runtime.ollama.closure.sha256": provenance["closureSha256"],
                           "runtime.ollama.packager.sha256": provenance["packagerSha256"],
                           "runtime.ollama.declaration.sha256": provenance["declarationSha256"]},
            },
            "rootfs": {"type": "layers", "diff_ids": ["sha256:" + layer_hash]},
            "history": [{"created": "1970-01-01T00:00:00Z", "created_by": "verified Nix closure"}],
        }
        config_bytes = canonical(config)
        image_hash = hashlib.sha256(config_bytes).hexdigest()
        config_name = image_hash + ".json"
        tag = "ollama-runtime:0.30.6-" + image_hash[:12]
        # Only the final rename exposes a complete, verified artifact.
        staged = Path(temporary) / "image.tar"
        with tarfile.open(staged, "w", format=tarfile.GNU_FORMAT) as archive:
            add_bytes(archive, config_name, config_bytes)
            add_bytes(archive, "manifest.json", canonical([{
                "Config": config_name, "RepoTags": [tag], "Layers": ["layer.tar"],
            }]))
            archive.add(layer, arcname="layer.tar", filter=normalized)
        archive_hash = sha256_file(staged)
        os.rename(staged, output)
    return {"image": "sha256:" + image_hash, "tag": tag, "archiveSha256": archive_hash,
            "closureSha256": provenance["closureSha256"], "bytes": output.stat().st_size}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print("error: " + message)
        print("help: run image.py --help")
        raise SystemExit(2)


def main():
    parser = Parser(description=__doc__, epilog="Example: python3 deploy/runtime/ollama/image.py --output /tmp/ollama.tar")
    parser.add_argument("-v", "-V", "--version", action="version", version="1")
    parser.add_argument("--output", required=True, type=Path, help="new Docker archive path (parent must exist)")
    parser.add_argument("--store-path", help="installed source path; must equal the committed pin")
    args = parser.parse_args()
    try:
        result = build(args.output, args.store_path)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        # Dependency diagnostics are captured, never echoed (they may contain
        # host state). Keep a next action suitable for an offline builder.
        detail = str(error) if isinstance(error, ValueError) else "closure packaging failed"
        print("error: " + detail)
        print("help: import closure.nix, verify disk space, then retry with a fresh --output")
        return 1
    for key, value in result.items():
        print(f"{key}: {value}")
    print("help: docker load --input " + str(args.output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
