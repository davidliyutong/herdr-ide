#!/usr/bin/env python3
"""Regenerate bundled herdr notices from an upstream v0.9.5 checkout.

Requires Python 3 and upstream's pinned Rust toolchain. Network is used only
by this maintenance command, not by the application or ordinary test suite.
"""

import concurrent.futures
import functools
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request


SOURCE = Path(sys.argv[1]).resolve()
OUTPUT = Path(__file__).resolve().parent.parent / "licenses/herdr"
TARGETS = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl",
           "x86_64-apple-darwin", "aarch64-apple-darwin"]


@functools.cache
def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "herdr-license-notices"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def is_notice(name):
    return Path(name).name.lower().startswith(("license", "licence", "copying", "notice", "copyright"))


def repository_notices(repository, revision):
    parts = repository.removesuffix(".git").split("/")
    repo = "/".join(parts[3:5])
    entries = json.loads(download(f"https://api.github.com/repos/{repo}/contents?ref={revision}"))
    result = []
    for entry in entries:
        if entry["type"] == "file" and is_notice(entry["name"]):
            url = entry["download_url"]
            result.append((url, download(url).decode()))
    if not result:
        raise RuntimeError(f"No license text for {repo}@{revision}")
    return result


def package_notices(package):
    directory = Path(package["manifest_path"]).parent
    if package["name"] in ("herdr", "ghostty-vt"):
        files = [SOURCE / "LICENSE"]
    else:
        files = sorted(p for p in directory.rglob("*") if p.is_file() and is_notice(p.name))
    if files:
        return [(p.relative_to(directory).as_posix() if p.is_relative_to(directory) else "upstream LICENSE",
                 p.read_text(errors="strict")) for p in files]
    vcs = json.loads((directory / ".cargo_vcs_info.json").read_text())
    return repository_notices(package["repository"], vcs["git"]["sha1"])


def archive_notices(url):
    data = download(url)
    result = []
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for entry in archive:
            if entry.isfile() and is_notice(entry.name):
                result.append((f"{url} ({entry.name})", archive.extractfile(entry).read().decode()))
    if not result:
        raise RuntimeError(f"No license text in {url}")
    return result


def main():
    packages = {}
    for target in TARGETS:
        metadata = json.loads(subprocess.check_output(
            ["cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform", target], cwd=SOURCE))
        nodes = {n["id"]: n for n in metadata["resolve"]["nodes"]}
        seen, pending = set(), [metadata["resolve"]["root"]]
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            for dep in nodes[current]["deps"]:
                if any(kind["kind"] != "dev" for kind in dep["dep_kinds"]):
                    pending.append(dep["pkg"])
        for package in metadata["packages"]:
            if package["id"] in seen:
                packages[package["id"]] = package
    packages = sorted(packages.values(), key=lambda p: (p["name"], p["version"]))
    components = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for package, notices in zip(packages, pool.map(package_notices, packages)):
            components.append((f'{package["name"]} {package["version"]}', package["license"], package["repository"], notices))

    ghostty = SOURCE / "vendor/libghostty-vt"
    components.append(("libghostty-vt (vendored)", "MIT", "https://github.com/ghostty-org/ghostty",
                       [("vendor/libghostty-vt/LICENSE", (ghostty / "LICENSE").read_text())]))
    for name, zon in [("uucode", ghostty / "build.zig.zon"),
                      ("highway", ghostty / "pkg/highway/build.zig.zon"),
                      ("wuffs", ghostty / "pkg/wuffs/build.zig.zon")]:
        urls = re.findall(r'\.url\s*=\s*"([^"]+)"', zon.read_text())
        url = next(url for url in urls if f"/{name}-" in url)
        components.append((name, "See texts below", url, archive_notices(url)))
    # The amalgamated simdutf source is vendored without separate license files.
    header = (ghostty / "pkg/simdutf/vendor/simdutf.h").read_text()
    simd_version = re.search(r'#define SIMDUTF_VERSION "([^"]+)"', header).group(1)
    simd = f"https://raw.githubusercontent.com/simdutf/simdutf/v{simd_version}/"
    simd_notices = [(simd + name, download(simd + name).decode())
                    for name in ("LICENSE-APACHE", "LICENSE-MIT")]
    for comment in re.findall(r'/\*.*?\*/', header, re.S):
        if "Copyright" in comment and ("Permission" in comment or "Redistribution" in comment):
            simd_notices.append(("vendored simdutf.h attribution", comment))
    components.append((f"simdutf {simd_version} (vendored)", "Apache-2.0 OR MIT", simd, simd_notices))
    for name, url in [
        ("Zig 0.16.0 runtime", "https://codeberg.org/ziglang/zig/raw/tag/0.16.0/LICENSE"),
        ("musl libc (Linux)", "https://git.musl-libc.org/cgit/musl/plain/COPYRIGHT?h=v1.2.5"),
    ]:
        components.append((name, "See text below", url, [(url, download(url).decode())]))

    OUTPUT.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE / "LICENSE", OUTPUT / "LICENSE")
    sysroot = subprocess.check_output(["rustc", "--print", "sysroot"], cwd=SOURCE, text=True).strip()
    shutil.copyfile(Path(sysroot) / "share/doc/rust/COPYRIGHT-library.html", OUTPUT / "RUST-COPYRIGHT.html")
    texts = {}
    inventory = []
    for name, license_id, repository, notices in components:
        refs = []
        for origin, body in notices:
            body = body.replace("\r\n", "\n").strip()
            digest = hashlib.sha256(body.encode()).hexdigest()
            if digest not in texts:
                texts[digest] = {"id": len(texts) + 1, "body": body, "origins": []}
            item = texts[digest]
            item["origins"].append(f"{name}: {origin}")
            refs.append(str(item["id"]))
        inventory.append(f"- **{name}** — {license_id}; notices {', '.join(refs)}. {repository or ''}")
    lines = ["# herdr 0.9.5 third-party notices", "",
             "This inventory is the union of runtime and build dependencies reachable",
             "from the locked herdr workspace for Linux/macOS on amd64/arm64. It may",
             "include code not present in an individual binary. Alternative licenses",
             "remain alternatives; inclusion here does not change their terms.", "",
             "Rust standard-library notices are provided in RUST-COPYRIGHT.html.", "",
             "## Components", "", *inventory, ""]
    for item in texts.values():
        lines.extend([f'## Notice {item["id"]}', "", *[f"- {origin}" for origin in item["origins"]],
                      "", "````text", item["body"], "````", ""])
    (OUTPUT / "THIRD_PARTY_NOTICES.md").write_text("\n".join(lines))
    print(f"Wrote notices for {len(components)} components ({len(texts)} distinct texts)")


if __name__ == "__main__":
    main()
