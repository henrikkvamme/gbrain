#!/usr/bin/env python3
"""Probe an imported image with synthetic inventory only, never inference."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import uuid


def run(*args):
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.PIPE, timeout=45)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="image ID from image.py, already docker-loaded")
    parser.add_argument("--probe-image", required=True, help="existing isolated Bun fixture image; never installed in runtime")
    args = parser.parse_args()
    name = "ollama-fixture-" + uuid.uuid4().hex[:12]
    pin_bytes = (Path(__file__).resolve().parents[2] / "deploy/runtime/ollama/closure.json").read_bytes()
    pin = json.loads(pin_bytes)
    config = json.loads(run("image", "inspect", args.image))[0]
    assert config["Architecture"] == "amd64"
    assert config["Config"]["User"] == "1001:1001"
    assert config["Config"]["Entrypoint"] == ["/bin/ollama"]
    assert config["Config"]["Cmd"] == ["serve"]
    assert config["Config"]["Labels"]["runtime.ollama.closure.sha256"] == hashlib.sha256(pin_bytes).hexdigest()
    with tempfile.TemporaryDirectory(prefix="ollama-fixture-") as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        models = root / "models"
        blobs = models / "blobs"
        blobs.mkdir(parents=True)
        def blob(data):
            digest = hashlib.sha256(data).hexdigest()
            (blobs / ("sha256-" + digest)).write_bytes(data)
            return "sha256:" + digest
        config_bytes = json.dumps({"model_format": "gguf", "model_family": "fixture",
                                  "model_families": ["fixture"], "model_type": "fixture",
                                  "file_type": "Q4_0"}).encode()
        model_bytes = b"Synthetic inventory only. This is not an inference model."
        manifest_bytes = json.dumps({"schemaVersion": 2,
            "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
            "config": {"mediaType": "application/vnd.docker.container.image.v1+json",
                       "digest": blob(config_bytes), "size": len(config_bytes)},
            "layers": [{"mediaType": "application/vnd.ollama.image.model",
                        "digest": blob(model_bytes), "size": len(model_bytes)}]}).encode()
        manifest = models / "manifests/registry.ollama.ai/library/fixture/latest"
        manifest.parent.mkdir(parents=True)
        manifest.write_bytes(manifest_bytes)
        before = {str(path.relative_to(models)): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in models.rglob("*") if path.is_file()}
        try:
            run("run", "-d", "--pull", "never", "--platform", "linux/amd64", "--name", name, "--network", "none",
                "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--pids-limit", "128", "--memory", "512m", "--cpus", "1",
                "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
                "--mount", f"type=bind,src={models},dst=/models,readonly", args.image)
            probe = """
let version;
for(let i=0;i<80;i++) {
  try {const r=await fetch('http://127.0.0.1:11434/api/version'); if(r.ok){version=await r.json();break;}}catch{}
  await Bun.sleep(250);
}
if(!version) throw new Error('Ollama did not start');
const tags=await fetch('http://127.0.0.1:11434/api/tags').then(r=>r.json());
console.log(JSON.stringify({version:version.version,models:tags.models}));
"""
            observed = json.loads(run("run", "--rm", "--pull", "never", "--network", "container:" + name,
                "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--pids-limit", "64", "--memory", "256m", "--cpus", "1",
                "--entrypoint", "bun", args.probe_image, "--no-env-file", "-e", probe))
            assert observed["version"] == pin["version"], observed
            assert len(observed["models"]) == 1, observed
            assert observed["models"][0]["name"] == "fixture:latest", observed
            assert observed["models"][0]["digest"] == hashlib.sha256(manifest_bytes).hexdigest(), observed
            assert pin["version"] in run("exec", name, "/bin/ollama", "--version")
            provenance_file = root / "provenance.json"
            run("cp", name + ":/etc/ollama-runtime/provenance.json", str(provenance_file))
            provenance = json.loads(provenance_file.read_bytes())
            assert provenance["closure"] == pin
            assert provenance["closureSha256"] == hashlib.sha256(pin_bytes).hexdigest()
            source = Path(__file__).resolve().parents[2] / "deploy/runtime/ollama"
            for field, filename, label in [
                ("packagerSha256", "image.py", "runtime.ollama.packager.sha256"),
                ("declarationSha256", "closure.nix", "runtime.ollama.declaration.sha256"),
            ]:
                digest = hashlib.sha256((source / filename).read_bytes()).hexdigest()
                assert provenance[field] == digest
                assert config["Config"]["Labels"][label] == digest
            runtime = json.loads(run("inspect", name))[0]
            assert runtime["HostConfig"]["ReadonlyRootfs"]
            assert runtime["HostConfig"]["NetworkMode"] == "none"
            assert runtime["HostConfig"]["PortBindings"] in (None, {})
            assert [(m["Destination"], m["RW"]) for m in runtime["Mounts"] if m["Type"] == "bind"] == [("/models", False)]
            after = {str(path.relative_to(models)): hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in models.rglob("*") if path.is_file()}
            assert after == before
            # Shutdown must drain the real serve process rather than leaving a
            # helper or requiring forced removal. Docker has no shell in image.
            run("stop", "--time", "10", name)
            stopped = json.loads(run("inspect", name))[0]
            assert stopped["State"]["ExitCode"] == 0, stopped["State"]
            print(json.dumps({"version": observed["version"], "syntheticModels": 1,
                "modelBytesUnchanged": True, "nonroot": True, "readOnly": True,
                "hostStoreMounts": 0, "network": "none", "inferenceCalled": False,
                "provenanceVerified": True, "cleanShutdown": True}))
        finally:
            subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30)


if __name__ == "__main__":
    main()
