"""Hermetic packaging checks; no host store, Docker, brain, or credentials."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "deploy/runtime/ollama/image.py"
spec = importlib.util.spec_from_file_location("ollama_image", SCRIPT)
image = importlib.util.module_from_spec(spec)
spec.loader.exec_module(image)


class ImageTests(unittest.TestCase):
    def test_source_rejection_precedes_dependency_and_output(self):
        with tempfile.TemporaryDirectory() as root, patch.object(image, "query") as query:
            output = Path(root) / "image.tar"
            with self.assertRaisesRegex(ValueError, "source path"):
                image.build(output, "/nix/store/wrong-source")
            query.assert_not_called()
            self.assertFalse(output.exists())

    def test_inventory_references_and_content_mismatch(self):
        path = "/nix/store/fixture"
        pin = {"storePath": path, "closure": [{"path": path, "references": [],
               "narSha256": hashlib.sha256(b"good").hexdigest(), "narBytes": 4}]}
        with patch.object(image, "query", return_value=["/nix/store/extra"]):
            with self.assertRaisesRegex(ValueError, "inventory"):
                image.verify(pin, path)
        with patch.object(image, "query", side_effect=[[path], ["/nix/store/extra"]]):
            with self.assertRaisesRegex(ValueError, "references"):
                image.verify(pin, path)
        def dump(args, stdout, **kwargs):
            stdout.write(b"evil")
        with patch.object(image, "query", side_effect=[[path], []]), patch.object(image.subprocess, "run", side_effect=dump):
            with self.assertRaisesRegex(ValueError, "NAR bytes"):
                image.verify(pin, path)

    def test_deterministic_archive_and_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = root / "fixture-store"
            store.mkdir()
            executable = store / "ollama"
            executable.write_bytes(b"fixture CPU runtime")
            executable.chmod(0o755)
            os.link(executable, store / "same-bytes")
            pin = {"storePath": str(store), "version": "0.30.6", "executable": str(executable),
                   "closure": [{"path": str(store), "narBytes": 20}]}
            (root / "closure.json").write_bytes(image.canonical(pin))
            (root / "image.py").write_bytes(SCRIPT.read_bytes())
            (root / "closure.nix").write_bytes(b"fixture declaration")
            with patch.object(image, "HERE", root), patch.object(image, "verify"):
                first = image.build(root / "first.tar", None)
                executable.touch()
                # Nix's optional store deduplication must not affect the image.
                (store / "same-bytes").unlink()
                (store / "same-bytes").write_bytes(executable.read_bytes())
                (store / "same-bytes").chmod(0o755)
                second = image.build(root / "second.tar", None)
            self.assertEqual(first["archiveSha256"], second["archiveSha256"])
            with tarfile.open(root / "first.tar") as archive:
                manifest = json.load(archive.extractfile("manifest.json"))[0]
                config = json.load(archive.extractfile(manifest["Config"]))
                layer_bytes = archive.extractfile("layer.tar").read()
                self.assertEqual(config["rootfs"]["diff_ids"], ["sha256:" + hashlib.sha256(layer_bytes).hexdigest()])
                self.assertEqual(config["config"]["User"], "1001:1001")
                self.assertEqual(config["config"]["Entrypoint"], ["/bin/ollama"])
                self.assertEqual(config["config"]["Cmd"], ["serve"])
                self.assertNotIn("Healthcheck", config["config"])
            with tarfile.open(fileobj=io.BytesIO(layer_bytes)) as layer:
                provenance = json.load(layer.extractfile("etc/ollama-runtime/provenance.json"))
                self.assertEqual(provenance["closure"], pin)
                self.assertEqual(provenance["packagerSha256"], hashlib.sha256(SCRIPT.read_bytes()).hexdigest())
                self.assertEqual(layer.getmember("bin/ollama").linkname, str(executable))
                self.assertEqual(layer.getmember(str(executable).lstrip("/")).mode, 0o555)
                self.assertTrue(all(member.uid == member.gid == member.mtime == 0 for member in layer))

    def test_disk_guard_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "image.tar"
            output.write_bytes(b"existing")
            with self.assertRaisesRegex(ValueError, "already exists"):
                image.build(output, None)
            self.assertEqual(output.read_bytes(), b"existing")
            output.unlink()
            with patch.object(image.shutil, "disk_usage", return_value=shutil_usage(0)):
                with self.assertRaisesRegex(ValueError, "5 GiB"):
                    image.build(output, None)
            self.assertFalse(output.exists())

    def test_unknown_flag_is_loud_and_version_is_bare(self):
        result = subprocess.run(["python3", str(SCRIPT), "--outpt", "ignored"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("error:", result.stdout)
        self.assertEqual(result.stderr, "")
        for flag in ["-v", "-V", "--version"]:
            result = subprocess.run(["python3", str(SCRIPT), flag], capture_output=True, text=True)
            self.assertEqual((result.returncode, result.stdout), (0, "1\n"))


def shutil_usage(free):
    from collections import namedtuple
    return namedtuple("usage", "total used free")(free, 0, free)


if __name__ == "__main__":
    unittest.main()
