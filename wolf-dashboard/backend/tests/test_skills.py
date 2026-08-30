from __future__ import annotations

import hashlib
import io
import struct
import stat
import tarfile
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db import Database
from app.skills import (
    MAX_ARCHIVE_ENTRIES,
    MAX_EXTRACTED_FILE_BYTES,
    MAX_EXTRACTED_TOTAL_BYTES,
    MAX_UPLOAD_BYTES,
    SkillArchiveTooLargeError,
    SkillConflictError,
    SkillValidationError,
    SkillManager,
    create_skills_router,
    ensure_skill_schema,
)


SKILL_MD = """---
name: {skill_id}
description: A deterministic test skill for market evidence.
version: {version}
scope: testing
---

# Test skill

Use returned evidence only.
"""


def zip_archive(entries: list[tuple[str, bytes, int | None]] | dict[str, bytes]) -> bytes:
    if isinstance(entries, dict):
        entries = [(name, content, None) for name, content in entries.items()]
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content, mode in entries:
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            if mode is not None:
                info.external_attr = (mode & 0xFFFF) << 16
            archive.writestr(info, content)
    return output.getvalue()


def tar_archive(entries: list[tuple[str, bytes, str | None]]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, content, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = "SKILL.md"
            elif kind == "hardlink":
                info.type = tarfile.LNKTYPE
                info.linkname = "safe/SKILL.md"
            else:
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
                continue
            archive.addfile(info)
    return output.getvalue()


def skill_entries(skill_id: str = "safe", version: str = "0.1.0") -> dict[str, bytes]:
    return {
        f"{skill_id}/SKILL.md": SKILL_MD.format(skill_id=skill_id, version=version).encode(),
        f"{skill_id}/references/fields.md": b"# Fields\n\nOnly returned fields are evidence.\n",
        f"{skill_id}/scripts/check.py": b"raise SystemExit('must never run')\n",
    }


@pytest.fixture()
def manager(tmp_path: Path) -> SkillManager:
    database = Database(tmp_path / "skills.sqlite3")
    database.init()
    return SkillManager(
        database,
        repo_root=tmp_path / "repo",
        builtin_dir=tmp_path / "repo" / "skills",
        user_skills_dir=tmp_path / "user-skills",
    )


def install_zip(manager: SkillManager, skill_id: str = "safe", version: str = "0.1.0") -> dict:
    return manager.install_archive(
        zip_archive(skill_entries(skill_id, version)),
        filename=f"{skill_id}.zip",
    )


def test_schema_is_idempotent_and_compatible_with_database_schema(tmp_path: Path) -> None:
    database = Database(tmp_path / "skills.sqlite3")
    database.init()
    ensure_skill_schema(database)
    ensure_skill_schema(database)
    columns = {row[1] for row in database.connection.execute("PRAGMA table_info(skills)")}
    assert {"id", "builtin", "archive_sha256", "content_sha256", "install_path"} <= columns


def test_installs_zip_and_persists_archive_and_content_hashes(manager: SkillManager) -> None:
    archive = zip_archive(skill_entries())
    result = manager.install_archive(archive, filename="safe.zip")
    expected_content = hashlib.sha256()
    for path, content in sorted((key.split("/", 1)[1], value) for key, value in skill_entries().items()):
        expected_content.update(path.encode())
        expected_content.update(b"\0")
        expected_content.update(content)
        expected_content.update(b"\0")
    assert result["source"] == "upload"
    assert result["version"] == "0.1.0"
    assert result["archive_sha256"] == hashlib.sha256(archive).hexdigest()
    assert result["content_sha256"] == expected_content.hexdigest()
    assert result["file_count"] == 3
    assert (manager.user_skills_dir / "safe" / "scripts" / "check.py").exists()


def test_installs_tgz_and_never_makes_uploaded_scripts_executable(manager: SkillManager) -> None:
    entries = skill_entries()
    archive = tar_archive([(name, content, None) for name, content in entries.items()])
    result = manager.install_archive(archive, filename="safe.tgz")
    script = manager.user_skills_dir / result["id"] / "scripts" / "check.py"
    assert script.read_text() == "raise SystemExit('must never run')\n"
    assert not (script.stat().st_mode & stat.S_IXUSR)


def test_accepts_safe_leading_dot_segments_in_normal_archives(manager: SkillManager) -> None:
    entries = skill_entries()
    archive = tar_archive([(f"./{name}", content, None) for name, content in entries.items()])
    assert manager.install_archive(archive, filename="safe.tgz")["id"] == "safe"


@pytest.mark.parametrize(
    "name",
    ["../outside/SKILL.md", "/absolute/SKILL.md", "C:/absolute/SKILL.md", "safe/../../outside"],
)
def test_rejects_unsafe_archive_paths_without_installing(manager: SkillManager, name: str) -> None:
    archive = zip_archive([(name, b"bad", None), *[(k, v, None) for k, v in skill_entries().items()]])
    with pytest.raises(SkillValidationError):
        manager.install_archive(archive, filename="safe.zip")
    assert list(manager.user_skills_dir.iterdir()) == []


def test_rejects_backslash_and_duplicate_normalized_paths(manager: SkillManager) -> None:
    with pytest.raises(SkillValidationError):
        manager.install_archive(
            zip_archive([("safe\\SKILL.md", b"bad", None)]),
            filename="safe.zip",
        )
    duplicate = [("safe/SKILL.md", b"one", None), ("safe/SKILL.md", b"two", None)]
    with pytest.raises(SkillValidationError, match="duplicate"):
        manager.install_archive(zip_archive(duplicate), filename="safe.zip")
    case_duplicate = [("safe/SKILL.md", b"one", None), ("safe/skill.md", b"two", None)]
    with pytest.raises(SkillValidationError, match="duplicate"):
        manager.install_archive(zip_archive(case_duplicate), filename="safe.zip")


def test_rejects_tar_links_and_device_like_entries(manager: SkillManager) -> None:
    symlink = [("safe/SKILL.md", b"", "symlink"), *[(k, v, None) for k, v in skill_entries().items()]]
    with pytest.raises(SkillValidationError, match="link"):
        manager.install_archive(tar_archive(symlink), filename="safe.tgz")
    hardlink = [
        ("safe/SKILL.md", SKILL_MD.format(skill_id="safe", version="0.1.0").encode(), None),
        ("safe/copy", b"", "hardlink"),
    ]
    with pytest.raises(SkillValidationError, match="link"):
        manager.install_archive(tar_archive(hardlink), filename="safe.tar.gz")


def test_rejects_encrypted_and_entry_count_limits(manager: SkillManager) -> None:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("safe/SKILL.md", SKILL_MD.format(skill_id="safe", version="0.1.0"))
    encrypted = bytearray(output.getvalue())
    for signature, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        cursor = 0
        while True:
            index = encrypted.find(signature, cursor)
            if index < 0:
                break
            struct.pack_into("<H", encrypted, index + offset, 1)
            cursor = index + len(signature)
    with pytest.raises(SkillValidationError, match="encrypted"):
        manager.install_archive(bytes(encrypted), filename="safe.zip")

    many = [("safe/SKILL.md", SKILL_MD.format(skill_id="safe", version="0.1.0").encode(), None)]
    many.extend((f"safe/references/{index}.md", b"x", None) for index in range(MAX_ARCHIVE_ENTRIES))
    with pytest.raises(SkillValidationError, match="entry count"):
        manager.install_archive(zip_archive(many), filename="safe.zip")


def test_rejects_single_and_total_expanded_size_limits(manager: SkillManager) -> None:
    oversized = {
        "safe/SKILL.md": SKILL_MD.format(skill_id="safe", version="0.1.0").encode(),
        "safe/big.bin": b"x" * (MAX_EXTRACTED_FILE_BYTES + 1),
    }
    with pytest.raises(SkillValidationError, match="exceeds"):
        manager.install_archive(zip_archive(oversized), filename="safe.zip")

    total = {
        "safe/SKILL.md": SKILL_MD.format(skill_id="safe", version="0.1.0").encode(),
    }
    total.update({f"safe/{index}.bin": b"x" * (MAX_EXTRACTED_TOTAL_BYTES // 5) for index in range(6)})
    with pytest.raises(SkillValidationError, match="exceeds"):
        manager.install_archive(zip_archive(total), filename="safe.zip")

    with pytest.raises(SkillArchiveTooLargeError):
        manager.install_archive(b"x" * (MAX_UPLOAD_BYTES + 1), filename="safe.zip")


def test_name_collision_and_downgrade_fail_without_overwrite(manager: SkillManager) -> None:
    first = install_zip(manager, version="1.0.0")
    original = (manager.user_skills_dir / "safe" / "SKILL.md").read_bytes()
    with pytest.raises(SkillConflictError, match="downgrade"):
        manager.install_archive(zip_archive(skill_entries(version="0.9.0")), filename="safe.zip")
    with pytest.raises(SkillConflictError, match="already installed"):
        manager.install_archive(zip_archive(skill_entries(version="2.0.0")), filename="safe.zip")
    assert (manager.user_skills_dir / "safe" / "SKILL.md").read_bytes() == original
    assert manager.list_skills()[0]["content_sha256"] == first["content_sha256"]


def test_enable_disable_uninstall_and_builtin_protection(manager: SkillManager, tmp_path: Path) -> None:
    builtin = manager.builtin_dir / "builtin-skill"
    builtin.mkdir(parents=True)
    (builtin / "SKILL.md").write_text(SKILL_MD.format(skill_id="builtin-skill", version="0.1.0"))
    discovered = manager.list_skills()
    assert discovered[0]["source"] == "builtin"
    assert discovered[0]["builtin"] is True
    manager.set_enabled("builtin-skill", False)
    with pytest.raises(SkillConflictError, match="disabled"):
        manager.read_skill("builtin-skill")
    with pytest.raises(SkillConflictError, match="not deleted"):
        manager.uninstall("builtin-skill")

    install_zip(manager)
    manager.set_enabled("safe", False)
    with pytest.raises(SkillConflictError, match="disabled"):
        manager.read_skill("safe")
    manager.set_enabled("safe", True)
    assert manager.read_skill("safe")["path"] == "SKILL.md"
    manager.uninstall("safe")
    assert not (manager.user_skills_dir / "safe").exists()
    assert manager._row("safe") is None


def test_failed_install_is_atomic_and_leaves_no_staging_directory(manager: SkillManager) -> None:
    with pytest.raises(SkillValidationError):
        manager.install_archive(zip_archive({"safe/not-skill.txt": b"no frontmatter"}), filename="safe.zip")
    assert list(manager.user_skills_dir.iterdir()) == []
    assert manager.list_skills() == []

    conflicting_entries = [
        ("safe", b"file", None),
        ("safe/SKILL.md", SKILL_MD.format(skill_id="safe", version="0.1.0").encode(), None),
    ]
    with pytest.raises(SkillValidationError):
        manager.install_archive(zip_archive(conflicting_entries), filename="safe.zip")
    assert list(manager.user_skills_dir.iterdir()) == []


def test_reference_reads_are_enabled_and_path_bounded(manager: SkillManager) -> None:
    install_zip(manager)
    assert manager.read_reference("safe", "references/fields.md")["path"] == "references/fields.md"
    for path in ("../SKILL.md", "references/../SKILL.md", "scripts/check.py", "/references/fields.md", "references/fields.txt"):
        with pytest.raises(SkillValidationError):
            manager.read_reference("safe", path)


def test_sidecar_fails_closed_after_local_content_tampering(manager: SkillManager) -> None:
    install_zip(manager)
    skill_file = manager.user_skills_dir / "safe" / "SKILL.md"
    skill_file.write_text(skill_file.read_text() + "\nchanged locally\n")
    with pytest.raises(SkillValidationError, match="hash mismatch"):
        manager.enabled_summaries()
    with pytest.raises(SkillValidationError, match="hash mismatch"):
        manager.read_skill("safe")


def test_router_exposes_management_and_sidecar_contract(manager: SkillManager) -> None:
    app = FastAPI()
    app.include_router(create_skills_router(manager))
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/skills/install",
            files={"file": ("safe.zip", zip_archive(skill_entries()), "application/zip")},
        )
        assert response.status_code == 200, response.text
        assert client.get("/api/v1/skills").json()["items"][0]["id"] == "safe"
        assert client.get("/api/v1/skills/enabled").json()["items"][0]["id"] == "safe"
        assert client.get("/api/v1/skills/safe/SKILL.md").json()["content"].startswith("---")
        assert client.get("/api/v1/skills/safe/references/fields.md").status_code == 200
        assert client.patch("/api/v1/skills/safe", json={"enabled": False}).status_code == 200
        assert client.get("/api/v1/skills/safe/SKILL.md").status_code == 409
        assert client.delete("/api/v1/skills/safe").status_code == 200
