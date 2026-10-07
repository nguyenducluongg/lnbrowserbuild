import hashlib
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from package_bundle import extract_engine, verify_engine, package, digest, TARGETS


def make_zip(path, entries):
    with zipfile.ZipFile(path, "x") as zipped:
        for name, data, mode in entries:
            entry = zipfile.ZipInfo(name)
            # Preserve deliberately malformed names instead of letting the
            # host's ZipInfo constructor normalize the negative fixture.
            entry.filename = name
            entry.orig_filename = name
            entry.create_system = 3
            entry.external_attr = mode << 16
            zipped.writestr(entry, data)


FILE = stat.S_IFREG | 0o755
LINK = stat.S_IFLNK | 0o777


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bundle-test-")
        self.root = Path(self.temp.name)
        self.archive = self.root / "input.zip"

    def tearDown(self):
        self.temp.cleanup()

    def test_files_metadata_and_hashes(self):
        make_zip(self.archive, [("Wayfern/chrome", b"engine", FILE),
                                ("__MACOSX/._Wayfern", b"metadata", stat.S_IFREG | 0o644)])
        engine = extract_engine(self.archive, self.root / "extract", "Wayfern")
        self.assertEqual((engine / "chrome").read_bytes(), b"engine")
        if os.name != "nt":
            self.assertEqual((engine / "chrome").stat().st_mode & 0o777, 0o755)
        self.assertFalse((self.root / "extract/__MACOSX").exists())
        slot = {"executable": "chrome", "integrity": [{"path": "chrome", "sha256": digest(engine / "chrome")}]}
        verify_engine(engine, slot)
        slot["integrity"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            verify_engine(engine, slot)

    def test_native_symlink_policy(self):
        make_zip(self.archive, [("Wayfern/chrome", b"engine", FILE), ("Wayfern/Current", b"chrome", LINK)])
        if os.name == "nt":
            # Windows engine ZIPs must contain real files, not Unix symlinks.
            with self.assertRaisesRegex(ValueError, "Unsupported archive symlink"):
                extract_engine(self.archive, self.root / "extract", "Wayfern")
        else:
            engine = extract_engine(self.archive, self.root / "extract", "Wayfern")
            self.assertTrue((engine / "Current").is_symlink())
            self.assertEqual((engine / "Current").read_bytes(), b"engine")

    def test_unsafe_archive_names(self):
        for index, name in enumerate(["../outside", "/Wayfern/file", "Wayfern/../bad", "Wayfern\\bad",
                                      "Wayfern/C:bad", "Wayfern//bad", "Other/file"]):
            archive = self.root / f"bad-{index}.zip"
            make_zip(archive, [(name, b"bad", FILE)])
            with self.subTest(name=name), self.assertRaises(ValueError):
                extract_engine(archive, self.root / f"extract-{index}", "Wayfern")
        self.assertFalse((self.root / "outside").exists())

    def test_raw_name_checked_before_windows_normalization(self):
        name = "Wayfern\\bad"
        make_zip(self.archive, [(name, b"bad", FILE)])
        with zipfile.ZipFile(self.archive) as zipped:
            self.assertEqual(zipped.infolist()[0].orig_filename, name)
        # Emulate just the ZipInfo reader's normalization, not the filesystem OS.
        class NormalizedZipInfo(zipfile.ZipInfo):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.filename = self.filename.replace("\\", "/")
        with patch("zipfile.ZipInfo", NormalizedZipInfo), self.assertRaisesRegex(ValueError, "Unsafe archive path"):
            extract_engine(self.archive, self.root / "extract", "Wayfern")

    def test_escaping_symlink(self):
        make_zip(self.archive, [("Wayfern/chrome", b"engine", FILE), ("Wayfern/link", b"../../outside", LINK)])
        expected = "Unsupported archive symlink" if os.name == "nt" else "escapes"
        with self.assertRaisesRegex(ValueError, expected):
            extract_engine(self.archive, self.root / "extract", "Wayfern")

    def test_duplicate_path(self):
        with self.assertWarns(UserWarning):
            make_zip(self.archive, [("Wayfern/chrome", b"one", FILE), ("Wayfern/chrome", b"two", FILE)])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            extract_engine(self.archive, self.root / "extract", "Wayfern")

    def test_special_file(self):
        make_zip(self.archive, [("Wayfern/fifo", b"", stat.S_IFIFO | 0o600)])
        with self.assertRaisesRegex(ValueError, "file type"):
            extract_engine(self.archive, self.root / "extract", "Wayfern")

    def test_expansion_limit(self):
        make_zip(self.archive, [("Wayfern/chrome", b"engine", FILE)])
        with patch("package_bundle.MAX_EXPANDED", 1), self.assertRaisesRegex(ValueError, "limit"):
            extract_engine(self.archive, self.root / "extract", "Wayfern")

    def fixture(self, platform):
        source = self.root / "source"
        output = self.root / "output"
        (source / "binary").mkdir(parents=True)
        output.mkdir()
        executable = "chrome.exe" if platform == "windows-x64" else "wayfern"
        entries = [(f"Wayfern/{executable}", b"engine", FILE)]
        if platform == "linux-x64":
            entries.append(("Wayfern/Current", executable.encode(), LINK))
        make_zip(self.archive, entries)
        pin = {"asset_id": 42, "tag": "fixture", "name": "Wayfern.zip", "archive_root": "Wayfern",
               "size": self.archive.stat().st_size, "sha256": digest(self.archive)}
        slot = {"status": "ready", "install_dir": f"{platform}/Wayfern", "executable": executable,
                "integrity": [{"path": executable, "sha256": hashlib.sha256(b"engine").hexdigest()}]}
        (source / "binary/wayfern-local.json").write_text(json.dumps({"schema_version": 1, "platforms": {platform: slot}}))
        (source / "binary/release-assets.json").write_text(json.dumps({"platforms": {platform: pin}}))
        bundle = source / "src-tauri/target" / TARGETS[platform] / "release/bundle"
        if platform == "windows-x64":
            (bundle / "nsis").mkdir(parents=True)
            (bundle / "nsis/setup.exe").write_bytes(b"installer fixture")
        else:
            (bundle / "appimage").mkdir(parents=True)
            (bundle / "appimage/donut.AppImage").write_bytes(b"AppImage fixture")
            (bundle / "deb").mkdir()
            (bundle / "deb/donut.deb").write_bytes(b"deb fixture")
        return source, output

    def test_linux_combined_archive(self):
        if os.name == "nt":
            self.skipTest("Unix symlinks tested on native Unix runners")
        source, output = self.fixture("linux-x64")
        package(source, output, "linux-x64", self.archive)
        manifest = json.loads((output / "BUNDLE-MANIFEST.json").read_text())
        self.assertFalse(manifest["runtimeAcceptance"])
        self.assertEqual(manifest["sha256"], digest(output / manifest["file"]))
        with tarfile.open(output / manifest["file"]) as tar:
            prefix = "LNLogin-linux-x64/"
            self.assertTrue(tar.getmember(prefix + "binary/linux-x64/Wayfern/Current").issym())
            self.assertEqual(tar.getmember(prefix + "start-donut.sh").mode & 0o777, 0o755)
            for name in ["manager/LNLogin.AppImage", "binary/wayfern-local.json", "START-HERE.txt", "PACKAGE-MANIFEST.json"]:
                self.assertIsNotNone(tar.getmember(prefix + name))
        self.assertEqual(list(output.glob("bundle-*")), [])

    def test_windows_combined_archive(self):
        source, output = self.fixture("windows-x64")
        package(source, output, "windows-x64", self.archive)
        with zipfile.ZipFile(output / "LNLogin-windows-x64.zip") as zipped:
            for name in ["manager/LNLogin-setup.exe", "binary/windows-x64/Wayfern/chrome.exe",
                         "binary/wayfern-local.json", "Start-LNLogin.cmd", "Start-LNLogin.ps1"]:
                self.assertIn("LNLogin-windows-x64/" + name, zipped.namelist())

    def test_corrupt_zip_no_success_manifest(self):
        source, output = self.fixture("windows-x64")
        with self.archive.open("ab") as stream:
            stream.write(b"corruption")
        with self.assertRaisesRegex(ValueError, "ZIP checksum"):
            package(source, output, "windows-x64", self.archive)
        self.assertFalse((output / "BUNDLE-MANIFEST.json").exists())


if __name__ == "__main__":
    unittest.main()
