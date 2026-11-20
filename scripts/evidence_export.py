#!/usr/bin/env python3
"""Export catalog-listed evidence and persisted decisions for one version (stdlib only).

python scripts/evidence_export.py --root REVIEW --asset ID --stage STAGE \
    --version 1 --output /outside/review/evidence.zip
python scripts/evidence_export.py --verify /outside/review/evidence.zip

ZIP members retain root-relative items/ID/STAGE/vNNN paths. manifest.json records
their sorted paths, byte counts and SHA-256 hashes of the actual archived bytes.
The selected review.json and direct comments/<person>.json documents are included
unchanged: owner verdicts remain separate from adviser open/adopted/dismissed
statuses, with their stored IDs, attribution and document revisions. No adoption
is inferred from prose or verdicts. Decision documents share the file/byte limits
and hashes; absent documents are omitted. The manifest adds suggestion_links:
factual adopted/dismissed IDs, owner-note statuses and later catalog
resolves/responses through the selected version. Missing links remain unresolved;
these records never verify visual quality or create implementation tasks.
Dismissal reasons are retained. Linkage metadata is limited to 1,000 files/entries/
rows and 8 MiB; the complete serialized manifest (including JSON escaping and
repeated linkage fields) shares the verifier's 8 MiB ceiling. No raw catalog,
derived review files, attachments or other operational state is copied. Decision
directories have a separate 2,000-entry scan limit, including ignored names. The
output must be new and outside the review root; no source files are modified.
Publication is atomic after ZIP/manifest validation and fsync. Default limits
are 1,000 evidence files and 1 GiB total evidence bytes, adjustable via CLI flags.
Secure publication uses Linux unnamed temporary files or exclusive Windows
handles. Unsupported filesystems/platforms fail closed without a final bundle.
Verification reads archive members without extracting or modifying files. Hashes
prove consistency with the bundled manifest, not authorship or legal provenance.
Verification also caps the ZIP index at 8 MiB and each entry's name/extra/comment
metadata at 4 KiB, before Python constructs the archive index.
Only fixed-size ZIP64 end records are supported, keeping preflight and Python's
ZIP parser on the same directory across supported Python versions.
"""

import argparse
import contextlib
import errno
import hashlib
# R3C-097 begin
import io
# R3C-097 end
import json
import lzma
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import struct
import uuid
import zipfile
import zlib


MAX_FILES = 1000
MAX_DECISION_ENTRIES = 2000
MAX_BYTES = 1 << 30
MAX_CATALOG_BYTES = 8 << 20
MAX_ZIP_INDEX_BYTES = 8 << 20
MAX_ZIP_METADATA_BYTES = 4 << 10
MEMBER_READ_ERRORS = (zipfile.BadZipFile, RuntimeError, NotImplementedError,
                      zlib.error, OSError, lzma.LZMAError)
SOURCE_DIR_FD = os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW")
REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


# Operational/mutable names are forbidden even if a catalog mistakenly lists
# them under a version. Logs submitted as deliverables (e.g. runtime.log) remain
# eligible; this is deliberately not a blanket ban on .log or .json evidence.
RESERVED = frozenset({
    "catalog.json", ".server.json", ".server.log", ".remote.json", ".lock",
    ".scanner.json", ".scanner.log", "projects.json", "registry.json",
    "registry", "registry.jsonl", "people.json", "worker.json", "worker.log",
    "worker-log", "worker-log.txt", "worker-log.log", ".remote.log",
    "autopilot.json", "autopilot.jsonl", "vocab.json", ".render-jobs",
    ".studio-slots", "studio", ".voice", "voice", "comments", "crops",
    "parts", "renders", "review.json", "review.md", "review-thumb.png",
    "events.jsonl", "render-queue.json", "render-input.json",
})
WINDOWS_DEVICES = frozenset({"con", "prn", "aux", "nul"} | {
    prefix + str(n) for prefix in ("com", "lpt") for n in range(1, 10)
})


def archive_name(name):
    """Portable path syntax, independent of catalog evidence eligibility."""
    if not isinstance(name, str) or not name or PureWindowsPath(name).drive:
        raise ValueError("invalid evidence path")
    parts = name.split("/")
    for part in parts:
        if (not part or part in (".", "..") or part != part.rstrip(" .")
                or any(ord(c) < 32 or c in '<>:"\\|?*' for c in part)
                or part.lower().split(".")[0] in WINDOWS_DEVICES):
            raise ValueError("invalid evidence path: " + name)
    return name


def evidence_name(name):
    """Reject escapes, Windows aliases and reserved state before any file read."""
    archive_name(name)
    for part in name.split("/"):
        if part.lower() in RESERVED:
            raise ValueError("reserved operational evidence path: " + name)
    return name


def no_symlinks(path):
    # Check ancestors too: an ordinary file below a linked directory is unsafe.
    for component in (*reversed(path.parents), path):
        info = component.lstat()
        if stat.S_ISLNK(info.st_mode) or is_reparse(info):
            raise ValueError("symlinks are not allowed: " + str(component))


def is_reparse(info):
    return bool(getattr(info, "st_file_attributes", 0) & REPARSE_POINT)


def same_identity(left, right):
    # An unavailable identity is not sufficient to establish confinement.
    return bool(left.st_ino and right.st_ino
                and (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino))


def checked_file(root, relative):
    path = root / relative
    no_symlinks(path)
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise ValueError("evidence path is outside the selected root")
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or is_reparse(info):
        raise ValueError("evidence must be a regular file: " + relative)
    return path, info


def open_directory_fd(path):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
    directory = os.open(path.anchor, flags)
    try:
        for component in path.parts[1:]:
            child = os.open(component, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        return directory
    except BaseException:
        os.close(directory)
        raise


def open_source_fd(path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    if SOURCE_DIR_FD:
        # Anchor each component with a directory fd so a directory swapped for
        # a symlink after validation cannot redirect a read outside the root.
        directory = open_directory_fd(path.parent)
        try:
            fd = os.open(path.name, flags | os.O_NONBLOCK, dir_fd=directory)
        finally:
            os.close(directory)
    else:
        fd = os.open(path, flags)
    return fd


def open_source(root, relative):
    path, expected = checked_file(root, relative)
    fd = open_source_fd(path)
    try:
        opened = os.fstat(fd)
        if (not stat.S_ISREG(opened.st_mode) or is_reparse(opened)
                or not same_identity(expected, opened)):
            raise ValueError("source identity changed before read")
        no_symlinks(path)
        if (not path.resolve(strict=True).is_relative_to(root)
                or not same_identity(expected, path.lstat())):
            raise ValueError("source path changed or is outside the selected root")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


@contextlib.contextmanager
def windows_directory_locks(path):
    """Pin every destination ancestor with no-delete-sharing native handles."""
    import ctypes
    from ctypes import wintypes

    class FileInfo(ctypes.Structure):
        _fields_ = [("attributes", wintypes.DWORD), ("created", wintypes.FILETIME),
                    ("accessed", wintypes.FILETIME), ("written", wintypes.FILETIME),
                    ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
                    ("size_low", wintypes.DWORD), ("links", wintypes.DWORD),
                    ("index_high", wintypes.DWORD), ("index_low", wintypes.DWORD)]

    class FileIdInfo(ctypes.Structure):
        _fields_ = [("volume", ctypes.c_ulonglong), ("id", ctypes.c_ubyte * 16)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                       wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    get_info = kernel.GetFileInformationByHandle
    get_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(FileInfo)]
    get_info.restype = wintypes.BOOL
    get_id = kernel.GetFileInformationByHandleEx
    get_id.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    get_id.restype = wintypes.BOOL
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    handles = []
    try:
        for component in (*reversed(path.parents), path):
            expected = component.lstat()
            # READ_ATTRIBUTES, SHARE_READ|WRITE (no DELETE), OPEN_EXISTING,
            # BACKUP_SEMANTICS|OPEN_REPARSE_POINT: never follow a junction.
            handle = create(str(component), 0x80, 3, None, 3, 0x02200000, None)
            if handle == wintypes.HANDLE(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
            handles.append(handle)
            info, identity = FileInfo(), FileIdInfo()
            if (not get_info(handle, ctypes.byref(info))
                    or not get_id(handle, 18, ctypes.byref(identity), ctypes.sizeof(identity))):
                raise ctypes.WinError(ctypes.get_last_error())
            if (info.attributes & REPARSE_POINT or not info.attributes & 0x10
                    # Windows stat implementations expose either the basic
                    # 32-bit volume serial or FileIdInfo's 64-bit volume serial.
                    or expected.st_dev not in (info.volume, identity.volume)
                    or expected.st_ino != int.from_bytes(identity.id, "little")
                    or not same_identity(expected, component.lstat())):
                raise ValueError("destination directory identity changed or is a reparse point")
        yield
    finally:
        for handle in reversed(handles):
            close(handle)


class WindowsStagingFile:
    """Exclusive writable handle; rename and deletion address that owned handle.

    With a held directory handle the file is created relative to it, so no
    pathname is traversed and the entry can only land in that directory.
    """

    def __init__(self, path, directory_handle=None):
        import ctypes
        from ctypes import wintypes
        import msvcrt

        self.ctypes, self.published = ctypes, False
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        create = kernel.CreateFileW
        create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                           wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        create.restype = wintypes.HANDLE
        self.set_info = kernel.SetFileInformationByHandle
        self.set_info.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
        self.set_info.restype = wintypes.BOOL
        close = kernel.CloseHandle
        close.argtypes, close.restype = [wintypes.HANDLE], wintypes.BOOL
        # GENERIC_READ|WRITE|DELETE, share NONE, CREATE_NEW. Other opens cannot
        # read/write/delete or rename the staging inode until our handle closes.
        if directory_handle is None:
            self.handle = create(str(path), 0xC0010000, 0, None, 1, 0x100, None)
            if self.handle == wintypes.HANDLE(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            self.handle = self.create_relative(directory_handle, Path(path).name)
        try:
            self.fd = msvcrt.open_osfhandle(self.handle, os.O_RDWR | getattr(os, "O_BINARY", 0))
        except BaseException:
            close(self.handle)
            raise

    @staticmethod
    def create_relative(directory_handle, name):
        """NtCreateFile(FILE_CREATE) of one new leaf under an already open directory."""
        import ctypes
        from ctypes import wintypes

        if not name or "\\" in name or "/" in name or ":" in name:
            raise ValueError("staging name must be a single path component")

        class UnicodeString(ctypes.Structure):
            _fields_ = [("length", ctypes.c_ushort), ("maximum", ctypes.c_ushort),
                        ("buffer", ctypes.c_wchar_p)]

        class ObjectAttributes(ctypes.Structure):
            _fields_ = [("length", ctypes.c_ulong), ("root", wintypes.HANDLE),
                        ("name", ctypes.POINTER(UnicodeString)), ("attributes", ctypes.c_ulong),
                        ("descriptor", ctypes.c_void_p), ("quality", ctypes.c_void_p)]

        class StatusBlock(ctypes.Structure):
            _fields_ = [("status", ctypes.c_void_p), ("information", ctypes.c_size_t)]

        ntdll = ctypes.WinDLL("ntdll")
        create = ntdll.NtCreateFile
        create.argtypes = [ctypes.POINTER(wintypes.HANDLE), ctypes.c_ulong,
                           ctypes.POINTER(ObjectAttributes), ctypes.POINTER(StatusBlock),
                           ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
                           ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong]
        create.restype = ctypes.c_long
        to_dos = ntdll.RtlNtStatusToDosError
        to_dos.argtypes, to_dos.restype = [ctypes.c_long], ctypes.c_ulong
        text = UnicodeString(len(name) * 2, len(name) * 2 + 2, name)
        attributes = ObjectAttributes(ctypes.sizeof(ObjectAttributes), directory_handle,
                                      ctypes.pointer(text), 0x40, None, None)  # OBJ_CASE_INSENSITIVE
        handle, block = wintypes.HANDLE(), StatusBlock()
        # GENERIC_READ|WRITE|DELETE|SYNCHRONIZE, temporary attribute, share NONE,
        # FILE_CREATE, FILE_NON_DIRECTORY_FILE|SYNCHRONOUS_IO_NONALERT|OPEN_REPARSE_POINT.
        status = create(ctypes.byref(handle), 0xC0110000, ctypes.byref(attributes),
                        ctypes.byref(block), None, 0x100, 0, 2, 0x00200060, None, 0)
        if status < 0:
            raise ctypes.WinError(to_dos(status))
        return handle.value

    def publish(self, output, replace=False):
        ctypes = self.ctypes

        class RenameInfo(ctypes.Structure):
            _fields_ = [("replace", ctypes.c_ubyte), ("root", ctypes.c_void_p),
                        ("length", ctypes.c_uint32), ("name", ctypes.c_uint16 * 1)]

        encoded = str(output).encode("utf-16-le")
        size = RenameInfo.name.offset + len(encoded)
        buffer = ctypes.create_string_buffer(max(size + 2, ctypes.sizeof(RenameInfo)))
        info = ctypes.cast(buffer, ctypes.POINTER(RenameInfo)).contents
        info.replace, info.root, info.length = int(replace), None, len(encoded)
        ctypes.memmove(ctypes.addressof(buffer) + RenameInfo.name.offset, encoded, len(encoded))
        # FileRenameInfo on the owned handle. Export remains no-clobber. This works
        # with our open file; no pathname rename over open files is attempted.
        if not self.set_info(self.handle, 3, buffer, size):
            raise ctypes.WinError(ctypes.get_last_error())
        self.published = True

    def close(self):
        try:
            if not self.published:
                delete = self.ctypes.c_ubyte(1)
                # FileDispositionInfo deletes this handle's inode on close,
                # never a pathname that could now name someone else's file.
                if not self.set_info(self.handle, 4, self.ctypes.byref(delete), 1):
                    raise self.ctypes.WinError(self.ctypes.get_last_error())
        finally:
            os.close(self.fd)


def link_owned_fd(fd, directory_fd, final):
    """Publish the unnamed Linux inode, not a mutable staging directory entry."""
    import ctypes

    link = ctypes.CDLL(None, use_errno=True).linkat
    link.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    link.restype = ctypes.c_int
    name = os.fsencode(final)
    if link(fd, b"", directory_fd, name, 0x1000) == 0:  # AT_EMPTY_PATH
        return
    error = ctypes.get_errno()
    if error in (errno.EPERM, errno.ENOENT):
        # Unprivileged kernels may require the documented descriptor alias.
        # This is our known fd, not a scanned directory or staging pathname.
        alias = os.fsencode("/proc/self/fd/%d" % fd)
        if link(-100, alias, directory_fd, name, 0x400) == 0:  # AT_SYMLINK_FOLLOW
            return
        error = ctypes.get_errno()
    raise OSError(error, os.strerror(error), final)


class StagingFile:
    """Own a staging inode through validation, publication and cleanup."""

    def __init__(self, directory):
        directory.check()
        self.directory, self.windows = directory, None
        if os.name == "nt":
            self.windows = WindowsStagingFile(directory.path / (".evidence-%s.tmp" % uuid.uuid4().hex))
            self.fd = self.windows.fd
        else:
            if not hasattr(os, "O_TMPFILE"):
                raise ValueError("secure staging requires unnamed temporary-file support")
            try:
                self.fd = os.open(".", os.O_RDWR | os.O_TMPFILE, 0o600, dir_fd=directory.fd)
            except OSError as exc:
                if exc.errno in (errno.EOPNOTSUPP, errno.EINVAL, errno.EISDIR):
                    raise ValueError("filesystem does not support secure unnamed staging") from exc
                raise

    def __enter__(self):
        return self

    def __exit__(self, *args):
        if self.windows is not None:
            self.windows.close()
        else:
            # An unpublished anonymous inode disappears at close. There is no
            # check/unlink interval and no foreign pathname to delete.
            os.close(self.fd)

    def open(self):
        # Retain our owning handle even when the buffered writer is closed.
        return os.fdopen(os.dup(self.fd), "w+b")

    def publish(self, final, replace=False):
        self.directory.check()
        if self.windows is not None:
            self.windows.publish(self.directory.path / final, replace=replace)
        else:
            if replace:
                raise ValueError('POSIX catalog replacement requires a private, descriptor-anchored rename source')
            link_owned_fd(self.fd, self.directory.fd, final)


class DestinationDirectory:
    """Fixed directory for creation, no-clobber publication and owned cleanup."""

    def __init__(self, path, root):
        self.path, self.root, self.fd = path, root, None
        self.locks = contextlib.ExitStack()

    def __enter__(self):
        try:
            no_symlinks(self.path)
            self.expected = self.path.lstat()
            if not stat.S_ISDIR(self.expected.st_mode):
                raise ValueError("output parent must be a directory")
            if os.name == "nt":
                self.locks.enter_context(windows_directory_locks(self.path))
            else:
                self.fd = open_directory_fd(self.path)
                if not same_identity(self.expected, os.fstat(self.fd)):
                    raise ValueError("destination directory identity changed")
            self.check()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *args):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        self.locks.close()

    def check(self):
        no_symlinks(self.path)
        if (not same_identity(self.expected, self.path.lstat())
                or self.path.resolve(strict=True).is_relative_to(self.root)):
            raise ValueError("destination directory changed or is inside the review root")

    def entry(self, name):
        return name if self.fd is not None else self.path / name

    def options(self):
        return {"dir_fd": self.fd} if self.fd is not None else {}

    def info(self, name):
        return os.stat(self.entry(name), follow_symlinks=False, **self.options())

    def create_temp(self):
        return StagingFile(self)

    def sync(self):
        if self.fd is not None:
            try:
                os.fsync(self.fd)
            except OSError as exc:
                if exc.errno not in (errno.EINVAL, errno.ENOTSUP):
                    raise


def validate_bundle(destination, manifest):
    destination.seek(0)
    with zipfile.ZipFile(destination, "r") as bundle:
        if bundle.getinfo("manifest.json").file_size > MAX_CATALOG_BYTES:
            raise ValueError("bundle manifest exceeds maximum byte count")
        # ZipFile.read is bounded by the checked member size. Preserve this
        # validation boundary, including the existing corruption fault probes.
        data = bundle.read("manifest.json")
        if len(data) > MAX_CATALOG_BYTES:
            raise ValueError("bundle manifest exceeds maximum byte count")
        if bundle.testzip() is not None:
            raise ValueError("bundle ZIP integrity check failed")
        if (bundle.namelist() != [row["path"] for row in manifest["files"]] + ["manifest.json"]
                or json.loads(data) != manifest):
            raise ValueError("bundle manifest check failed")
        for row in manifest["files"]:
            verify_member(bundle, row)
        # R3C-097 begin
        verify_suggestion_statuses(bundle, manifest)
        # R3C-097 end


def verify_member(bundle, row):
    digest, size = hashlib.sha256(), 0
    try:
        with bundle.open(row["path"]) as member:
            while chunk := member.read(1 << 20):
                size += len(chunk)
                if size > row["bytes"]:
                    raise ValueError("bundle manifest byte count check failed: " + row["path"])
                digest.update(chunk)
    except MEMBER_READ_ERRORS as exc:
        raise ValueError("cannot read bundle member: " + row["path"]) from exc
    if size != row["bytes"] or digest.hexdigest() != row["sha256"]:
        raise ValueError("bundle manifest hash/byte count check failed: " + row["path"])


# R3C-097 begin
def verify_suggestion_statuses(bundle, manifest):
    """Compare selected-version links with bounded, hash-verified comment bytes.

    Historical links have no archived source documents, so only the selected
    version's decided suggestions can be checked against bundled comments.
    """
    # Q202: pre-linkage exports share this schema and have only byte integrity
    # to verify. A present projection, even an empty one, must still agree.
    if "suggestion_links" not in manifest:
        return
    links = manifest["suggestion_links"]
    if not isinstance(links, list):
        raise ValueError("invalid suggestion links")
    if len(links) > MAX_FILES:
        raise ValueError("suggestion linkage metadata row limit exceeded")
    selected = []
    for link in links:
        if (not isinstance(link, dict) or type(link.get("version")) is not int
                or not 1 <= link["version"] <= manifest["version"]
                or not isinstance(link.get("person"), str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,80}", link["person"])
                or not isinstance(link.get("suggestion_id"), str) or not link["suggestion_id"]
                or link.get("status") not in ("adopted", "dismissed")):
            raise ValueError("invalid suggestion links")
        if link["version"] == manifest["version"]:
            selected.append((link["person"], link["suggestion_id"], link["status"]))

    prefix = "items/%s/%s/v%03d/comments/" % (
        manifest["asset"], manifest["stage"], manifest["version"])
    archived = []
    byte_count = row_count = 0
    for row in manifest["files"]:
        if not row["path"].startswith(prefix):
            continue
        remaining = MAX_CATALOG_BYTES - byte_count
        if row["bytes"] > remaining:
            raise ValueError("suggestion linkage metadata byte limit exceeded")
        try:
            with bundle.open(row["path"]) as source:
                data = source.read(remaining + 1)
        except MEMBER_READ_ERRORS as exc:
            raise ValueError("cannot read bundle member: " + row["path"]) from exc
        byte_count += len(data)
        if byte_count > MAX_CATALOG_BYTES:
            raise ValueError("suggestion linkage metadata byte limit exceeded")
        document = json.loads(data)
        if not isinstance(document, dict):
            raise ValueError("suggestion linkage document must be an object")
        comments = document.get("comments", [])
        if (not isinstance(comments, list)
                or any(not isinstance(comment, dict) for comment in comments)):
            raise ValueError("suggestions must be a list of objects")
        row_count += len(comments)
        if row_count > MAX_FILES:
            raise ValueError("suggestion linkage metadata row limit exceeded")
        person = row["path"][len(prefix):-5]
        for comment in comments:
            if comment.get("status") not in ("adopted", "dismissed"):
                continue
            identity = comment.get("id")
            if not isinstance(identity, str) or not identity:
                raise ValueError("suggestion must have an ID")
            archived.append((person, identity, comment["status"]))
    if sorted(selected) != sorted(archived):
        raise ValueError("bundle suggestion link status check failed")
# R3C-097 end


def preflight_zip_index(source, max_files):
    """Bound footer reads and scan fixed directory headers before ZipInfo allocation."""
    source.seek(0, os.SEEK_END)
    length = source.tell()

    def read_at(offset, size):
        if offset < 0 or offset + size > length:
            raise zipfile.BadZipFile("invalid ZIP index bounds")
        source.seek(offset)
        data = source.read(size)
        if len(data) != size:
            raise zipfile.BadZipFile("truncated ZIP index")
        return data

    if length < 22:
        raise zipfile.BadZipFile("File is not a zip file")
    end = length - 22
    footer = read_at(end, 22)
    if footer[:4] != b"PK\x05\x06" or footer[-2:] != b"\0\0":
        start = max(0, length - (65535 + 22))
        tail = read_at(start, length - start)
        position = tail.rfind(b"PK\x05\x06")
        if position < 0 or len(tail) - position < 22:
            raise zipfile.BadZipFile("File is not a zip file")
        end = start + position
        footer = tail[position:position + 22]
    _, disk, directory_disk, count_disk, count, size, offset, comment = struct.unpack(
        "<4s4H2LH", footer)
    if end + 22 + comment != length:
        raise zipfile.BadZipFile("invalid ZIP footer/comment bounds")
    locator = read_at(end - 20, 20) if end >= 20 else b""
    if locator[:4] == b"PK\x06\x07":
        _, locator_disk, record_offset, disks = struct.unpack("<4sLQL", locator)
        if locator_disk != 0 or disks != 1:
            raise zipfile.BadZipFile("multi-disk ZIPs are not supported")
        record = read_at(record_offset, 56)
        (signature, record_size, _, _, disk, directory_disk, count_disk,
         count, size, offset) = struct.unpack("<4sQ2H2L4Q", record)
        if signature != b"PK\x06\x06" or record_size < 44:
            raise zipfile.BadZipFile("invalid ZIP64 index record")
        if record_size - 44 > MAX_ZIP_METADATA_BYTES:
            raise ValueError("ZIP64 index metadata exceeds maximum byte count")
        if record_size != 44:
            # Older Python parsers read exactly 56 bytes before the locator;
            # extensible records can make them consume a different directory.
            raise ValueError("ZIP64 extensible records are unsupported")
        if record_offset + 12 + record_size != end - 20:
            raise zipfile.BadZipFile("invalid ZIP64 index bounds")
        end = record_offset
    elif count == 0xffff or size == 0xffffffff or offset == 0xffffffff:
        raise zipfile.BadZipFile("missing ZIP64 index record")
    if disk != 0 or directory_disk != 0 or count_disk != count:
        raise zipfile.BadZipFile("multi-disk ZIPs are not supported")
    if count > max_files + 1:
        raise ValueError("evidence file count exceeds maximum of %d" % max_files)
    if size > MAX_ZIP_INDEX_BYTES:
        raise ValueError("ZIP index exceeds maximum byte count")
    if offset + size != end:
        raise zipfile.BadZipFile("invalid ZIP directory bounds")
    position, actual = offset, 0
    while position < end:
        if actual >= max_files + 1:
            raise ValueError("evidence file count exceeds maximum of %d" % max_files)
        if end - position < 46:
            raise zipfile.BadZipFile("truncated ZIP directory header")
        header = struct.unpack("<4s6H3L5H2L", read_at(position, 46))
        if header[0] != b"PK\x01\x02" or header[13] != 0:
            raise zipfile.BadZipFile("invalid ZIP directory header")
        metadata = sum(header[10:13])
        if metadata > MAX_ZIP_METADATA_BYTES:
            raise ValueError("ZIP member metadata exceeds maximum byte count")
        position += 46 + metadata
        actual += 1
    if position != end or actual != count:
        raise zipfile.BadZipFile("ZIP directory entry count/size mismatch")
    source.seek(0)


def bundle_member_name(name, prefix):
    """Only the selected owner and direct adviser paths bypass reserved names."""
    archive_name(name)
    if name == prefix + "review.json":
        return name
    if name.startswith(prefix + "comments/") and re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\.json", name[len(prefix + "comments/"):]):
        return name
    return evidence_name(name)


def verify_bundle(path, *, max_files=MAX_FILES, max_bytes=MAX_BYTES):
    """Check the embedded manifest and every declared byte, without extraction."""
    if type(max_files) is not int or max_files < 1:
        raise ValueError("max-files must be a positive integer")
    if type(max_bytes) is not int or max_bytes < 0:
        raise ValueError("max-bytes must be a nonnegative integer")
    with open(path, "rb") as source:
        preflight_zip_index(source, max_files)
        return _verify_archive(source, max_files, max_bytes)


def _verify_archive(source, max_files, max_bytes):
    with zipfile.ZipFile(source, "r") as bundle:
        if len(bundle.infolist()) > max_files + 1:
            raise ValueError("evidence file count exceeds maximum of %d" % max_files)
        members = {}
        aliases = set()
        for info in bundle.infolist():
            name = archive_name(info.orig_filename)
            if name.casefold() in aliases:
                raise ValueError("duplicate bundle member: " + name)
            aliases.add(name.casefold())
            members[name] = info
        if "manifest.json" not in members:
            raise ValueError("missing bundle member: manifest.json")
        if members["manifest.json"].file_size > MAX_CATALOG_BYTES:
            raise ValueError("bundle manifest exceeds maximum byte count")
        try:
            with bundle.open("manifest.json") as source:
                data = source.read(MAX_CATALOG_BYTES + 1)
        except MEMBER_READ_ERRORS as exc:
            raise ValueError("cannot read bundle member: manifest.json") from exc
        if len(data) > MAX_CATALOG_BYTES:
            raise ValueError("bundle manifest exceeds maximum byte count")
        manifest = json.loads(data)
        if (not isinstance(manifest, dict)
                or manifest.get("schema") != "asset-review/evidence-export-1"
                or not isinstance(manifest.get("files"), list)):
            raise ValueError("invalid bundle manifest")
        for key in ("asset", "stage"):
            selector = manifest.get(key)
            if not isinstance(selector, str) or not re.fullmatch(
                    r"[A-Za-z0-9][A-Za-z0-9_.-]{0,80}", selector):
                raise ValueError("invalid bundle manifest " + key)
            evidence_name(selector)
        version = manifest.get("version")
        if type(version) is not int or not 1 <= version <= 999:
            raise ValueError("invalid bundle manifest version")
        prefix = "items/%s/%s/v%03d/" % (manifest["asset"], manifest["stage"], version)
        if len(manifest["files"]) > max_files:
            raise ValueError("evidence file count exceeds maximum of %d" % max_files)
        declared, aliases, total = set(), set(), 0
        for row in manifest["files"]:
            if not isinstance(row, dict):
                raise ValueError("invalid bundle manifest file entry")
            name = bundle_member_name(row.get("path"), prefix)
            if not name.startswith(prefix):
                raise ValueError("bundle member outside selected version: " + name)
            if name.casefold() in aliases:
                raise ValueError("duplicate manifest member: " + name)
            aliases.add(name.casefold())
            declared.add(name)
            if (type(row.get("bytes")) is not int or row["bytes"] < 0
                    or not isinstance(row.get("sha256"), str)
                    or not re.fullmatch(r"[0-9a-f]{64}", row["sha256"])):
                raise ValueError("invalid bundle manifest hash/byte count: " + name)
            if name not in members:
                raise ValueError("missing bundle member: " + name)
            total += row["bytes"]
            if total > max_bytes:
                raise ValueError("total evidence bytes exceed maximum of %d" % max_bytes)
            if members[name].file_size != row["bytes"]:
                raise ValueError("bundle manifest byte count check failed: " + name)
        extras = set(members) - declared - {"manifest.json"}
        if extras:
            raise ValueError("undeclared bundle member: " + sorted(extras)[0])
        for row in manifest["files"]:
            verify_member(bundle, row)
        # R3C-097 begin
        verify_suggestion_statuses(bundle, manifest)
        # R3C-097 end
    return manifest


def zip_info(name):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    return info


def serialize_manifest(manifest):
    """Bound actual JSON bytes, including structure, escaping and final newline."""
    data = bytearray()
    encoder = json.JSONEncoder(sort_keys=True, indent=2)
    for chunk in encoder.iterencode(manifest):
        encoded = chunk.encode("utf-8")
        if len(data) + len(encoded) + 1 > MAX_CATALOG_BYTES:
            raise ValueError("bundle manifest exceeds maximum byte count")
        data.extend(encoded)
    data.extend(b"\n")
    return bytes(data)


# R3C-097 begin
def suggestion_target(comment):
    """Bind a comment ID to its source file and content, including target.hash."""
    target = comment.get("target")
    view = comment.get("view")
    origin = view.get("asset") if isinstance(view, dict) else None
    filename = target.get("file") if isinstance(target, dict) else None
    digest = target.get("hash") if isinstance(target, dict) else None
    if not digest and isinstance(origin, dict):
        digest = origin.get("hash")
    return {"file": filename if isinstance(filename, str) else None,
            "hash": digest if isinstance(digest, str) else None}


def suggestion_links(root, asset, stage, version, versions, *, snapshot=None):
    """Project explicit IDs/statuses through this version, never implementation tasks.

    These are recorded cross references, not verification of a visual change.
    Missing/ambiguous owner notes remain unresolved. Dismissals stay dismissals
    even if an owner note's ``from`` happens to reference them.
    """
    byte_count = file_count = row_count = response_count = response_bytes = 0
    selected_prefix = "items/%s/%s/v%03d/" % (asset, stage, version)

    def read_document(relative):
        nonlocal byte_count, file_count
        try:
            source = open_source(root, relative)
        except FileNotFoundError:
            return {}
        with source:
            file_count += 1
            if file_count > MAX_FILES:
                raise ValueError("suggestion linkage metadata file limit exceeded")
            data = source.read(MAX_CATALOG_BYTES - byte_count + 1)
        byte_count += len(data)
        if byte_count > MAX_CATALOG_BYTES:
            raise ValueError("suggestion linkage metadata byte limit exceeded")
        doc = json.loads(data)
        if not isinstance(doc, dict):
            raise ValueError("suggestion linkage document must be an object")
        # Retain the exact selected decision bytes within the existing linkage
        # budget. Publication must not reread a newer revision of these files.
        if snapshot is not None and relative.startswith(selected_prefix):
            snapshot[relative] = data
        return doc

    def people(prefix):
        path = root / prefix / "comments"
        try:
            no_symlinks(path)
        except FileNotFoundError:
            return []
        # Pin the directory while listing, using the same confinement as reads.
        fd = open_directory_fd(path) if SOURCE_DIR_FD else None
        names = []
        try:
            with os.scandir(fd if fd is not None else path) as entries:
                for count, entry in enumerate(entries, 1):
                    if count > MAX_FILES:
                        raise ValueError("suggestion linkage directory entry limit exceeded")
                    if entry.name.endswith(".json"):
                        person = entry.name[:-5]
                        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,80}", person):
                            raise ValueError("invalid suggestion person ID")
                        names.append(person)
        finally:
            if fd is not None:
                os.close(fd)
        return sorted(names)

    history = sorted((row for row in versions
                      if type(row.get("v")) is int and 1 <= row["v"] <= version),
                     key=lambda row: row["v"])
    if len({row["v"] for row in history}) != len(history):
        raise ValueError("ambiguous suggestion linkage version")
    links = []
    for row in history:
        source_version = row["v"]
        prefix = "items/%s/%s/v%03d/" % (asset, stage, source_version)
        authors = people(prefix)
        if not authors:
            continue
        notes = read_document(prefix + "review.json").get("notes", [])
        if not isinstance(notes, list) or any(not isinstance(n, dict) for n in notes):
            raise ValueError("owner notes must be a list of objects")
        row_count += len(notes)
        if row_count > MAX_FILES:
            raise ValueError("suggestion linkage metadata row limit exceeded")
        for person in authors:
            comments = read_document(prefix + "comments/" + person + ".json").get("comments", [])
            if (not isinstance(comments, list)
                    or any(not isinstance(c, dict) for c in comments)):
                raise ValueError("suggestions must be a list of objects")
            row_count += len(comments)
            if row_count > MAX_FILES:
                raise ValueError("suggestion linkage metadata row limit exceeded")
            for comment in sorted(comments, key=lambda c: str(c.get("id", ""))):
                status = comment.get("status")
                if status not in ("adopted", "dismissed"):
                    continue
                identity = comment.get("id")
                if not isinstance(identity, str) or not identity:
                    raise ValueError("suggestion must have an ID")
                adopted_as = comment.get("adopted_as") if status == "adopted" else None
                if adopted_as is not None and not isinstance(adopted_as, str):
                    raise ValueError("adopted_as must be a note ID or null")
                candidates = []
                for note in notes:
                    origin = note.get("from")
                    same_origin = (isinstance(origin, dict)
                                   and origin.get("person") == person
                                   and origin.get("id") == identity)
                    if (isinstance(note.get("id"), str) and note["id"]
                            and ((adopted_as and note["id"] == adopted_as
                                  and (origin is None or same_origin))
                                 or (not adopted_as and same_origin))):
                        candidates.append(note)
                owner = candidates[0] if len(candidates) == 1 else None
                responses = []
                if owner is not None:
                    for later in history:
                        if later["v"] <= source_version:
                            continue
                        resolves = later.get("resolves", [])
                        texts = later.get("responses", {})
                        if not isinstance(resolves, list) or not isinstance(texts, dict):
                            raise ValueError("invalid version resolves/responses")
                        # Bare N IDs belong to the immediately preceding version,
                        # matching the viewer's delta-banner cross-reference rule.
                        # Older notes require vN:ID so reused N IDs cannot mislink.
                        refs = ["v%d:%s" % (source_version, owner["id"])]
                        if later["v"] == source_version + 1:
                            refs.append(owner["id"])
                        claimed = any(ref in resolves for ref in refs)
                        response_ref = next((ref for ref in refs if ref in texts), None)
                        if claimed or response_ref is not None:
                            response = texts.get(response_ref)
                            response_count += 1
                            response_bytes += len(response.encode("utf-8")) if isinstance(response, str) else 0
                            if response_count > MAX_FILES or response_bytes > MAX_CATALOG_BYTES:
                                raise ValueError("suggestion linkage response limit exceeded")
                            responses.append({"version": later["v"], "resolves": claimed,
                                              "response": response if isinstance(response, str) else None})
                missing = (["owner_note"] if owner is None else [])
                if not responses:
                    missing.append("version_response")
                elif not any(r["response"] for r in responses):
                    missing.append("response_text")
                links.append({"version": source_version, "person": person,
                              "suggestion_id": identity, "status": status,
                              "source_target": suggestion_target(comment),
                              "adopted_as": adopted_as,
                              "reason": (comment.get("reason") if status == "dismissed"
                                         and isinstance(comment.get("reason"), str) else None),
                              "owner_note": ({k: owner[k] for k in ("id", "status", "verdict")
                                              if isinstance(owner.get(k), str)} if owner is not None else None),
                              "version_responses": responses,
                              "linkage_status": "unresolved" if missing else "linked",
                              "unresolved_links": missing})
    return links
# R3C-097 end


def decision_paths(root, prefix, max_files):
    """Allow only the selected owner document and direct adviser documents."""
    paths = []
    try:
        (root / prefix / "review.json").lstat()
    except FileNotFoundError:
        pass
    else:
        paths.append(prefix + "review.json")
    comments = root / prefix / "comments"
    try:
        info = comments.lstat()
    except FileNotFoundError:
        return paths
    no_symlinks(comments)
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError("comments must be a directory")
    # Pin the directory while enumerating on platforms with descriptor support.
    # All returned paths still pass checked_file/open_source before any read.
    fd = open_directory_fd(comments) if SOURCE_DIR_FD else None
    try:
        with os.scandir(fd if fd is not None else comments) as entries:
            for examined, entry in enumerate(entries, 1):
                if examined > MAX_DECISION_ENTRIES:
                    raise ValueError("decision directory entry count exceeds maximum of %d"
                                     % MAX_DECISION_ENTRIES)
                if not entry.name.endswith(".json"):
                    continue
                if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\.json", entry.name)
                        or entry.name.lower().split(".")[0] in WINDOWS_DEVICES):
                    raise ValueError("invalid adviser document path")
                paths.append(prefix + "comments/" + entry.name)
                if len(paths) > max_files:
                    raise ValueError("evidence file count exceeds maximum of %d" % max_files)
    finally:
        if fd is not None:
            os.close(fd)
    return paths


def export_version(root, asset, stage, version, output, *,
                   max_files=MAX_FILES, max_bytes=MAX_BYTES):
    """Validate the complete allowlist, then write a new deterministic bundle."""
    for selector in (asset, stage):
        if not isinstance(selector, str) or not re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9_.-]{0,80}", selector):
            raise ValueError("invalid asset or stage")
        evidence_name(selector)
    if type(version) is not int or not 1 <= version <= 999:
        raise ValueError("version must be an integer from 1 to 999")
    if type(max_files) is not int or max_files < 1:
        raise ValueError("max-files must be a positive integer")
    if type(max_bytes) is not int or max_bytes < 0:
        raise ValueError("max-bytes must be a nonnegative integer")
    root = Path(root).absolute()
    no_symlinks(root)
    root = root.resolve(strict=True)
    output = Path(output).absolute()
    if output.resolve().is_relative_to(root):
        raise ValueError("output must be outside the selected review root")
    evidence_name(output.name)

    with open_source(root, "catalog.json") as source:
        data = source.read(MAX_CATALOG_BYTES + 1)
        if len(data) > MAX_CATALOG_BYTES:
            raise ValueError("catalog exceeds maximum of %d bytes" % MAX_CATALOG_BYTES)
        catalog = json.loads(data)
    try:
        versions = catalog["assets"][asset]["stages"][stage]["versions"]
        selected = [row for row in versions
                    if type(row.get("v")) is int and row["v"] == version]
        if len(selected) != 1:
            raise ValueError("selected version must have exactly one catalog entry")
        files = selected[0]["files"]
        if not isinstance(files, list):
            raise ValueError("catalog files must be a list")
        if len(files) > max_files:
            raise ValueError("evidence file count exceeds maximum of %d" % max_files)
        names = [evidence_name(row["name"]) for row in files]
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError("invalid catalog or unknown asset/stage/version") from exc
    prefix = "items/%s/%s/v%03d/" % (asset, stage, version)
    paths = [prefix + name for name in names]
    paths += decision_paths(root, prefix, max_files)
    if len(paths) > max_files:
        raise ValueError("evidence file count exceeds maximum of %d" % max_files)
    # ZIPs must also unpack unambiguously on case-insensitive filesystems.
    if len({path.casefold() for path in paths}) != len(paths):
        raise ValueError("duplicate evidence paths")
    paths.sort()
    total = 0
    for path in paths:
        _, info = checked_file(root, path)
        total += info.st_size
        if total > max_bytes:
            raise ValueError("total evidence bytes exceed maximum of %d" % max_bytes)

    # R3C-097 begin
    snapshot = {}
    manifest = {"schema": "asset-review/evidence-export-1", "asset": asset,
                "stage": stage, "version": version, "files": [],
                "suggestion_links": suggestion_links(
                    root, asset, stage, version, versions, snapshot=snapshot)}
    # Q205: listings and bounded reads must describe the same selected files.
    # An owner/adviser document appearing or disappearing in between requires
    # a fresh export rather than publishing links to an unarchived document.
    selected_comments = {path for path in paths if path.startswith(prefix + "comments/")}
    selected_comments |= {prefix + "review.json"} & set(paths) if selected_comments else set()
    if not set(snapshot).issubset(paths) or not selected_comments.issubset(snapshot):
        raise ValueError("evidence changed during export; retry")
    # R3C-097 end
    # Linux staging has no pathname. Windows holds a share-NONE writable/delete
    # handle through native rename/disposition. Neither publishes or cleans up
    # by resolving a staging pathname after a separate ownership check.
    with DestinationDirectory(output.parent, root) as directory:
        try:
            directory.info(output.name)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError("output already exists: " + str(output))
        with directory.create_temp() as staging:
            with staging.open() as destination:
                total = 0
                with zipfile.ZipFile(destination, "w") as bundle:
                    for path in paths:
                        digest = hashlib.sha256()
                        size = 0
                        # R3C-097 begin
                        reader = (io.BytesIO(snapshot[path]) if path in snapshot
                                  else open_source(root, path))
                        with reader as source, bundle.open(
                                zip_info(path), "w") as member:
                            while chunk := source.read(1 << 20):
                                total += len(chunk)
                                if total > max_bytes:
                                    raise ValueError("total evidence bytes exceed maximum of %d" % max_bytes)
                                member.write(chunk)
                                digest.update(chunk)
                                size += len(chunk)
                        manifest["files"].append({"path": path, "bytes": size,
                                                  "sha256": digest.hexdigest()})
                        # R3C-097 end
                    data = serialize_manifest(manifest)
                    bundle.writestr(zip_info("manifest.json"), data)
                destination.flush()
                validate_bundle(destination, manifest)
                os.fsync(destination.fileno())
                staging.publish(output.name)
                directory.sync()
        directory.sync()
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--verify", metavar="BUNDLE", help="verify an existing bundle read-only")
    parser.add_argument("--root")
    parser.add_argument("--asset")
    parser.add_argument("--stage")
    parser.add_argument("--version", type=int)
    parser.add_argument("--output")
    parser.add_argument("--max-files", type=int, default=MAX_FILES,
                        help="maximum evidence file count (default: %(default)s)")
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES,
                        help="maximum total evidence bytes (default: %(default)s)")
    args = parser.parse_args(argv)
    export_args = (args.root, args.asset, args.stage, args.version, args.output)
    if args.verify is not None:
        if any(value is not None for value in export_args):
            parser.error("--verify cannot be combined with export arguments")
    elif any(value is None for value in export_args):
        parser.error("export requires --root, --asset, --stage, --version and --output")
    try:
        if args.verify is not None:
            manifest = verify_bundle(args.verify, max_files=args.max_files, max_bytes=args.max_bytes)
            print("Verified %d evidence files in %s; consistency only, not authorship or legal provenance"
                  % (len(manifest["files"]), args.verify))
            return 0
        manifest = export_version(args.root, args.asset, args.stage,
                                  args.version, args.output,
                                  max_files=args.max_files, max_bytes=args.max_bytes)
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError, NotImplementedError, zlib.error) as exc:
        parser.exit(1, "ERROR: %s\n" % exc)
    print("Exported %d evidence files to %s" % (len(manifest["files"]), args.output))
    return 0


# R3C-054 begin
class SheetDirectory(DestinationDirectory):
    # There is no review root here: retain directory identity and no-clobber
    # publication without pretending an output file is a review directory.
    def check(self):
        no_symlinks(self.path)
        if not same_identity(self.expected, self.path.lstat()):
            raise ValueError("destination directory changed")


def export_before_after(before, after, output, *, max_files=MAX_FILES, max_bytes=MAX_BYTES):
    """One offline sheet from two existing bundles; never capture or read a review root.

    Select decisions saved on the before version; IDs are local to that version.
    Bind each before target to its saved review identity, then pair its filename
    with the after manifest's verified delivery. Missing targets stay missing.
    Refuse decisions that disagree with the after linkage snapshot.
    """
    import base64
    from html import escape

    if type(max_files) is not int or max_files < 1:
        raise ValueError("max-files must be a positive integer")
    if type(max_bytes) is not int or max_bytes < 0:
        raise ValueError("max-bytes must be a nonnegative integer")
    limit = min(max_bytes, MAX_CATALOG_BYTES)
    used = 0
    with contextlib.ExitStack() as stack:
        exports = []
        for path in (before, after):
            path = Path(path).absolute()
            no_symlinks(path)
            path = path.resolve(strict=True)
            source = stack.enter_context(open_source(path.parent, path.name))
            preflight_zip_index(source, max_files)
            manifest = _verify_archive(source, max_files, max_bytes)
            archive = stack.enter_context(zipfile.ZipFile(source))
            exports.append((manifest, archive, {r["path"]: r for r in manifest["files"]}, {}))
        old, new = (e[0] for e in exports)
        if (any(old[k] != new[k] for k in ("asset", "stage"))
                or old["version"] >= new["version"]):
            raise ValueError("invalid bundle manifest version")

        def read(index, name):
            nonlocal used
            manifest, archive, files, cache = exports[index]
            if name not in files:
                return None
            if name not in cache:
                row = files[name]
                if row["bytes"] > limit - used:
                    raise ValueError("total evidence bytes exceed maximum of %d" % limit)
                with archive.open(name) as member:
                    data = member.read(limit - used + 1)
                if (len(data) != row["bytes"]
                        or hashlib.sha256(data).hexdigest() != row["sha256"]):
                    raise ValueError("bundle manifest hash/byte count check failed: " + name)
                used += len(data)
                cache[name] = data
            return cache[name]

        documents = {}

        def comment(index, link):
            key = (index, link["person"])
            if key not in documents:
                manifest = exports[index][0]
                prefix = "items/%s/%s/v%03d/" % tuple(manifest[k] for k in ("asset", "stage", "version"))
                name = prefix + "comments/" + link["person"] + ".json"
                bundle_member_name(name, prefix)
                data = read(index, name)
                rows = {}
                if data is not None:
                    doc = json.loads(data)
                    if (not isinstance(doc, dict) or type(doc.get("version")) is not int
                            or any(doc.get(k) != manifest[k] for k in ("asset", "stage", "version"))
                            or doc.get("person") != link["person"]):
                        raise ValueError("bundle member outside selected version: " + name)
                    comments = doc.get("comments", [])
                    if not isinstance(comments, list) or any(not isinstance(c, dict) for c in comments):
                        raise ValueError("suggestions must be a list of objects")
                    for row in comments:
                        identity = row.get("id")
                        if not isinstance(identity, str) or not identity:
                            raise ValueError("suggestion must have an ID")
                        if identity in rows:
                            raise ValueError("duplicate suggestion ID: " + identity)
                        rows[identity] = row
                documents[key] = rows
            return documents[key].get(link["suggestion_id"])

        parts = ['<!doctype html><html lang="en"><meta charset="utf-8">',
                 '<meta name="viewport" content="width=device-width, initial-scale=1">',
                 '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
                 'img-src data:; style-src \'unsafe-inline\'">',
                 '<style>img{max-width:100%;height:auto}figcaption{overflow-wrap:anywhere}</style>',
                 '<title>Before / after</title><body><h1>Before / after</h1>']
        links = new.get("suggestion_links", [])
        if not isinstance(links, list):
            raise ValueError("invalid suggestion linkage document")
        if len(links) > MAX_FILES:
            raise ValueError("suggestion linkage metadata row limit exceeded")
        if any(not isinstance(r, dict) for r in links):
            raise ValueError("invalid suggestion linkage document")
        decisions = []
        for link in links:
            if link.get("version") != old["version"]:
                continue
            if (not isinstance(link.get("person"), str)
                    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,80}", link["person"])
                    or not isinstance(link.get("suggestion_id"), str) or not link["suggestion_id"]):
                raise ValueError("suggestion must have an ID")
            saved = comment(0, link)
            if saved is None:
                raise ValueError("The export of the before version is missing suggestion %s from %s; "
                                 "export the before version again" % (link["suggestion_id"], link["person"]))
            status = saved.get("status")
            field = "reason" if status == "dismissed" else "adopted_as"
            value = saved.get(field)
            if (link.get("status") != status
                    or link.get(field) != (value if isinstance(value, str) else None)
                    or ("source_target" in link
                        and link["source_target"] != suggestion_target(saved))):
                raise ValueError("The export of the before version is older than the link in the after version; "
                                 "export the before version again")
            decisions.append((link, saved))
        for status, description in (("adopted", "accepted"), ("dismissed", "declined")):
            candidates = [row for row in decisions if row[1].get("status") == status]
            if not candidates:
                raise ValueError("missing adopted/dismissed suggestion")
            link, saved = candidates[0]
            target = saved.get("target", {})
            view = saved.get("view") or {}
            if not isinstance(view, dict):
                raise ValueError("invalid suggestion linkage document")
            origin = view.get("asset") or {}
            if not isinstance(target, dict) or not isinstance(origin, dict):
                raise ValueError("invalid suggestion linkage document")
            filename = target.get("file")
            digest = target.get("hash") or origin.get("hash")
            parts.append('<section><h2>' + escape(link["suggestion_id"]) +
                         '</h2><p class="status" data-status="' + status + '">' +
                         description + ' (' + status + ')</p>')
            for index, label in enumerate(("before", "after")):
                manifest, _, files, _ = exports[index]
                prefix = "items/%s/%s/v%03d/" % tuple(manifest[k] for k in ("asset", "stage", "version"))
                image = None
                if isinstance(filename, str) and Path(filename).suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
                    name = prefix + evidence_name(filename)
                    image = read(index, name)
                    if image is not None:
                        if index == 0 and (digest != files[name]["sha256"]
                                or origin.get("hash", digest) != digest
                                or origin and (type(origin.get("version")) is not int or any(
                                    origin.get(k) != manifest[m] for k, m in
                                    (("id", "asset"), ("stage", "stage"), ("version", "version"))))):
                            raise ValueError("bundle manifest hash/byte count check failed: " + name)
                        mime = ("image/png" if image.startswith(b"\x89PNG\r\n\x1a\n") else
                                "image/jpeg" if image.startswith(b"\xff\xd8\xff") else
                                "image/webp" if image[:4] == b"RIFF" and image[8:12] == b"WEBP" else None)
                        if mime is None:
                            raise ValueError("invalid evidence path: " + name)
                caption = label + ' · v%d' % manifest["version"]
                parts.append('<figure><figcaption>' + caption)
                if image is not None:
                    parts.append(' · ' + files[name]["sha256"])
                parts.append('</figcaption>')
                parts.append('<img alt="' + escape(label + ' · ' + link["suggestion_id"] +
                                                  ' · v%d' % manifest["version"], quote=True) +
                             '" src="data:' + mime + ';base64,' +
                             base64.b64encode(image).decode("ascii") + '">' if image is not None
                             else '<p class="missing">not included</p>')
                parts.append('</figure>')
            parts.append('</section>')
        data = (''.join(parts) + '</body></html>\n').encode("utf-8")
        if len(data) > limit:
            raise ValueError("total evidence bytes exceed maximum of %d" % limit)
    output = Path(output).absolute()
    evidence_name(output.name)
    with SheetDirectory(output.parent, None) as directory:
        with directory.create_temp() as staging:
            with staging.open() as destination:
                destination.write(data)
                destination.flush()
                os.fsync(destination.fileno())
                staging.publish(output.name)
                directory.sync()
    return output


_version_export_main = main


def main(argv=None):
    import sys
    argv = sys.argv[1:] if argv is None else argv
    if "--before-after" not in argv:
        if "--help" in argv or "-h" in argv:
            print("Companion sheet: --before-after BEFORE_ZIP AFTER_ZIP --output SHEET_HTML")
        return _version_export_main(argv)
    parser = argparse.ArgumentParser(description="Offline sheet from two existing evidence exports")
    parser.add_argument("--before-after", nargs=2, required=True, metavar=("BEFORE_ZIP", "AFTER_ZIP"))
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-files", type=int, default=MAX_FILES)
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES)
    args = parser.parse_args(argv)
    if args.max_files < 1 or args.max_bytes < 0:
        parser.error("invalid evidence limits")
    try:
        output = export_before_after(*args.before_after, args.output,
                                     max_files=args.max_files, max_bytes=args.max_bytes)
    except (OSError, ValueError, zipfile.BadZipFile, *MEMBER_READ_ERRORS) as exc:
        parser.exit(1, "ERROR: %s\n" % exc)
    print("Exported before/after sheet to %s" % output)
    return 0
# R3C-054 end


if __name__ == "__main__":
    raise SystemExit(main())
