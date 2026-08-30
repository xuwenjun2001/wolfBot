"""Skill discovery, archive installation, and read-only runtime access.

The module is intentionally independent from ``app.main``.  The application
can mount :func:`create_skills_router` when the Agent surface is integrated,
while tests and sidecars can use :class:`SkillManager` directly.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import tarfile
import tempfile
import threading
import unicodedata
import zipfile
import zlib
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Iterable, Mapping

from fastapi import APIRouter, HTTPException, Request


MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 250
MAX_EXTRACTED_FILE_BYTES = 10 * 1024 * 1024
MAX_EXTRACTED_TOTAL_BYTES = 50 * 1024 * 1024
MAX_REFERENCE_BYTES = MAX_EXTRACTED_FILE_BYTES
MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024

_SKILL_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
_SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
_DRIVE_PATH = re.compile(r"^[A-Za-z]:")
_ARCHIVE_SUFFIXES = (".tar.gz", ".tgz", ".zip")


SKILL_SCHEMA = """
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '',
    applicable_scope TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'upload',
    enabled INTEGER NOT NULL DEFAULT 1,
    builtin INTEGER NOT NULL DEFAULT 0,
    installed_at TEXT NOT NULL,
    archive_sha256 TEXT,
    content_sha256 TEXT NOT NULL,
    install_path TEXT NOT NULL,
    archive_name TEXT NOT NULL DEFAULT '',
    archive_size INTEGER NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled, id);
"""


class SkillError(Exception):
    """A user-visible, deterministic skill management error."""

    status_code = 400
    code = "skill_error"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


class SkillNotFoundError(SkillError):
    status_code = 404
    code = "skill_not_found"


class SkillConflictError(SkillError):
    status_code = 409
    code = "skill_conflict"


class SkillValidationError(SkillError):
    status_code = 400
    code = "invalid_skill"


class SkillArchiveTooLargeError(SkillError):
    status_code = 413
    code = "archive_too_large"


class SkillUnsupportedArchiveError(SkillError):
    status_code = 415
    code = "unsupported_archive"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _db_connection(db: Any) -> sqlite3.Connection:
    if isinstance(db, sqlite3.Connection):
        if db.row_factory is None:
            db.row_factory = sqlite3.Row
        return db
    connection = getattr(db, "connection", None)
    if isinstance(connection, sqlite3.Connection):
        return connection
    raise TypeError("db must be sqlite3.Connection or app.db.Database")


def ensure_skill_schema(db: Any) -> None:
    """Create the skill table without changing the application's db module.

    The helper accepts the existing ``Database`` wrapper as well as a raw
    sqlite connection so integration code can call it during its own startup.
    """

    connection = _db_connection(db)
    connection.executescript(SKILL_SCHEMA)
    columns = {
        str(row[1]) for row in connection.execute("PRAGMA table_info(skills)").fetchall()
    }
    # Keep this small migration path for databases created by an earlier MVP
    # build.  It is deliberately additive and therefore idempotent.
    additions = {
        "description": "TEXT NOT NULL DEFAULT ''",
        "scope": "TEXT NOT NULL DEFAULT ''",
        "applicable_scope": "TEXT NOT NULL DEFAULT ''",
        "source": "TEXT NOT NULL DEFAULT 'upload'",
        "enabled": "INTEGER NOT NULL DEFAULT 1",
        "builtin": "INTEGER NOT NULL DEFAULT 0",
        "installed_at": "TEXT NOT NULL DEFAULT ''",
        "archive_sha256": "TEXT",
        "content_sha256": "TEXT NOT NULL DEFAULT ''",
        "install_path": "TEXT NOT NULL DEFAULT ''",
        "archive_name": "TEXT NOT NULL DEFAULT ''",
        "archive_size": "INTEGER NOT NULL DEFAULT 0",
        "file_count": "INTEGER NOT NULL DEFAULT 0",
        "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
        "updated_at": "TEXT NOT NULL DEFAULT ''",
    }
    for name, definition in additions.items():
        if name not in columns:
            connection.execute(f"ALTER TABLE skills ADD COLUMN {name} {definition}")
    connection.commit()


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _version_tuple(version: str) -> tuple[int, int, int]:
    if not isinstance(version, str) or not _SEMVER.fullmatch(version):
        raise SkillValidationError("version must use semver, for example 0.1.0")
    return tuple(int(part) for part in version.split("."))  # type: ignore[return-value]


def _validate_skill_id(skill_id: str) -> str:
    if not isinstance(skill_id, str) or not _SKILL_ID.fullmatch(skill_id):
        raise SkillValidationError("skill_id must contain lowercase letters, digits, and hyphens")
    return skill_id


def _unquote_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        if value[0] == '"':
            try:
                parsed = json.loads(value)
                return parsed if isinstance(parsed, str) else value[1:-1]
            except json.JSONDecodeError:
                return value[1:-1]
        return value[1:-1].replace("''", "'")
    return value


def _read_frontmatter(skill_file: Path) -> dict[str, str]:
    try:
        text = skill_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise SkillValidationError(f"cannot read SKILL.md: {exc}") from exc
    match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", text, re.DOTALL)
    if not match:
        raise SkillValidationError("SKILL.md must contain YAML frontmatter")
    values: dict[str, str] = {}
    section: str | None = None
    block_key: str | None = None
    block_style: str | None = None
    block_lines: list[str] = []

    def flush_block() -> None:
        nonlocal block_key, block_style, block_lines, section
        if block_key is None:
            return
        if block_style == "|":
            values[block_key] = "\n".join(block_lines).rstrip()
        else:
            values[block_key] = " ".join(line for line in block_lines if line).strip()
        block_key = None
        block_style = None
        block_lines = []
        section = None

    for raw_line in match.group(1).splitlines():
        if block_key is not None:
            if not raw_line.strip() or raw_line[0].isspace():
                block_lines.append(raw_line.strip())
                continue
            flush_block()
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        is_nested = raw_line[0].isspace()
        line = raw_line.strip()
        if is_nested and section == "metadata":
            if ":" not in line:
                raise SkillValidationError("SKILL.md metadata contains an invalid line")
            nested_key, nested_value = line.split(":", 1)
            nested_key = nested_key.strip()
            if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", nested_key):
                raise SkillValidationError("SKILL.md metadata contains an invalid key")
            values[f"metadata.{nested_key}"] = _unquote_scalar(nested_value)
            continue
        if is_nested:
            raise SkillValidationError("SKILL.md frontmatter contains unsupported nested data")
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            raise SkillValidationError("SKILL.md frontmatter contains an invalid line")
        key, raw_value = line.split(":", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", key):
            raise SkillValidationError("SKILL.md frontmatter contains an invalid key")
        scalar = _unquote_scalar(raw_value)
        if scalar in {"|", "|-", "|+", ">", ">-", ">+"}:
            block_key = key
            block_style = "|" if scalar.startswith("|") else ">"
            section = None
            continue
        values[key] = scalar
        if key == "metadata" and scalar.startswith("{"):
            try:
                inline_metadata = json.loads(scalar)
            except json.JSONDecodeError:
                inline_metadata = None
            if isinstance(inline_metadata, dict):
                for nested_key, nested_value in inline_metadata.items():
                    if isinstance(nested_key, str) and isinstance(nested_value, (str, int, float, bool)):
                        values[f"metadata.{nested_key}"] = str(nested_value)
        section = key if key == "metadata" else None
    flush_block()
    for required in ("name", "description"):
        if not values.get(required, "").strip():
            raise SkillValidationError(f"SKILL.md frontmatter requires {required}")
    return values


def _lstat_checked(path: Path, *, label: str) -> os.stat_result:
    try:
        result = path.lstat()
    except OSError as exc:
        raise SkillValidationError(f"{label} is not accessible: {exc}") from exc
    if stat.S_ISLNK(result.st_mode):
        raise SkillValidationError(f"{label} must not be a symbolic link")
    return result


def _inside(parent: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(parent)
        return True
    except ValueError:
        return False


def _iter_files(root: Path) -> list[Path]:
    """List a tree after rejecting links and special filesystem entries."""

    root_stat = _lstat_checked(root, label="skill root")
    if not stat.S_ISDIR(root_stat.st_mode):
        raise SkillValidationError("skill root must be a directory")
    files: list[Path] = []
    total = 0
    for current, directories, names in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        safe_directories: list[str] = []
        for name in sorted(directories):
            candidate = current_path / name
            entry = _lstat_checked(candidate, label="skill directory")
            if not stat.S_ISDIR(entry.st_mode):
                raise SkillValidationError(f"skill tree contains an unsupported entry: {candidate.name}")
            safe_directories.append(name)
        directories[:] = safe_directories
        for name in sorted(names):
            candidate = current_path / name
            entry = _lstat_checked(candidate, label="skill file")
            if not stat.S_ISREG(entry.st_mode):
                raise SkillValidationError(f"skill tree contains an unsupported entry: {name}")
            if entry.st_nlink > 1:
                raise SkillValidationError(f"skill tree contains a hard-linked file: {name}")
            if entry.st_size > MAX_EXTRACTED_FILE_BYTES:
                raise SkillValidationError(f"skill file exceeds {MAX_EXTRACTED_FILE_BYTES} bytes: {name}")
            total += entry.st_size
            if total > MAX_EXTRACTED_TOTAL_BYTES:
                raise SkillValidationError(
                    f"skill tree exceeds {MAX_EXTRACTED_TOTAL_BYTES} extracted bytes"
                )
            files.append(candidate)
    if not files:
        raise SkillValidationError("skill package must contain at least one file")
    return sorted(files, key=lambda item: item.relative_to(root).as_posix())


def _content_hash(root: Path, files: Iterable[Path] | None = None) -> tuple[str, int]:
    paths = list(files) if files is not None else _iter_files(root)
    digest = hashlib.sha256()
    for file_path in sorted(paths, key=lambda item: item.relative_to(root).as_posix()):
        relative = file_path.relative_to(root).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest(), len(paths)


def _normalise_archive_path(name: str, *, directory: bool) -> str:
    if not isinstance(name, str) or not name or "\x00" in name:
        raise SkillValidationError("archive contains an invalid path")
    if "\\" in name or name.startswith("/") or name.startswith("//") or _DRIVE_PATH.match(name):
        raise SkillValidationError(f"archive contains an absolute or platform path: {name!r}")
    if directory and name == ".":
        return ""
    while name.startswith("./"):
        name = name[2:]
    if not name and directory:
        return ""
    if not name:
        raise SkillValidationError("archive contains an invalid path")
    if directory:
        if not name.endswith("/"):
            # Tar directory entries do not have to use a slash; zip entries do.
            raw_parts = name.split("/")
        else:
            if name.endswith("//"):
                raise SkillValidationError(f"archive contains an invalid directory path: {name!r}")
            raw_parts = name[:-1].split("/")
    else:
        if name.endswith("/"):
            raise SkillValidationError(f"archive contains an invalid file path: {name!r}")
        raw_parts = name.split("/")
    if not raw_parts or any(part in {"", ".", ".."} for part in raw_parts):
        raise SkillValidationError(f"archive contains an unsafe path: {name!r}")
    return "/".join(unicodedata.normalize("NFC", part) for part in raw_parts)


def _write_extracted_file(destination: Path, content: bytes) -> None:
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    except OSError as exc:
        raise SkillValidationError(f"cannot materialize archive entry: {destination.name}") from exc
    # Uploaded scripts are data.  They are never made executable by this MVP.
    try:
        destination.chmod(0o600)
    except OSError:
        pass


def _extract_zip(data: bytes, destination: Path) -> None:
    try:
        archive = zipfile.ZipFile(BytesIO(data))
    except (OSError, zipfile.BadZipFile) as exc:
        raise SkillValidationError(f"invalid zip archive: {exc}") from exc
    with archive:
        try:
            entries = archive.infolist()
        except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as exc:
            raise SkillValidationError(f"invalid zip archive: {exc}") from exc
        if not entries or len(entries) > MAX_ARCHIVE_ENTRIES:
            raise SkillValidationError(f"archive entry count must be between 1 and {MAX_ARCHIVE_ENTRIES}")
        seen: set[str] = set()
        seen_normalized: set[str] = set()
        total = 0
        for info in entries:
            directory = info.is_dir()
            canonical = _normalise_archive_path(info.filename, directory=directory)
            normalized_key = canonical.casefold()
            if canonical in seen or normalized_key in seen_normalized:
                raise SkillValidationError(f"archive contains duplicate normalized path: {canonical}")
            seen.add(canonical)
            seen_normalized.add(normalized_key)
            if info.flag_bits & 0x1:
                raise SkillValidationError(f"archive contains an encrypted entry: {canonical}")
            mode = (info.external_attr >> 16) & 0xFFFF
            file_type = stat.S_IFMT(mode)
            if file_type:
                if directory:
                    if file_type != stat.S_IFDIR:
                        raise SkillValidationError(f"archive contains an unsafe directory entry: {canonical}")
                elif file_type != stat.S_IFREG:
                    raise SkillValidationError(f"archive contains an unsafe entry type: {canonical}")
            target = destination / PurePosixPath(canonical)
            if not _inside(destination, target):
                raise SkillValidationError(f"archive path escapes extraction root: {canonical}")
            if directory:
                try:
                    target.mkdir(parents=True, exist_ok=True)
                except OSError as exc:
                    raise SkillValidationError(f"archive entries conflict at: {canonical}") from exc
                continue
            if not isinstance(info.file_size, int) or info.file_size < 0 or info.file_size > MAX_EXTRACTED_FILE_BYTES:
                raise SkillValidationError(f"archive file exceeds {MAX_EXTRACTED_FILE_BYTES} bytes: {canonical}")
            total += info.file_size
            if total > MAX_EXTRACTED_TOTAL_BYTES:
                raise SkillValidationError(f"archive exceeds {MAX_EXTRACTED_TOTAL_BYTES} extracted bytes")
            try:
                with archive.open(info, "r") as stream:
                    chunks: list[bytes] = []
                    remaining = MAX_EXTRACTED_FILE_BYTES + 1
                    while remaining > 0:
                        chunk = stream.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        chunks.append(chunk)
                        remaining -= len(chunk)
                    content = b"".join(chunks)
            except (KeyError, OSError, RuntimeError, ValueError, zlib.error, zipfile.BadZipFile) as exc:
                raise SkillValidationError(f"cannot extract archive entry {canonical}: {exc}") from exc
            if len(content) != info.file_size or len(content) > MAX_EXTRACTED_FILE_BYTES:
                raise SkillValidationError(f"archive entry size mismatch or limit exceeded: {canonical}")
            _write_extracted_file(target, content)


def _extract_tar(data: bytes, destination: Path) -> None:
    try:
        archive = tarfile.open(fileobj=BytesIO(data), mode="r:*")
    except (OSError, tarfile.TarError) as exc:
        raise SkillValidationError(f"invalid tar archive: {exc}") from exc
    with archive:
        try:
            entries = archive.getmembers()
        except tarfile.TarError as exc:
            raise SkillValidationError(f"invalid tar archive: {exc}") from exc
        if not entries or len(entries) > MAX_ARCHIVE_ENTRIES:
            raise SkillValidationError(f"archive entry count must be between 1 and {MAX_ARCHIVE_ENTRIES}")
        seen: set[str] = set()
        seen_normalized: set[str] = set()
        total = 0
        for member in entries:
            directory = member.isdir()
            canonical = _normalise_archive_path(member.name, directory=directory)
            normalized_key = canonical.casefold()
            if canonical in seen or normalized_key in seen_normalized:
                raise SkillValidationError(f"archive contains duplicate normalized path: {canonical}")
            seen.add(canonical)
            seen_normalized.add(normalized_key)
            if member.issym() or member.islnk():
                raise SkillValidationError(f"archive contains a symbolic or hard link: {canonical}")
            if not directory and not member.isreg():
                raise SkillValidationError(f"archive contains an unsafe entry type: {canonical}")
            target = destination / PurePosixPath(canonical)
            if not _inside(destination, target):
                raise SkillValidationError(f"archive path escapes extraction root: {canonical}")
            if directory:
                try:
                    target.mkdir(parents=True, exist_ok=True)
                except OSError as exc:
                    raise SkillValidationError(f"archive entries conflict at: {canonical}") from exc
                continue
            if not isinstance(member.size, int) or member.size < 0 or member.size > MAX_EXTRACTED_FILE_BYTES:
                raise SkillValidationError(f"archive file exceeds {MAX_EXTRACTED_FILE_BYTES} bytes: {canonical}")
            total += member.size
            if total > MAX_EXTRACTED_TOTAL_BYTES:
                raise SkillValidationError(f"archive exceeds {MAX_EXTRACTED_TOTAL_BYTES} extracted bytes")
            try:
                stream = archive.extractfile(member)
            except (KeyError, OSError, tarfile.TarError) as exc:
                raise SkillValidationError(f"cannot read archive entry: {canonical}") from exc
            if stream is None:
                raise SkillValidationError(f"cannot read archive entry: {canonical}")
            try:
                with stream:
                    chunks: list[bytes] = []
                    remaining = MAX_EXTRACTED_FILE_BYTES + 1
                    while remaining > 0:
                        chunk = stream.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        chunks.append(chunk)
                        remaining -= len(chunk)
                    content = b"".join(chunks)
            except (OSError, tarfile.TarError) as exc:
                raise SkillValidationError(f"cannot read archive entry: {canonical}") from exc
            if len(content) != member.size or len(content) > MAX_EXTRACTED_FILE_BYTES:
                raise SkillValidationError(f"archive entry size mismatch or limit exceeded: {canonical}")
            _write_extracted_file(target, content)


def _safe_reference_path(relative_path: str) -> str:
    if not isinstance(relative_path, str):
        raise SkillValidationError("reference path must be a string")
    value = relative_path.replace("\\", "/")
    if value.startswith("/") or _DRIVE_PATH.match(value) or "\x00" in value:
        raise SkillValidationError("reference path must be relative")
    parts = value.split("/")
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise SkillValidationError("reference path contains an unsafe segment")
    if parts[0] != "references" or not value.lower().endswith(".md"):
        raise SkillValidationError("only references/*.md files are readable")
    return "/".join(parts)


def _safe_skill_path(root: Path, candidate: Path) -> None:
    if not _inside(root, candidate):
        raise SkillValidationError("skill path escapes its installation directory")
    relative = candidate.relative_to(root)
    current = root
    _lstat_checked(root, label="skill root")
    for part in relative.parts:
        current = current / part
        _lstat_checked(current, label="skill resource")


def _metadata_from_root(root: Path, *, default_version: str | None = None) -> dict[str, Any]:
    files = _iter_files(root)
    skill_file = root / "SKILL.md"
    if not skill_file.is_file() or skill_file.is_symlink():
        raise SkillValidationError("skill package must contain SKILL.md at its root")
    frontmatter = _read_frontmatter(skill_file)
    skill_id = _validate_skill_id(frontmatter["name"].strip())
    version = frontmatter.get("version") or frontmatter.get("metadata.version") or default_version
    if not version:
        raise SkillValidationError("skill version is required during installation")
    _version_tuple(version)
    description = frontmatter["description"].strip()
    if len(description) > 4000:
        raise SkillValidationError("skill description is too long")
    content_sha256, file_count = _content_hash(root, files)
    return {
        "skill_id": skill_id,
        "name": skill_id,
        "version": version,
        "description": description,
        "scope": frontmatter.get("scope", frontmatter.get("metadata.scope", "")).strip(),
        "applicable_scope": frontmatter.get(
            "applicable_scope",
            frontmatter.get("metadata.applicable_scope", frontmatter.get("metadata.scope", "")),
        ).strip(),
        "content_sha256": content_sha256,
        "file_count": file_count,
        "metadata": frontmatter,
    }


def _parse_multipart(body: bytes, content_type: str) -> tuple[dict[str, str], bytes | None, str | None]:
    match = re.search(r"boundary=(?:\"([^\"]+)\"|([^;\s]+))", content_type, re.IGNORECASE)
    if not match:
        raise SkillValidationError("multipart upload is missing its boundary")
    boundary = (match.group(1) or match.group(2)).encode("utf-8")
    marker = b"--" + boundary
    fields: dict[str, str] = {}
    file_content: bytes | None = None
    file_name: str | None = None
    for part in body.split(marker)[1:]:
        if part.startswith(b"--"):
            break
        part = part.lstrip(b"\r\n")
        if not part:
            continue
        header_blob, separator, value = part.partition(b"\r\n\r\n")
        if not separator:
            header_blob, separator, value = part.partition(b"\n\n")
        if not separator:
            raise SkillValidationError("multipart upload contains a malformed part")
        if value.endswith(b"\r\n"):
            value = value[:-2]
        elif value.endswith(b"\n"):
            value = value[:-1]
        headers: dict[str, str] = {}
        for raw_header in re.split(br"\r?\n", header_blob):
            if b":" not in raw_header:
                continue
            key, raw_value = raw_header.split(b":", 1)
            headers[key.decode("latin-1").strip().lower()] = raw_value.decode("latin-1").strip()
        disposition = headers.get("content-disposition", "")
        name_match = re.search(r'name="([^"]+)"', disposition, re.IGNORECASE)
        if not name_match:
            continue
        field_name = name_match.group(1)
        filename_match = re.search(r'filename="([^"]*)"', disposition, re.IGNORECASE)
        if filename_match:
            file_name = Path(filename_match.group(1).replace("\\", "/")).name
            file_content = value
        else:
            fields[field_name] = value.decode("utf-8", errors="strict").strip()
    return fields, file_content, file_name


class SkillManager:
    """Manage trusted built-ins and untrusted user skill archives."""

    def __init__(
        self,
        db: Any,
        repo_root: str | Path | None = None,
        *,
        user_skills_dir: str | Path | None = None,
        builtin_dir: str | Path | None = None,
    ) -> None:
        self.db = db
        ensure_skill_schema(db)
        default_root = Path(__file__).resolve().parents[3]
        self.repo_root = Path(repo_root).resolve() if repo_root is not None else default_root
        self.builtin_dir = Path(builtin_dir).resolve() if builtin_dir is not None else self.repo_root / "skills"
        if user_skills_dir is not None:
            self.user_skills_dir = Path(user_skills_dir).resolve()
        elif self.repo_root.name == "wolf-dashboard":
            self.user_skills_dir = self.repo_root / "data" / "skills"
        else:
            self.user_skills_dir = self.repo_root / "wolf-dashboard" / "data" / "skills"
        if self.user_skills_dir.is_symlink():
            raise SkillValidationError("user skill data directory must not be a symbolic link")
        self.user_skills_dir.mkdir(parents=True, exist_ok=True)
        if self.user_skills_dir.is_symlink():
            raise SkillValidationError("user skill data directory must not be a symbolic link")
        self._lock = threading.RLock()

    def _connection(self) -> sqlite3.Connection:
        return _db_connection(self.db)

    def _row(self, skill_id: str) -> sqlite3.Row | None:
        connection = self._connection()
        return connection.execute("SELECT * FROM skills WHERE id=?", (skill_id,)).fetchone()

    @staticmethod
    def _record(row: Mapping[str, Any]) -> dict[str, Any]:
        def value(key: str, default: Any = None) -> Any:
            try:
                return row[key]
            except (KeyError, IndexError):
                return default

        metadata_raw = value("metadata_json", "{}")
        try:
            metadata = json.loads(str(metadata_raw or "{}"))
        except (TypeError, json.JSONDecodeError):
            metadata = {}
        return {
            "id": value("id", value("skill_id")),
            "skill_id": value("id", value("skill_id")),
            "name": value("name"),
            "version": value("version"),
            "description": value("description", ""),
            "scope": value("scope", ""),
            "applicable_scope": value("applicable_scope", ""),
            "source": value("source", "upload"),
            "builtin": bool(value("builtin", value("source", "upload") == "builtin")),
            "enabled": bool(value("enabled", 0)),
            "installed_at": value("installed_at", ""),
            "archive_sha256": value("archive_sha256"),
            "content_sha256": value("content_sha256", ""),
            "archive_name": value("archive_name", ""),
            "archive_size": int(value("archive_size", 0) or 0),
            "file_count": int(value("file_count", 0) or 0),
            "metadata": metadata,
        }

    def _insert_record(self, values: Mapping[str, Any]) -> None:
        connection = self._connection()
        connection.execute(
            """INSERT INTO skills(
                id,name,version,description,scope,applicable_scope,source,enabled,builtin,
                installed_at,archive_sha256,content_sha256,install_path,archive_name,
                archive_size,file_count,metadata_json,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                values["skill_id"],
                values["name"],
                values["version"],
                values["description"],
                values["scope"],
                values["applicable_scope"],
                values["source"],
                int(values.get("enabled", True)),
                int(values.get("builtin", values["source"] == "builtin")),
                values["installed_at"],
                values.get("archive_sha256") or "",
                values["content_sha256"],
                str(values["install_path"]),
                values.get("archive_name", ""),
                int(values.get("archive_size", 0)),
                int(values.get("file_count", 0)),
                json.dumps(values.get("metadata", {}), ensure_ascii=False, sort_keys=True),
                values.get("updated_at", values["installed_at"]),
            ),
        )

    def discover_builtins(self) -> list[dict[str, Any]]:
        """Discover public repository skills and persist their metadata."""

        with self._lock:
            if self.builtin_dir.is_symlink():
                raise SkillValidationError("built-in skill directory must not be a symbolic link")
            if not self.builtin_dir.exists():
                return []
            root_stat = _lstat_checked(self.builtin_dir, label="built-in skill directory")
            if not stat.S_ISDIR(root_stat.st_mode):
                raise SkillValidationError("built-in skill directory must be a directory")
            discovered: list[dict[str, Any]] = []
            connection = self._connection()
            for candidate in sorted(self.builtin_dir.iterdir(), key=lambda item: item.name):
                if candidate.name.startswith("."):
                    continue
                candidate_stat = _lstat_checked(candidate, label="built-in skill")
                if not stat.S_ISDIR(candidate_stat.st_mode):
                    continue
                if not (candidate / "SKILL.md").exists():
                    continue
                metadata = _metadata_from_root(candidate, default_version="0.1.0")
                if metadata["skill_id"] != candidate.name:
                    raise SkillValidationError(
                        f"built-in directory {candidate.name!r} does not match SKILL.md name"
                    )
                existing = self._row(metadata["skill_id"])
                if existing is not None and existing["source"] != "builtin":
                    raise SkillConflictError(
                        f"built-in skill name collides with uploaded skill: {metadata['skill_id']}"
                    )
                values = {
                    **metadata,
                    "source": "builtin",
                    "enabled": bool(existing["enabled"]) if existing else True,
                    "installed_at": existing["installed_at"] if existing else _utc_now(),
                    "archive_sha256": "",
                    "builtin": True,
                    "updated_at": _utc_now(),
                    "install_path": candidate,
                    "archive_name": "",
                    "archive_size": 0,
                }
                if existing is None:
                    self._insert_record(values)
                else:
                    connection.execute(
                        """UPDATE skills SET name=?,version=?,description=?,scope=?,
                        applicable_scope=?,content_sha256=?,install_path=?,file_count=?,metadata_json=?,builtin=1,updated_at=?
                        WHERE id=?""",
                        (
                            values["name"],
                            values["version"],
                            values["description"],
                            values["scope"],
                            values["applicable_scope"],
                            values["content_sha256"],
                            str(values["install_path"]),
                            values["file_count"],
                            json.dumps(values["metadata"], ensure_ascii=False, sort_keys=True),
                            _utc_now(),
                            metadata["skill_id"],
                        ),
                    )
                discovered.append(self._record(self._row(metadata["skill_id"])))  # type: ignore[arg-type]
            connection.commit()
            return discovered

    def list_skills(self) -> list[dict[str, Any]]:
        self.discover_builtins()
        connection = self._connection()
        rows = connection.execute("SELECT * FROM skills ORDER BY id").fetchall()
        return [self._record(row) for row in rows]

    def _require_row(self, skill_id: str) -> sqlite3.Row:
        _validate_skill_id(skill_id)
        self.discover_builtins()
        row = self._row(skill_id)
        if row is None:
            raise SkillNotFoundError(f"skill not found: {skill_id}")
        return row

    def enabled_summaries(self) -> list[dict[str, Any]]:
        summaries = []
        for record in self.list_skills():
            if record["enabled"]:
                # Summary data is sent to the sidecar, so do not expose a row
                # whose managed tree has been removed or modified locally.
                self._enabled_root(record["id"])
                summaries.append(
                    {
                        "id": record["id"],
                        "name": record["name"],
                        "version": record["version"],
                        "description": record["description"],
                        "scope": record["scope"],
                        "applicable_scope": record["applicable_scope"],
                        "source": record["source"],
                        "content_sha256": record["content_sha256"],
                    }
                )
        return summaries

    def enabled_summary(self, skill_id: str) -> dict[str, Any]:
        row, _ = self._enabled_root(skill_id)
        record = self._record(row)
        return {
            "id": record["id"],
            "name": record["name"],
            "version": record["version"],
            "description": record["description"],
            "scope": record["scope"],
            "applicable_scope": record["applicable_scope"],
            "source": record["source"],
            "content_sha256": record["content_sha256"],
        }

    # The longer name is convenient for sidecar integration and explicit in
    # the public API.
    get_enabled_skill_summaries = enabled_summaries
    list_enabled_summaries = enabled_summaries

    def install_archive(
        self,
        archive: bytes | bytearray | memoryview | BinaryIO | Path | str,
        *,
        filename: str = "upload.zip",
        skill_id: str | None = None,
        version: str | None = None,
    ) -> dict[str, Any]:
        if isinstance(archive, (str, Path)):
            archive_path = Path(archive)
            try:
                if archive_path.stat().st_size > MAX_UPLOAD_BYTES:
                    raise SkillArchiveTooLargeError("archive upload must be between 1 byte and 5 MiB")
            except FileNotFoundError as exc:
                raise SkillValidationError(f"archive does not exist: {archive_path}") from exc
            archive_data = archive_path.read_bytes()
        elif isinstance(archive, (bytes, bytearray, memoryview)):
            archive_data = bytes(archive)
        else:
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = archive.read(min(1024 * 1024, MAX_UPLOAD_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise SkillArchiveTooLargeError("archive upload must be between 1 byte and 5 MiB")
            archive_data = b"".join(chunks)
        if len(archive_data) <= 0 or len(archive_data) > MAX_UPLOAD_BYTES:
            raise SkillArchiveTooLargeError("archive upload must be between 1 byte and 5 MiB")
        filename = Path(str(filename).replace("\\", "/")).name
        lower_name = filename.lower()
        if not lower_name.endswith(_ARCHIVE_SUFFIXES):
            raise SkillUnsupportedArchiveError("only .zip, .tgz, and .tar.gz archives are supported")
        if version is not None:
            _version_tuple(version)
        if skill_id is not None:
            _validate_skill_id(skill_id)

        with self._lock:
            self.discover_builtins()
            stage_parent = Path(tempfile.mkdtemp(prefix=".skill-install-", dir=self.user_skills_dir))
            extracted = stage_parent / "extracted"
            extracted.mkdir()
            target: Path | None = None
            moved = False
            try:
                if lower_name.endswith(".zip"):
                    _extract_zip(archive_data, extracted)
                else:
                    _extract_tar(archive_data, extracted)
                _iter_files(extracted)
                skill_files = sorted(
                    path for path in extracted.rglob("SKILL.md")
                    if path.is_file() and not path.is_symlink()
                )
                if len(skill_files) != 1:
                    raise SkillValidationError("archive must contain exactly one SKILL.md")
                source_root = skill_files[0].parent
                # A package may be rooted at <id>/ or at its own extraction root,
                # but unrelated siblings are not accepted.
                for entry in extracted.iterdir():
                    if not _inside(source_root, entry):
                        raise SkillValidationError("archive contains files outside the skill root")
                metadata = _metadata_from_root(source_root, default_version=version or "0.1.0")
                if version is not None and metadata["version"] != version:
                    raise SkillValidationError("provided version does not match SKILL.md frontmatter")
                if skill_id is not None and metadata["skill_id"] != skill_id:
                    raise SkillValidationError("provided skill_id does not match SKILL.md frontmatter name")
                existing = self._row(metadata["skill_id"])
                if existing is not None:
                    incoming = _version_tuple(metadata["version"])
                    current = _version_tuple(str(existing["version"]))
                    if incoming < current:
                        raise SkillConflictError(
                            f"downgrade rejected for {metadata['skill_id']}: {metadata['version']} < {existing['version']}"
                        )
                    raise SkillConflictError(
                        f"skill name already installed: {metadata['skill_id']} (uninstall it before reinstalling)"
                    )
                target = self.user_skills_dir / metadata["skill_id"]
                target_stat = target.lstat() if target.exists() or target.is_symlink() else None
                if target_stat is not None:
                    if stat.S_ISLNK(target_stat.st_mode):
                        raise SkillValidationError("existing skill target must not be a symbolic link")
                    raise SkillConflictError(f"skill target already exists: {metadata['skill_id']}")
                payload = stage_parent / "payload"
                os.rename(source_root, payload)
                # The destination is checked immediately before the same-filesystem
                # rename; manager locking prevents concurrent installs in-process.
                if target.exists() or target.is_symlink():
                    raise SkillConflictError(f"skill target already exists: {metadata['skill_id']}")
                os.rename(payload, target)
                moved = True
                values = {
                    **metadata,
                    "source": "upload",
                    "enabled": True,
                    "builtin": False,
                    "installed_at": _utc_now(),
                    "archive_sha256": _sha256(archive_data),
                    "updated_at": _utc_now(),
                    "install_path": target,
                    "archive_name": filename,
                    "archive_size": len(archive_data),
                }
                try:
                    self._insert_record(values)
                    self._connection().commit()
                except Exception:
                    self._connection().rollback()
                    raise
                return self._record(self._row(metadata["skill_id"]))  # type: ignore[arg-type]
            except Exception:
                if moved and target is not None and target.exists() and not target.is_symlink():
                    shutil.rmtree(target, ignore_errors=True)
                raise
            finally:
                shutil.rmtree(stage_parent, ignore_errors=True)

    def set_enabled(self, skill_id: str, enabled: bool) -> dict[str, Any]:
        row = self._require_row(skill_id)
        if not isinstance(enabled, bool):
            raise SkillValidationError("enabled must be a boolean")
        connection = self._connection()
        connection.execute(
            "UPDATE skills SET enabled=?,updated_at=? WHERE id=?",
            (int(enabled), _utc_now(), skill_id),
        )
        connection.commit()
        return self._record(self._row(skill_id))  # type: ignore[arg-type]

    def uninstall(self, skill_id: str) -> dict[str, str]:
        row = self._require_row(skill_id)
        if row["source"] == "builtin":
            raise SkillConflictError("built-in skills can be disabled but not deleted")
        target = self._managed_path(row, source="upload")
        user_root = self.user_skills_dir
        if target == user_root:
            raise SkillValidationError("uploaded skill path is outside the user skill data directory")
        target_stat = _lstat_checked(target, label="uploaded skill")
        if not stat.S_ISDIR(target_stat.st_mode):
            raise SkillValidationError("uploaded skill installation is not a directory")
        with self._lock:
            shutil.rmtree(target)
            connection = self._connection()
            connection.execute("DELETE FROM skills WHERE id=?", (skill_id,))
            connection.commit()
        return {"id": skill_id, "skill_id": skill_id, "status": "uninstalled"}

    def _enabled_root(self, skill_id: str) -> tuple[sqlite3.Row, Path]:
        row = self._require_row(skill_id)
        if not bool(row["enabled"]):
            raise SkillConflictError(f"skill is disabled: {skill_id}")
        root = self._managed_path(row)
        root_stat = _lstat_checked(root, label="skill installation")
        if not stat.S_ISDIR(root_stat.st_mode):
            raise SkillValidationError("skill installation is not a directory")
        self._assert_content_integrity(skill_id, row=row, root=root)
        return row, root

    def _managed_path(self, row: sqlite3.Row, *, source: str | None = None) -> Path:
        """Resolve a persisted path without following the final symlink."""

        raw_path = str(row["install_path"] or "")
        candidate = Path(os.path.abspath(raw_path))
        allowed_roots = [self.builtin_dir, self.user_skills_dir]
        if source == "upload":
            allowed_roots = [self.user_skills_dir]
        if not any(_inside(parent, candidate) and candidate != parent for parent in allowed_roots):
            raise SkillValidationError("skill installation path is outside a managed directory")
        try:
            real_candidate = candidate.resolve(strict=False)
        except OSError as exc:
            raise SkillValidationError("skill installation path cannot be resolved") from exc
        if not any(_inside(parent, real_candidate) and real_candidate != parent for parent in allowed_roots):
            raise SkillValidationError("skill installation path resolves outside a managed directory")
        return candidate

    def _assert_content_integrity(
        self,
        skill_id: str,
        *,
        row: sqlite3.Row | None = None,
        root: Path | None = None,
    ) -> None:
        row = row or self._row(skill_id)
        if row is None:
            raise SkillNotFoundError(f"skill not found: {skill_id}")
        root = root or self._managed_path(row)
        content_sha256, _ = _content_hash(root)
        if row["content_sha256"] and content_sha256 != row["content_sha256"]:
            raise SkillValidationError(f"skill content hash mismatch: {skill_id}")

    def read_skill(self, skill_id: str) -> dict[str, Any]:
        row, root = self._enabled_root(skill_id)
        candidate = root / "SKILL.md"
        _safe_skill_path(root, candidate)
        content = candidate.read_text(encoding="utf-8")
        if len(content.encode("utf-8")) > MAX_REFERENCE_BYTES:
            raise SkillValidationError("SKILL.md exceeds the readable size limit")
        return {
            "skill_id": skill_id,
            "path": "SKILL.md",
            "content": content,
            "sha256": _sha256(content.encode("utf-8")),
            "version": row["version"],
        }

    # Sidecar-friendly alias.
    load_skill = read_skill
    read_skill_md = read_skill
    read_skill_markdown = read_skill

    def read_reference(self, skill_id: str, relative_path: str) -> dict[str, Any]:
        row, root = self._enabled_root(skill_id)
        safe_path = _safe_reference_path(relative_path)
        candidate = root / PurePosixPath(safe_path)
        _safe_skill_path(root, candidate)
        resource_stat = _lstat_checked(candidate, label="skill reference")
        if not stat.S_ISREG(resource_stat.st_mode):
            raise SkillValidationError("skill reference must be a regular file")
        if resource_stat.st_size > MAX_REFERENCE_BYTES:
            raise SkillValidationError("skill reference exceeds the readable size limit")
        try:
            content = candidate.read_text(encoding="utf-8")
        except UnicodeError as exc:
            raise SkillValidationError("skill reference must be UTF-8 Markdown") from exc
        return {
            "skill_id": skill_id,
            "path": safe_path,
            "content": content,
            "sha256": _sha256(content.encode("utf-8")),
            "version": row["version"],
        }

    read_reference_file = read_reference


def create_skill_manager(db: Any, settings: Any) -> SkillManager:
    """Build a manager from the existing ``Settings``-shaped object."""

    repo_root = Path(getattr(settings, "repo_root"))
    dashboard_root = Path(getattr(settings, "dashboard_root", repo_root / "wolf-dashboard"))
    user_skills_dir = getattr(settings, "skill_data_dir", dashboard_root / "data" / "skills")
    return SkillManager(db, repo_root=repo_root, user_skills_dir=user_skills_dir)


async def _read_request_body(request: Request) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BODY_BYTES:
                raise SkillArchiveTooLargeError("request body exceeds the upload limit")
        except ValueError as exc:
            raise SkillValidationError("content-length is invalid") from exc
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_REQUEST_BODY_BYTES:
            raise SkillArchiveTooLargeError("request body exceeds the upload limit")
        chunks.append(chunk)
    return b"".join(chunks)


async def _upload_from_request(request: Request) -> tuple[bytes, str, str | None, str | None]:
    body = await _read_request_body(request)
    content_type_header = request.headers.get("content-type", "")
    content_type = content_type_header.lower()
    fields: dict[str, str] = {}
    filename: str | None = None
    archive: bytes | None = None
    if content_type.startswith("multipart/form-data"):
        fields, archive, filename = _parse_multipart(body, content_type_header)
    elif content_type.startswith("application/json"):
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SkillValidationError("JSON install payload is invalid") from exc
        if not isinstance(payload, dict):
            raise SkillValidationError("JSON install payload must be an object")
        raw_archive = payload.get("archive_base64", payload.get("content_base64"))
        if not isinstance(raw_archive, str):
            raise SkillValidationError("JSON install payload requires archive_base64")
        try:
            archive = base64.b64decode(raw_archive, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise SkillValidationError("archive_base64 is invalid") from exc
        filename = str(payload.get("filename", "upload.zip"))
        fields = {
            key: str(payload[key])
            for key in ("skill_id", "version")
            if payload.get(key) is not None
        }
    else:
        archive = body
        filename = request.headers.get("x-filename") or request.query_params.get("filename") or "upload.zip"
        fields = {
            key: value
            for key in ("skill_id", "version")
            if (value := request.query_params.get(key)) is not None
        }
    if archive is None or not archive:
        raise SkillValidationError("install upload is empty")
    return archive, Path(str(filename or "upload.zip")).name, fields.get("skill_id"), fields.get("version")


def _http_error(error: SkillError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": str(error)},
    )


def create_skills_router(manager: SkillManager, *, prefix: str = "/api/v1/skills") -> APIRouter:
    """Return the skill API router for later mounting by ``app.main``."""

    router = APIRouter(prefix=prefix, tags=["skills"])

    @router.get("")
    async def list_skills() -> dict[str, Any]:
        try:
            items = manager.list_skills()
            return {"items": items, "count": len(items)}
        except SkillError as exc:
            raise _http_error(exc) from exc

    @router.get("/enabled")
    @router.get("/enabled/summary")
    @router.get("/enabled-summaries")
    @router.get("/manifest")
    async def enabled_skill_summaries() -> dict[str, Any]:
        try:
            items = manager.enabled_summaries()
            return {"items": items, "count": len(items)}
        except SkillError as exc:
            raise _http_error(exc) from exc

    @router.post("/install")
    async def install_skill(request: Request) -> dict[str, Any]:
        try:
            archive, filename, skill_id, version = await _upload_from_request(request)
            return manager.install_archive(
                archive,
                filename=filename,
                skill_id=skill_id,
                version=version,
            )
        except SkillError as exc:
            raise _http_error(exc) from exc

    @router.patch("/{skill_id}")
    async def update_skill(skill_id: str, request: Request) -> dict[str, Any]:
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail="PATCH payload must be JSON") from exc
        try:
            if not isinstance(payload, dict) or "enabled" not in payload:
                raise SkillValidationError("PATCH payload requires boolean enabled")
            return manager.set_enabled(skill_id, payload["enabled"])
        except SkillError as exc:
            raise _http_error(exc) from exc

    @router.delete("/{skill_id}")
    async def delete_skill(skill_id: str) -> dict[str, str]:
        try:
            return manager.uninstall(skill_id)
        except SkillError as exc:
            raise _http_error(exc) from exc

    @router.get("/{skill_id}/SKILL.md")
    @router.get("/{skill_id}/skill-md")
    async def read_skill_markdown(skill_id: str) -> dict[str, Any]:
        try:
            return manager.read_skill(skill_id)
        except SkillError as exc:
            raise _http_error(exc) from exc

    @router.get("/{skill_id}/reference")
    async def read_skill_reference(skill_id: str, path: str) -> dict[str, Any]:
        try:
            return manager.read_reference(skill_id, path)
        except SkillError as exc:
            raise _http_error(exc) from exc

    @router.get("/{skill_id}/references/{reference_path:path}")
    async def read_skill_reference_path(skill_id: str, reference_path: str) -> dict[str, Any]:
        try:
            return manager.read_reference(skill_id, f"references/{reference_path}")
        except SkillError as exc:
            raise _http_error(exc) from exc

    return router


def create_skill_router(manager: SkillManager, *, prefix: str = "/api/v1/skills") -> APIRouter:
    """Singular-name compatibility alias for integration callers."""

    return create_skills_router(manager, prefix=prefix)


get_skills_router = create_skills_router
SkillService = SkillManager


__all__ = [
    "MAX_ARCHIVE_ENTRIES",
    "MAX_EXTRACTED_FILE_BYTES",
    "MAX_EXTRACTED_TOTAL_BYTES",
    "MAX_REFERENCE_BYTES",
    "MAX_REQUEST_BODY_BYTES",
    "MAX_UPLOAD_BYTES",
    "SkillArchiveTooLargeError",
    "SkillConflictError",
    "SkillError",
    "SkillManager",
    "SkillService",
    "SkillNotFoundError",
    "SkillUnsupportedArchiveError",
    "SkillValidationError",
    "create_skills_router",
    "create_skill_router",
    "create_skill_manager",
    "ensure_skill_schema",
    "get_skills_router",
]
