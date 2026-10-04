# Pinned Ollama CPU image

This imports the exact Nix CPU runtime already accepted for the existing brain.
It preserves Ollama 0.30.6 at
`/nix/store/4nm6xwnkmwm8iipz8qcc505736n43ada-ollama-0.30.6`.
`closure.json` pins all ten runtime paths, their references, derivation identities,
actual SHA-256 NAR hashes and sizes (154,779,512 NAR bytes total). No moving
Ollama tag or nixpkgs revision is resolved. Importing the existing binary closure
avoids rebuilding Go/C++ or downloading the official GPU image.

`closure.nix` uses Nix's signed binary-cache import while preserving the existing
input-addressed store paths. See the [Nix fetchClosure contract](https://nix.dev/manual/nix/2.28/language/builtins.html#builtins-fetchClosure).
`image.py` additionally dumps and hashes the actual bytes of every path, checks
the complete closure and reference inventory, and rejects a different source
path before invoking dependencies. The build is offline after import. It never
runs Ollama, downloads models, opens a brain, or changes a service.

## Build and import

Prerequisites: Nix with `fetch-closure` support and the standard NixOS cache trust
key, Python 3.11+, and an existing output directory. Docker is needed only to
load and test the result. A Mac can import Linux store paths and package them
without executing the Linux binary. No remote builder or host configuration
change is required.

```sh
# Fetch signed runtime paths only. Skip this when the exact closure is installed.
nix eval --raw --impure \
  --extra-experimental-features 'nix-command fetch-closure' \
  --file deploy/runtime/ollama/closure.nix

mkdir -p .context/ollama
python3 deploy/runtime/ollama/image.py --output .context/ollama/image.tar
docker load --input .context/ollama/image.tar
```

The packager refuses to replace an existing output and leaves at least 5 GiB
free with room for its temporary NAR and two archive copies. Before importing
on a constrained host, separately budget about 155 MB for a missing closure,
the roughly 156 MB archive, and Docker's extracted layer. It performs no garbage
collection or Docker pruning. Root owns disk budgeting alongside other builds.

The output reports the archive SHA-256, Docker image ID, deterministic local tag,
closure pin SHA-256 and archive size. Identical source files and closure bytes
produce identical archive bytes: tar metadata, JSON, timestamps, ownership and
ordering are normalized. The archive uses Docker's single-layer import format.
The image ID is the config hash, **not a registry manifest digest**.

## Runtime contract and provenance

The image contains the exact runtime closure, an image-owned `/bin/ollama`
symlink entrypoint, minimal account files and
`/etc/ollama-runtime/provenance.json`. Provenance records the complete pinned
closure plus hashes of `closure.json`, `closure.nix` and `image.py`; image labels
carry the same hashes and runtime version. It contains no Nix daemon/database,
development checkout, build toolchain, agent credentials, models or host-store
mount dependency. Nix's runtime libraries remain at their original paths inside
the layer. Ollama itself is PID 1 and receives stop signals directly.

Defaults are UID/GID 1001:1001, `HOME=/tmp`, `OLLAMA_MODELS=/models` and
`OLLAMA_HOST=0.0.0.0:11434`. Compose overrides UID/GID with the existing storage
owner, mounts the existing model directory read-only, gives temporary runtime
state a bounded `/tmp` tmpfs, and uses a read-only root filesystem. Startup
creates ephemeral Ollama state in `/tmp`. No public port or inference health
probe is declared. The private brain runtime separately checks model inventory.
Do not mount `/nix`, an agent home or a host executable into this image.

Root must compare the installed source path, closure hashes, version, model
manifest/blob digests and ownership with the acceptance inventory before cutover.
After authorized registry publication, inspect the registry manifest digest and
set `OLLAMA_IMAGE=your-registry/ollama-runtime@sha256:<registry-manifest-digest>`.
Verify the pulled image's provenance and config ID against the build receipt.
Do not use the local image ID as a registry digest. Registry publication,
production model continuity, inference, deployment and rollback remain separate
root acceptance steps. Retain the existing store and model bytes until those
checks pass.

## Isolated verification

```sh
python3 -m unittest discover -s test/runtime -p ollama_image_test.py
# Supply the image ID printed by image.py and an existing Bun fixture image.
python3 tests/heavy/ollama-image-smoke.py \
  --image sha256:<image-config-id> --probe-image gbrain-runtime:task
```

The unit checks cover wrong source, extra closure paths/references, changed NAR
bytes, disk-budget rejection, existing-output protection, deterministic archive
bytes, provenance and strict flags. The smoke test runs the actual image under
bounded CPU/memory/PIDs with network disabled, nonroot ownership, read-only
root/model storage, and no host-store mount. A separate disposable Bun probe
shares its network namespace and requests only `/api/version` and `/api/tags`.
The synthetic inventory contains no usable inference model. It verifies exact
version, manifest digest, unchanged model bytes, declared provenance and graceful
shutdown; it removes only its own fixture container and directory. It never
calls inference, pulls a model or reads production data.
