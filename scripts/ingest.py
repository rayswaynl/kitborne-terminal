#!/usr/bin/env python3
"""Resume verified package copies and recover idempotent package publication.

Usage: python scripts/ingest.py --root REVIEW --manifest PACKAGE/manifest.json
       python scripts/ingest.py PACKAGE.zip --root REVIEW --asset ID --stage STAGE
Manifest: {"package_id": "local-id", "asset": "sample", "stage": "brief",
           "files": ["a.txt", "sub/b.txt"], "meta": {...}}
Files are relative to the manifest, with unique basenames. Optional submit fields
(name, note, route, project, by, resolves, response, thread, choice, skip_gate,
skip_render, build_id, phone_clients, claim_players) pass through to review.
Identity binds file hashes, metadata (including provenance/stricter flags), submit
options and destination. Source labels/URIs are recorded, never fetched.
Journals live at ROOT/.ingest/SHA256(package_id)/journal.json. Root-local commit intents
repair interrupted catalog/event publication under the review root lock.
Limits: 1 MiB per manifest/policy/journal JSON, 256 files, 1 GiB aggregate payload.
Submission retains Windows sharing guards or Linux mandatory read leases until
catalog publication; unavailable protection fails closed. Linux requires the main thread.
ZIP/package input shares these publication guards and idempotent recovery. ZIP names,
types and local/central metadata validate before extraction; actual sizes, ratio
and CRC validate while streaming. ZIP64/encrypted/other compression fails closed.
"""

import argparse
import binascii
import contextlib
from contextlib import nullcontext, redirect_stdout
import ctypes
import hashlib
import json
import math
import os
import re
from pathlib import Path, PurePosixPath, PureWindowsPath
import stat
import signal
import struct
import sys
import tempfile
import threading
import time
import uuid
import zipfile
import zlib

from evidence_export import open_directory_fd

import review

# R3C-111 begin
from review_queue import QueueFull, require_slot
# R3C-111 end

# Bound parsing and copying before allocating a version or staging payload.
MAX_JSON_BYTES = 1024 * 1024
MAX_FILES = 256
MAX_PACKAGE_BYTES = 1024 * 1024 * 1024
EVENT_HEADROOM = 64 * 1024  # room for the new row, so a refusal always precedes publication
SUBMIT_COPY_LOCK = threading.RLock()
COPY_OWNER = threading.local()
REPARSE_POINT = getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)
DEVICES = {'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'} | {
    prefix + digit for prefix in ('COM', 'LPT') for digit in '123456789¹²³'}


class IngestError(ValueError):
    """Invalid package, conflicting identity or unsafe replay."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def reject_reparse(path):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if (stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & REPARSE_POINT or
            getattr(os.path, 'isjunction', lambda _: False)(path)):
        raise IngestError('symlink/junction/reparse point is not allowed: ' + str(path))


def checked_path(base, path):
    """Check ancestors without resolving away evidence of links/reparse points."""
    base, path = Path(os.path.abspath(base)), Path(os.path.abspath(path))
    if not path.is_relative_to(base):
        raise IngestError('path escapes its containment root: ' + str(path))
    for ancestor in (*reversed(path.parents), path):
        reject_reparse(ancestor)
    if not path.resolve().is_relative_to(base.resolve()):
        raise IngestError('path escapes its canonical containment root: ' + str(path))
    return path


def check_open_file(stream, path, base):
    checked_path(base, path)
    info = os.fstat(stream.fileno())
    if (not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & REPARSE_POINT or
            not os.path.samestat(info, os.lstat(path))):
        raise IngestError('file was substituted or is not a regular file: ' + str(path))


@contextlib.contextmanager
def open_checked(path, base):
    checked_path(base, path)
    with confined_io() as io_:
        with os.fdopen(io_.open_fd(Path(path), os.O_RDONLY), 'rb') as stream:
            check_open_file(stream, path, base)
            yield stream
            check_open_file(stream, path, base)



def chunks(stream, path, base, limit):
    total = 0
    while True:
        check_open_file(stream, path, base)
        block = stream.read(min(1024 * 1024, limit - total + 1))
        total += len(block)
        if total > limit:
            raise IngestError('aggregate package bytes exceed limit')
        if not block:
            break
        yield block


def stream_hash(stream, path, base, limit):
    sha = hashlib.sha256()
    for block in chunks(stream, path, base, limit):
        sha.update(block)
    return sha.hexdigest()


def file_hash(path, base=None, limit=None):
    base = Path(path).parent if base is None else base
    limit = MAX_PACKAGE_BYTES if limit is None else limit
    with open_checked(path, base) as stream:
        return stream_hash(stream, path, base, limit)


def staging_matches(path, base, expected, size):
    with open_checked(path, base) as stream:
        # Reject altered lengths before reading, including oversized stale copies.
        if os.fstat(stream.fileno()).st_size != size:
            return False
        return stream_hash(stream, path, base, size) == expected


def read_json(path, base, kind):
    with open_checked(path, base) as stream:
        raw = stream.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            raise IngestError('%s JSON exceeds %d-byte limit' % (kind, MAX_JSON_BYTES))
    return json.loads(raw.decode('utf-8'))


def label(value):
    return isinstance(value, str) and bool(value.strip())


def local_path(base, relative):
    """Apply Windows component rules on every OS, before joining anything."""
    if (not isinstance(relative, str) or not relative or '\\' in relative or
            any(char in relative for char in '<>:"|?*') or
            any(ord(char) < 32 for char in relative)):
        raise IngestError('invalid relative file path')
    parts = relative.split('/')
    windows = PureWindowsPath(relative)
    if (windows.drive or windows.root or PurePosixPath(relative).is_absolute() or
            any(p in ('', '.', '..') or p.endswith(('.', ' ')) or
                p.split('.')[0].rstrip(' .').upper() in DEVICES for p in parts)):
        raise IngestError('invalid relative file path: ' + relative)
    return checked_path(base, Path(base).joinpath(*parts))


def atomic_json(path, value):
    """Flush and replace through a pinned parent, never an unchecked alias."""
    path = Path(path)
    checked_path(path.parent, path)
    payload = canonical(value) + b'\n'
    if len(payload) > MAX_JSON_BYTES:
        raise IngestError('journal JSON exceeds %d-byte limit' % MAX_JSON_BYTES)
    with confined_io() as io_:
        fd, temporary = io_.temporary_file(path.parent, '.journal-')
        try:
            with os.fdopen(fd, 'wb') as stream:
                check_open_file(stream, temporary, path.parent)
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            io_.replace(temporary, path)
        finally:
            if Path(temporary).exists():
                io_.unlink(temporary)


def _copy_verified(source, target, expected, source_root, target_root, limit):
    checked_path(source_root, source)
    checked_path(target_root, target)
    make_directory(target.parent)
    checked_path(target_root, target)
    owner = getattr(COPY_OWNER, 'current', None)
    # Downstream copies already have an exclusively reserved final directory.
    # Create their final names exclusively too: no guarded object or ancestor
    # needs a rename after verification (which Windows directory guards deny).
    if owner is not None:
        temporary = str(target)
        fd = active_io().open_fd(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    else:
        fd, temporary = active_io().temporary_file(target.parent, '.copy-')
    held = None
    verified = False
    try:
        with os.fdopen(fd, 'wb') as output, open_checked(source, source_root) as input_:
            copy_bytes(input_, output, source, temporary, source_root, target_root, limit)
            output.flush()
            os.fsync(output.fileno())
        if owner is not None:
            held = owner.hold_file(Path(temporary))
            actual = protected_hash(held, limit)
        else:
            actual = file_hash(temporary, target_root, limit)
        if actual != expected:
            raise IngestError('source changed while copying: ' + str(source))
        checked_path(target_root, temporary)
        checked_path(target_root, target)
        if held is None:
            active_io().replace(temporary, target)
        else:
            # This is the very object review consumes and the catalog names.
            # Keep its write/delete-denying guard until the transaction exits.
            owner.outputs[target.name] = (held, expected, limit)
        verified = True
    finally:
        if not verified and os.path.exists(temporary):
            if held is not None:
                held.close()
            # The Windows transaction's READ-only directory guard still denies
            # child deletion here. Its rollback removes the owned reservation
            # after closing those guards, with the parent identity still held.
            if owner is None or owner.kernel is None:
                active_io().unlink(checked_path(target_root, temporary))


def copy_bytes(input_, output, source, temporary, source_root, target_root, limit):
    for block in chunks(input_, source, source_root, limit):
        check_open_file(output, temporary, target_root)
        output.write(block)


def copy_verified(source, target, expected, *, source_root, target_root, limit):
    """Materialize one verified staging file; snapshots use the same I/O checks."""
    with confined_io():
        _copy_verified(source, target, expected, source_root, target_root, limit)


@contextlib.contextmanager
def submission_snapshot(work, hashes, sizes, staging_name='files'):
    staging = local_path(work, staging_name)
    checked_path(work, work)
    with active_io().temporary_directory(work, '.submission-') as temporary:
        snapshot = checked_path(work, temporary)
        files = []
        for relative, sha in hashes.items():
            source = local_path(staging, relative)
            if not staging_matches(source, staging, sha, sizes[relative]):
                raise IngestError('staged file changed before submit: ' + relative)
            target = local_path(snapshot, PurePosixPath(relative).name)
            _copy_verified(source, target, sha, staging, snapshot, sizes[relative])
            files.append(str(target))
        # Verify the exact paths review.submit will read, after all snapshot copies.
        for path, relative in zip(files, hashes):
            if file_hash(path, snapshot, sizes[relative]) != hashes[relative]:
                raise IngestError('submission snapshot changed before submit')
        yield files


class WindowsKernel:
    """Win32 write/delete-denying guards, held through catalog publication."""
    READ, SHARE_READ, SHARE_WRITE = 0x80000000, 1, 2

    def __init__(self):
        from ctypes import wintypes as w
        self.w = w
        self.dll = ctypes.WinDLL('kernel32', use_last_error=True)
        signatures = {
            'CreateFileW': ([w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE], w.HANDLE),
            'CloseHandle': ([w.HANDLE], w.BOOL),
            'GetCurrentProcess': ([], w.HANDLE),
            'DuplicateHandle': ([w.HANDLE, w.HANDLE, w.HANDLE, ctypes.POINTER(w.HANDLE), w.DWORD, w.BOOL, w.DWORD], w.BOOL),
            'OpenFileById': ([w.HANDLE, w.LPVOID, w.DWORD, w.DWORD, w.LPVOID, w.DWORD], w.HANDLE),
            'GetFinalPathNameByHandleW': ([w.HANDLE, w.LPWSTR, w.DWORD, w.DWORD], w.DWORD),
            'SetFileInformationByHandle': ([w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD], w.BOOL),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.dll, name)
            function.argtypes, function.restype = args, result
        class Info(ctypes.Structure):
            _fields_ = [('attributes', w.DWORD), ('created', w.FILETIME),
                        ('accessed', w.FILETIME), ('written', w.FILETIME),
                        ('volume', w.DWORD), ('size_high', w.DWORD), ('size_low', w.DWORD),
                        ('links', w.DWORD), ('index_high', w.DWORD), ('index_low', w.DWORD)]
        self.Info = Info
        self.dll.GetFileInformationByHandle.argtypes = [w.HANDLE, ctypes.POINTER(Info)]
        self.dll.GetFileInformationByHandle.restype = w.BOOL

    @staticmethod
    def native_path(path):
        path = str(Path(path).absolute())
        return '\\\\?\\UNC\\' + path[2:] if path.startswith('\\\\') else '\\\\?\\' + path

    def open(self, path, *, directory=False, share=1, access=None):
        # Metadata-only directory handles do not participate in sharing checks.
        # GENERIC_READ includes FILE_LIST_DIRECTORY, so ancestry is pinned too.
        access = self.READ if access is None else access
        flags = 0x00200000 | (0x02000000 if directory else 0)  # open reparse object; backup semantics
        handle = self.dll.CreateFileW(self.native_path(path), access, share, None, 3, flags, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            info = self.info(handle)
            if info.attributes & REPARSE_POINT:
                raise IngestError('protected object is a reparse point')
            return handle
        except BaseException:
            self.close(handle)
            raise

    def info(self, handle):
        info = self.Info()
        if not self.dll.GetFileInformationByHandle(handle, ctypes.byref(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        return info

    def identity(self, handle):
        info = self.info(handle)
        return info.volume, (info.index_high << 32) | info.index_low

    def open_identity(self, hint, identity, *, access=0, share=7):
        # Keep a metadata handle alive across sharing transitions so this file
        # ID cannot be reused. OpenFileById selects the object, never its alias.
        class FileId(ctypes.Structure):
            _fields_ = [('size', self.w.DWORD), ('kind', self.w.DWORD),
                        ('index', ctypes.c_uint64), ('reserved', ctypes.c_uint64)]
        identifier = FileId(ctypes.sizeof(FileId), 0, identity[1], 0)
        deleting = bool(access & 0x10000)
        handle = self.dll.OpenFileById(hint, ctypes.byref(identifier), 0 if deleting else access,
                                     7 if deleting else share, None,
                                     0x00200000 | 0x02000000)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if self.identity(handle) != identity or self.info(handle).attributes & REPARSE_POINT:
                raise IngestError('cleanup object identity changed')
            if deleting:
                # NTFS rejects disposition on FILE_OPEN_BY_FILE_ID handles.
                # Keep that identity anchor while acquiring a supported handle,
                # then validate it before any traversal or deletion.
                deletion = self.open(self.final_path(handle), directory=True, access=access, share=share)
                try:
                    if self.identity(deletion) != identity:
                        raise IngestError('cleanup object identity changed')
                except BaseException:
                    self.close(deletion)
                    raise
                self.close(handle)
                return deletion
            return handle
        except BaseException:
            self.close(handle)
            raise

    def final_path(self, handle):
        size = self.dll.GetFinalPathNameByHandleW(handle, None, 0, 0)
        if not size or size > 32768:
            raise IngestError('cleanup object path is unavailable or too long')
        buffer = ctypes.create_unicode_buffer(size + 1)
        length = self.dll.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0)
        if not length or length >= len(buffer):
            raise IngestError('cleanup object path changed during acquisition')
        path = buffer.value
        return Path('\\\\' + path[8:] if path.startswith('\\\\?\\UNC\\') else
                    path[4:] if path.startswith('\\\\?\\') else path)

    def delete(self, handle):
        # DELETE access on this exact object; no pathname is used for removal.
        disposition = ctypes.c_ubyte(1)  # FILE_DISPOSITION_INFO.DeleteFile
        if not self.dll.SetFileInformationByHandle(handle, 4, ctypes.byref(disposition),
                                                  ctypes.sizeof(disposition)):
            raise ctypes.WinError(ctypes.get_last_error())

    def path_identity(self, path):
        handle = self.open(path, directory=Path(path).is_dir(), share=7)
        try:
            return self.identity(handle)
        finally:
            self.close(handle)

    def reader(self, handle):
        import msvcrt
        duplicate = self.w.HANDLE()
        process = self.dll.GetCurrentProcess()
        if not self.dll.DuplicateHandle(process, handle, process, ctypes.byref(duplicate), 0, False, 2):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            fd = msvcrt.open_osfhandle(duplicate.value, os.O_RDONLY | os.O_BINARY)
        except BaseException:
            self.close(duplicate.value)
            raise
        return os.fdopen(fd, 'rb')

    def close(self, handle):
        if not self.dll.CloseHandle(handle):
            raise ctypes.WinError(ctypes.get_last_error())


PATH_OWNER = threading.local()


class ConfinedIO:
    """Pin ancestry for the whole ingestion, including validation/open gaps.

    POSIX I/O is relative to held, no-follow directory descriptors. Windows
    uses native reparse-aware, delete-denying directory guards before
    opening each next component. Checks detect namespace replacement, while
    the held objects prevent that replacement from redirecting I/O.
    """
    def __init__(self):
        self.kernel = WindowsKernel() if os.name == 'nt' else None
        self.directories = {}
        self.shared = set()  # pins that already allow WRITE sharing (never DELETE)

    def check(self, path):
        path = Path(path).absolute()
        for component in (*reversed(path.parents), path):
            reject_reparse(component)
            _, identity = self.directories[component]
            if self.kernel:
                actual = self.kernel.path_identity(component)
            else:
                info = os.lstat(component)
                actual = info.st_dev, info.st_ino
            if actual != identity:
                raise IngestError('confined directory was replaced: ' + str(component))

    def directory(self, path, create=False, share=1):
        path = Path(path).absolute()
        if path in self.directories:
            self.check(path)
            if share & 2 and path not in self.shared:
                return self.writable_directory(path)
            return self.directories[path][0]
        checked_path(path, path)
        parent = None if path.parent == path else self.directory(path.parent, create, share)
        if create and parent is not None:
            try:
                if self.kernel:
                    path.mkdir(mode=0o700)
                else:
                    os.mkdir(path.name, mode=0o700, dir_fd=parent)
            except FileExistsError:
                pass
        reject_reparse(path)
        if self.kernel:
            handle = self.kernel.open(path, directory=True, share=share)
            try:
                identity = self.kernel.identity(handle)
            except BaseException:
                self.kernel.close(handle)
                raise
            if share & 2:
                self.shared.add(path)
        else:
            if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
                raise IngestError('anchored directory I/O is unavailable')
            handle = (open_directory_fd(path) if parent is None else
                      os.open(path.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                              dir_fd=parent))
            info = os.fstat(handle)
            identity = info.st_dev, info.st_ino
        self.directories[path] = handle, identity
        try:
            self.check(path)
            if parent is not None:
                self.check(path.parent)
            return handle
        except BaseException:
            self.release(path)
            raise

    def open_fd(self, path, flags):
        path = Path(path).absolute()
        parent = self.directory(path.parent)
        reject_reparse(path)
        if self.kernel and flags & (os.O_WRONLY | os.O_RDWR) and not flags & os.O_EXCL:
            raise IngestError('confined writable files require exclusive creation')
        if self.kernel and not flags & (os.O_WRONLY | os.O_RDWR):
            handle = self.kernel.open(path)
            try:
                with self.kernel.reader(handle) as reader:
                    fd = os.dup(reader.fileno())
            finally:
                self.kernel.close(handle)
        else:
            fd = os.open(path if self.kernel else path.name,
                         flags | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
                         | getattr(os, 'O_NONBLOCK', 0), 0o600,
                         **({} if self.kernel else dict(dir_fd=parent)))
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & REPARSE_POINT:
                raise IngestError('confined file must be regular')
            self.check(path.parent)
            return fd
        except BaseException:
            os.close(fd)
            raise

    def temporary_file(self, parent, prefix):
        path = Path(parent) / (prefix + uuid.uuid4().hex)
        return self.open_fd(path, os.O_RDWR | os.O_CREAT | os.O_EXCL), str(path)

    def writable_directory(self, path):
        """Permit owned child publication without permitting parent deletion.

        Windows child rename/delete needs WRITE sharing on its parent. Acquire
        the replacement guard before closing the original, preserving identity
        and denying DELETE sharing throughout. Source-only guards stay READ.
        """
        path = Path(path).absolute()
        handle = self.directory(path)
        if self.kernel is None or path in self.shared:
            return handle
        old, identity = self.directories[path]
        replacement = self.kernel.open(path, directory=True, share=3)
        try:
            if self.kernel.identity(replacement) != identity:
                raise IngestError('writable directory changed before publication')
            self.check(path)
        except BaseException:
            self.kernel.close(replacement)
            raise
        self.directories[path] = replacement, identity
        self.shared.add(path)
        self.kernel.close(old)
        return replacement

    def replace(self, source, target):
        source, target = Path(source).absolute(), Path(target).absolute()
        left, right = self.writable_directory(source.parent), self.writable_directory(target.parent)
        reject_reparse(source)
        reject_reparse(target)
        if self.kernel:
            os.replace(source, target)
        else:
            os.replace(source.name, target.name, src_dir_fd=left, dst_dir_fd=right)

    def catalog_writes(self, root):
        self.writable_directory(root)

    def unlink(self, path):
        path = Path(path).absolute()
        parent = self.writable_directory(path.parent)
        os.unlink(path if self.kernel else path.name,
                  **({} if self.kernel else dict(dir_fd=parent)))

    def release(self, path):
        path = Path(path).absolute()
        for child in reversed(list(self.directories)):
            if child.is_relative_to(path):
                handle, _ = self.directories.pop(child)
                self.shared.discard(child)
                (self.kernel.close if self.kernel else os.close)(handle)

    def remove_tree(self, path):
        path = Path(path).absolute()
        parent = self.writable_directory(path.parent)
        handle = self.directory(path)
        identity = self.directories[path][1]
        expected = {p: value[1] for p, value in self.directories.items() if p.is_relative_to(path)}
        if self.kernel is not None:
            # The anchor survives guard release. A replacement at the pathname
            # cannot redirect acquisition of the DELETE guard for this file ID.
            anchor = self.kernel.open_identity(handle, identity)
            try:
                self.release(path)
                deletion = self.kernel.open_identity(anchor, identity, access=self.kernel.READ | 0x10000, share=3)
                self.directories[path] = deletion, identity
                try:
                    try:
                        self.check(path)
                    except (IngestError, FileNotFoundError):
                        # Only the anchored empty reservation can be removed
                        # after substitution or rename-away; never enumerate
                        # a replacement.
                        # A nonempty original fails closed at native disposition.
                        self.kernel.delete(deletion)
                    else:
                        self._remove_windows(path, deletion, expected, [0])
                finally:
                    self.release(path)
            finally:
                self.kernel.close(anchor)
        else:
            # Recursion consumes the original held descriptor. It never reopens
            # the root entry after dropping its ownership evidence.
            self._remove_posix(path, handle, expected, [0])
            self.check(path)
            os.rmdir(path.name, dir_fd=parent)  # nonrecursive; a nonempty replacement is never removed
            self.release(path)

    def _remove_windows(self, path, handle, expected, count):
        self.check(path)
        with os.scandir(path) as entries:
            for entry in entries:
                count[0] += 1
                if count[0] > MAX_FILES * 4 + 32:
                    raise IngestError('cleanup member budget exceeded')
                child = path / entry.name
                guard = self.kernel.open(child, directory=True, access=self.kernel.READ | 0x10000, share=3)
                try:
                    identity = self.kernel.identity(guard)
                    if self.kernel.info(guard).attributes & 0x10:
                        if expected.get(child) != identity:
                            raise IngestError('cleanup directory ownership changed')
                        self.directories[child] = guard, identity
                        try:
                            self._remove_windows(child, guard, expected, count)
                        finally:
                            self.directories.pop(child)
                    else:
                        self.kernel.delete(guard)
                finally:
                    self.kernel.close(guard)
        self.check(path)
        self.kernel.delete(handle)

    def _remove_posix(self, path, handle, expected, count):
        self.check(path)
        with os.scandir(handle) as entries:
            for entry in entries:
                count[0] += 1
                if count[0] > MAX_FILES * 4 + 32:
                    raise IngestError('cleanup member budget exceeded')
                info = os.stat(entry.name, dir_fd=handle, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = path / entry.name
                    child_handle = self.directory(child)
                    if expected.get(child) != self.directories[child][1]:
                        raise IngestError('cleanup directory ownership changed')
                    self._remove_posix(child, child_handle, expected, count)
                    self.check(child)
                    os.rmdir(entry.name, dir_fd=handle)
                    self.release(child)
                else:
                    if not stat.S_ISREG(info.st_mode):
                        raise IngestError('cleanup refuses links and special files')
                    os.unlink(entry.name, dir_fd=handle)

    @contextlib.contextmanager
    def temporary_directory(self, parent, prefix):
        path = Path(parent) / (prefix + uuid.uuid4().hex)
        self.directory(path, create=True)
        try:
            yield path
        finally:
            self.remove_tree(path)

    def close(self):
        for path in reversed(list(self.directories)):
            self.release(path)


@contextlib.contextmanager
def confined_io():
    existing = getattr(PATH_OWNER, 'current', None)
    if existing is not None:
        yield existing
        return
    io_ = PATH_OWNER.current = ConfinedIO()
    try:
        yield io_
    finally:
        PATH_OWNER.current = None
        io_.close()


def active_io():
    io_ = getattr(PATH_OWNER, 'current', None)
    if io_ is None:
        raise IngestError('ingestion requires held confinement identities')
    return io_


def make_directory(path, shared=False):
    # Windows renames a child only if no other handle on its parent denies WRITE
    # sharing. Directories that host journals and catalogs are therefore shared
    # from the first open (DELETE stays denied), so a waiting caller never blocks
    # the lock holder.
    active_io().directory(path, create=True, share=3 if shared else 1)


@contextlib.contextmanager
def package_lock(work):
    # Use review's OS locking contract on an anchored guard. Kernel release on
    # process death makes this resumable without following/deleting pid aliases.
    lock = review.FileLock(str(work), lock=threading.RLock())
    path = work / '.lock.guard'
    try:
        created = active_io().open_fd(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    except FileExistsError:
        pass
    else:
        os.close(created)
    # LockFile/flock accept a read handle. Windows keeps write/delete sharing
    # denied on the guard object while the lock is held.
    lock.guard = active_io().open_fd(path, os.O_RDONLY)
    deadline = time.monotonic() + 30
    try:
        while True:
            try:
                lock.guard_lock()
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise IngestError('package is locked by another process')
                time.sleep(.05)
        yield
    finally:
        os.close(lock.guard)


class HeldOutput:
    def __init__(self, owner, path):
        self.owner, self.path = owner, Path(path)
        self.handle = None
        if owner.kernel is not None:
            self.handle = owner.kernel.open(path)
            try:
                self.identity = owner.kernel.identity(self.handle)
            except BaseException:
                self.close()
                raise
        else:
            import fcntl
            self.handle = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                fcntl.fcntl(self.handle, fcntl.F_SETLEASE, fcntl.F_RDLCK)
                info = os.fstat(self.handle)
                self.identity = info.st_dev, info.st_ino
            except BaseException:
                os.close(self.handle)
                self.handle = None
                raise IngestError('mandatory output lease unavailable; refusing unprotected submission')

    def check(self):
        if self.owner.broken:
            raise IngestError('protected submission write attempted')
        checked_path(self.owner.directory, self.path)
        if self.owner.kernel is not None:
            identity = self.owner.kernel.path_identity(self.path)
        else:
            import fcntl
            if fcntl.fcntl(self.handle, fcntl.F_GETLEASE) != fcntl.F_RDLCK:
                raise IngestError('protected submission lease was broken')
            info = os.lstat(self.path)
            identity = info.st_dev, info.st_ino
        if identity != self.identity:
            raise IngestError('protected submission object was replaced')

    def reader(self):
        if self.owner.kernel is not None:
            return self.owner.kernel.reader(self.handle)
        return os.fdopen(os.dup(self.handle), 'rb')

    def close(self):
        if self.handle is not None:
            handle, self.handle = self.handle, None
            if self.owner.kernel is not None:
                self.owner.kernel.close(handle)
            else:
                os.close(handle)  # kernel releases the lease, including rollback


def protected_hash(held, limit):
    held.check()
    sha, total = hashlib.sha256(), 0
    with held.reader() as stream:
        stream.seek(0)
        while True:
            block = stream.read(min(1024 * 1024, limit - total + 1))
            total += len(block)
            if total > limit:
                raise IngestError('protected submission bytes exceed limit')
            if not block:
                break
            sha.update(block)
    held.check()
    return sha.hexdigest()


def protection_kernel():
    if os.name == 'nt':
        return WindowsKernel()
    if not sys.platform.startswith('linux') or threading.current_thread() is not threading.main_thread():
        raise IngestError('mandatory submission protection requires Windows or the Linux main thread')
    return None


class VerifiedSubmitIO:
    """Verify the downstream copy, rather than trust a previously checked path.

    The proxy applies only to the adapter's calling thread. Other review callers
    retain their normal shutil operations; the stdlib module itself is untouched.
    """
    def __init__(self, delegate, root, files, hashes, sizes, transaction):
        self.delegate = delegate
        self.root = root
        self.owner = threading.get_ident()
        self.transaction = transaction
        self.expected = {str(Path(path)): (hashes[relative], sizes[relative])
                         for path, relative in zip(files, hashes)}

    def __getattr__(self, name):
        return getattr(self.delegate, name)

    def copy2(self, source, destination, *args, **kwargs):
        if threading.get_ident() != self.owner:
            return self.delegate.copy2(source, destination, *args, **kwargs)
        source, destination = Path(source), Path(destination)
        expected = self.expected.get(str(source))
        if expected is None or destination.name != source.name or args or kwargs:
            raise IngestError('unexpected downstream submission copy')
        sha, size = expected
        if destination.parent != self.transaction.directory:
            raise IngestError('unexpected downstream submission directory')
        _copy_verified(source, destination, sha, source.parent, self.root, size)
        if len(self.transaction.outputs) == len(self.expected):
            self.transaction.seal()
        return str(destination)


class ModuleProxy:
    """Thread-local overrides without changing a shared stdlib module."""
    def __init__(self, delegate, **overrides):
        self.delegate, self.overrides = delegate, overrides
        self.owner = threading.get_ident()

    def __getattr__(self, name):
        if threading.get_ident() == self.owner and name in self.overrides:
            return self.overrides[name]
        return getattr(self.delegate, name)


class ProtectedSubmission:
    """Own the final output directory and hold its objects through publication.

    Reserving the destination exclusively avoids renaming a directory containing
    Windows delete-denying handles. review's directory move becomes a checked
    handoff of this reservation; its catalog transaction stays unchanged.
    """
    def __init__(self, root, args):
        self.root, self.args = root, args
        self.kernel = protection_kernel()
        self.directory = None
        self.guards, self.directories, self.outputs = [], [], {}
        self.broken, self.sealed = False, False
        self.old_signal = None

    def hold_file(self, path):
        held = HeldOutput(self, path)
        self.guards.append(held)
        return held

    def break_lease(self, *_):
        self.broken = True
        raise IngestError('protected submission write attempted')

    def check_directories(self):
        if self.broken:
            raise IngestError('protected submission write attempted')
        checked_path(self.root, self.directory)
        for path, handle, identity in self.directories:
            if self.kernel is not None:
                actual = self.kernel.path_identity(path)
            else:
                info = os.lstat(path)
                actual = info.st_dev, info.st_ino
            if actual != identity:
                raise IngestError('protected submission directory was replaced')

    def seal(self):
        self.check_directories()
        if self.kernel is None:
            # Deny namespace changes by ordinary local writers. Mandatory leases
            # separately deny writes through any existing or newly opened alias.
            os.fchmod(active_io().directories[self.directory][0], 0o500)
        for held, expected, limit in self.outputs.values():
            if protected_hash(held, limit) != expected:
                raise IngestError('protected submission hash mismatch')
        self.sealed = True

    def exists(self, path):
        if self.directory is not None and Path(path) == self.directory:
            self.check_directories()
            return False  # exclusively owned reservation, not an existing version
        return os.path.exists(path)

    def rename(self, source, target, *args, **kwargs):
        if Path(source) != self.directory or Path(target) != self.directory or args or kwargs:
            raise IngestError('unexpected submission publication move')
        if not self.sealed or len(self.outputs) != len(self.args.file):
            raise IngestError('submission objects are not protected')
        self.check_directories()
        for held, _, _ in self.outputs.values():
            held.check()

    def TemporaryDirectory(self, *args, **kwargs):
        if args or kwargs != dict(prefix='.submit-', dir=self.args.root):
            raise IngestError('unexpected submission temporary directory')
        return self

    def __enter__(self):
        try:
            if self.kernel is None:
                self.old_signal = signal.signal(signal.SIGIO, self.break_lease)
            cat = review.catalog(self.args.root, self.args.project)
            versions = cat['assets'].get(self.args.asset, {}).get('stages', {}).get(
                self.args.stage, {}).get('versions', [])
            directory = checked_path(self.root, review.vdir(
                self.args.root, self.args.asset, self.args.stage, len(versions) + 1))
            # Pin each ancestor as it is reached; reject links before opening.
            package = getattr(self.args, '_package_commit', None)
            for path in (*reversed(directory.parents), directory):
                if path.is_relative_to(self.root):
                    if path == directory:
                        active_io().directory(path.parent)
                        if package is not None:
                            package.reserve(directory, None)  # intent first: a crash after mkdir stays recoverable
                    try:
                        path.mkdir(mode=0o700, exist_ok=path != directory)
                    except OSError:
                        if path == directory and package is not None:
                            package.unreserve()  # mkdir failed: nothing of ours exists to recover
                        raise
                    if path == directory:
                        # Register ownership before any transaction guard can
                        # fail, and retain it across the rollback handoff.
                        active_io().directory(path)
                        self.directory = directory
                        if package is not None:
                            package.reserve(directory, active_io().directories[directory][1])
                reject_reparse(path)
                # The already-populated review root must allow its catalog's
                # atomic child-file replacement, while still denying deletion
                # of the root itself. Newly reserved ancestry and output files
                # keep write and delete sharing denied throughout submission.
                share = 3 if path == self.root else 1
                handle = self.kernel.open(path, directory=True, share=share) if self.kernel is not None else None
                if self.kernel is not None:
                    try:
                        identity = self.kernel.identity(handle)
                    except BaseException:
                        self.kernel.close(handle)
                        raise
                else:
                    info = os.lstat(path)
                    identity = info.st_dev, info.st_ino
                self.directories.append((path, handle, identity))
            self.check_directories()
            return str(self.directory)
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise

    def __exit__(self, *_):
        # Catalog publication can precede an event failure. Never remove an
        # output that already belongs to this event, even on an exception.
        published = bool(getattr(self, 'intent', False))
        if self.directory is not None and not published:
            try:
                cat = review.jload(str(self.root / 'catalog.json'), {})
                versions = cat.get('assets', {}).get(self.args.asset, {}).get('stages', {}).get(
                    self.args.stage, {}).get('versions', [])
                event = json.loads(self.args.meta)['ingest']['event_id']
                published = any(v.get('meta', {}).get('ingest', {}).get('event_id') == event for v in versions)
            except (OSError, ValueError):
                published = True  # uncertain publication is not safe to roll back
        try:
            for held in reversed(self.guards):
                held.close()
            for _, handle, _ in reversed(self.directories):
                if handle is not None:
                    self.kernel.close(handle)
            if self.directory is not None:
                if self.kernel is None:
                    os.fchmod(active_io().directories[self.directory][0], 0o700)
                if not published:
                    # Release deny-delete handles before Windows rollback.
                    active_io().remove_tree(self.directory)
        finally:
            if self.old_signal is not None:
                signal.signal(signal.SIGIO, self.old_signal)
                self.old_signal = None


@contextlib.contextmanager
def verified_submit_io(root, files, hashes, sizes, args):
    # Serialize adapter overrides, while dispatching unrelated threads normally.
    with SUBMIT_COPY_LOCK:
        previous, previous_os, previous_tempfile = review.shutil, review.os, review.tempfile
        delegate = previous.delegate if isinstance(previous, VerifiedSubmitIO) else previous
        transaction = ProtectedSubmission(root, args)
        review.shutil = VerifiedSubmitIO(delegate, root, files, hashes, sizes, transaction)
        review.os = ModuleProxy(previous_os, path=ModuleProxy(previous_os.path, exists=transaction.exists),
                                rename=transaction.rename)
        review.tempfile = ModuleProxy(previous_tempfile, TemporaryDirectory=transaction.TemporaryDirectory)
        COPY_OWNER.current = transaction
        previous_commit = getattr(review.PACKAGE_IO, 'current', None)
        review.PACKAGE_IO.current = getattr(args, '_package_commit', None)
        try:
            yield
        finally:
            COPY_OWNER.current = None
            review.PACKAGE_IO.current = previous_commit
            review.shutil, review.os, review.tempfile = previous, previous_os, previous_tempfile


def atomic_payload(path, payload, limit):
    """Durable, confined replacement, including the parent directory on POSIX."""
    path = Path(path)
    if len(payload) > limit:
        raise IngestError('package publication exceeds persistence budget')
    io_ = active_io()
    fd, temporary = io_.temporary_file(path.parent, '.package-')
    try:
        with os.fdopen(fd, 'wb') as stream:
            check_open_file(stream, temporary, path.parent)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        io_.replace(temporary, path)
        if io_.kernel is None:
            os.fsync(io_.directory(path.parent))
    finally:
        if Path(temporary).exists():
            io_.unlink(temporary)


class PackageCommit:
    """Root-local intent and repeatable publication; caller holds FileLock."""
    def __init__(self, root, work, journal, sizes, meta):
        self.root, self.work, self.journal = root, work, journal
        self.sizes, self.meta = sizes, meta
        self.marker = {key: journal[key] for key in
                       ('schema_version', 'package_id', 'content_digest', 'event_id')}
        self.hashes = journal['verified_files']
        self.destination = journal['destination']
        self.intent_path = local_path(work, 'commit.json')
        self.reservation_path = local_path(work, 'reservation.json')
        self.intent = None

    def reserve(self, directory, identity):
        """Record the reservation before and after the directory exists (identity None = not yet created)."""
        atomic_json(self.reservation_path, dict(
            marker=self.marker, directory=Path(directory).relative_to(self.root).as_posix(),
            identity=None if identity is None else list(identity)))
        if active_io().kernel is None:
            os.fsync(active_io().directory(self.work))

    def unreserve(self):
        if self.reservation_path.exists():
            active_io().unlink(self.reservation_path)

    def release_precommit(self, options):
        """After a crash before the intent: remove our own reservation by identity.

        A record without identity means the crash fell between mkdir and binding it;
        only a still empty directory is then ours to remove.

        True means a retry cannot collide with leftovers (nothing exists, or the
        owned reservation was removed). False leaves an unowned directory alone.
        """
        io_ = active_io()
        with review.FileLock(str(self.root)):
            aid, sid = self.destination['asset'], self.destination['stage']
            versions = review.catalog(str(self.root), options['project'])['assets'].get(aid, {}).get(
                'stages', {}).get(sid, {}).get('versions', [])
            directory = checked_path(self.root, review.vdir(str(self.root), aid, sid, len(versions) + 1))
            record = read_json(self.reservation_path, self.work, 'reservation') if self.reservation_path.exists() else None
            if os.path.lexists(directory):
                io_.directory(directory)
                bound = isinstance(record, dict) and record.get('identity') is not None
                expected = {PurePosixPath(name).name for name in self.hashes} if bound else set()
                if (not isinstance(record, dict) or record.get('marker') != self.marker or
                        record.get('directory') != directory.relative_to(self.root).as_posix() or
                        (bound and record['identity'] != list(io_.directories[directory][1])) or
                        any(entry.name not in expected for entry in os.scandir(directory))):
                    return False
                io_.remove_tree(directory)
            if record is not None:
                io_.unlink(self.reservation_path)
            return True

    def prepare(self, original_asset, asset, version):
        provenance_policy(self.root, self.meta, self.hashes)
        if version['meta']['ingest'] != self.marker:
            raise IngestError('package identity conflict')
        # Refuse before publication, while nothing is visible: an unusable event
        # log or a package id that another transaction already published.
        self.event_log()
        for other in review.jload(str(self.root / 'catalog.json'), {}).get('assets', {}).values():
            for stage in other.get('stages', {}).values():
                if any(item.get('meta', {}).get('ingest', {}).get('package_id') == self.marker['package_id']
                       for item in stage.get('versions', [])):
                    raise IngestError('package identity conflict')
        for key in ('provenance', 'require_provenance', 'allowed_licences'):
            if (key in version['meta']) != (key in self.meta) or version['meta'].get(key) != self.meta.get(key):
                raise IngestError('package provenance changed during submit')
        self.intent = dict(schema_version=1, marker=self.marker, destination=self.destination,
                           verified_files=self.hashes, sizes=self.sizes, meta=self.meta,
                           original_asset=original_asset, asset=asset, version=version)
        atomic_json(self.intent_path, self.intent)
        if active_io().kernel is None:
            os.fsync(active_io().directory(self.work))
        if self.reservation_path.exists():
            active_io().unlink(self.reservation_path)  # the intent now owns the reservation
        # The durable intent now owns these complete, guarded output objects.
        COPY_OWNER.current.intent = True

    def write_catalog(self, path, data):
        if Path(path).absolute() != self.root / 'catalog.json':
            raise IngestError('unexpected package catalog destination')
        atomic_payload(path, review.catalog_text(data).encode('utf-8'), review.MAX_CATALOG_BYTES)

    def write_event(self, root, row):
        if Path(root).absolute() != self.root:
            raise IngestError('unexpected package event destination')
        expected = self.submit_event(self.intent['version'])
        if any(row.get(key) != value for key, value in expected.items()):
            raise IngestError('unexpected package submit event')
        raw, rows = self.event_log()
        matches = [item for item in rows if item.get('event_id') == self.marker['event_id']]
        path = local_path(self.root, 'events.jsonl')
        if matches:
            if len(matches) != 1 or any(matches[0].get(key) != value for key, value in expected.items()):
                raise IngestError('package event identity conflict')
            return
        # Atomic replacement makes a terminated append either absent or complete.
        atomic_payload(path, raw + (b'\n' if raw and not raw.endswith(b'\n') else b'') +
                       canonical(dict(at=review.now(), **expected)) + b'\n',
                       review.MAX_LEGACY_CATALOG_BYTES)

    def event_log(self):
        path = local_path(self.root, 'events.jsonl')
        raw = b''
        if path.exists():
            with open_checked(path, self.root) as stream:
                raw = stream.read(review.MAX_LEGACY_CATALOG_BYTES + 1)
            if len(raw) > review.MAX_LEGACY_CATALOG_BYTES - EVENT_HEADROOM:
                raise IngestError('events exceed reconciliation budget')
        rows = []
        for line in raw.splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue  # blank or torn line, as review.jsonl_rows skips it
            if isinstance(row, dict):
                rows.append(row)
        return raw, rows

    def has_event(self, version):
        _, rows = self.event_log()
        matches = [row for row in rows if row.get('event_id') == self.marker['event_id']]
        return len(matches) == 1 and all(matches[0].get(key) == value for key, value in self.submit_event(version).items())

    def submit_event(self, version):
        return dict(type='submit', asset=self.destination['asset'], stage=self.destination['stage'],
                    v=version['v'], by=version['by'], resolves=version['resolves'],
                    gate=len(version.get('gate', {}).get('blocked', [])), event_id=self.marker['event_id'])

    def recover(self, options):
        """Return an existing/repaired version, or None before durable intent."""
        number = self._recover(options)
        if number is not None:
            self.finish_publication(options, number)
        return number

    def finish_publication(self, options, number):
        """What review.submit does after publication (PDF page counts, project registry); a crash can skip it."""
        aid, sid = self.destination['asset'], self.destination['stage']
        directory = review.vdir(str(self.root), aid, sid, number)
        version = review.catalog(str(self.root), options['project'])['assets'][aid]['stages'][sid]['versions'][number - 1]
        review.finish_pdf_pages(str(self.root), options['project'], aid, sid, number, directory,
                                [f for f in version['files'] if review.pdf_pages_pending(directory, f)])
        try:
            review.register(str(self.root))
        except Exception:
            pass  # advisory registry: the publication is durable and the next submit or serve registers the root

    def _recover(self, options):
        active_io().catalog_writes(self.root)
        with review.FileLock(str(self.root)):
            provenance_policy(self.root, self.meta, self.hashes)
            cat = review.catalog(str(self.root), options['project'])
            matches = []
            for aid, asset in cat['assets'].items():
                for sid, stage in asset['stages'].items():
                    for version in stage['versions']:
                        marker = version.get('meta', {}).get('ingest', {})
                        if marker.get('package_id') == self.marker['package_id']:
                            if marker != self.marker or dict(asset=aid, stage=sid) != self.destination:
                                raise IngestError('package identity conflict')
                            matches.append(version)
            if len(matches) > 1:
                raise IngestError('package has multiple published versions')
            if self.intent_path.exists():
                self.intent = read_json(self.intent_path, self.work, 'commit intent')
                if (not isinstance(self.intent, dict) or type(self.intent.get('schema_version')) is not int or self.intent['schema_version'] != 1 or
                        any(self.intent.get(key) != value for key, value in dict(
                            marker=self.marker, destination=self.destination, verified_files=self.hashes,
                            sizes=self.sizes, meta=self.meta).items())):
                    raise IngestError('package commit intent identity conflict')
                version = self.intent.get('version')
                if not isinstance(version, dict) or version.get('meta', {}).get('ingest') != self.marker:
                    raise IngestError('invalid package commit intent')
                if matches and matches[0]['v'] != version.get('v'):
                    raise IngestError('package version identity conflict')
                if matches:
                    version = matches[0]
            elif matches:
                # Persisted version markers survive a lost adapter acknowledgement.
                version = matches[0]
                self.intent = dict(version=version)
            else:
                return None
            number = version.get('v')
            if type(number) is not int or number < 1:
                raise IngestError('invalid package version')
            for key in ('provenance', 'require_provenance', 'allowed_licences'):
                if (key in version['meta']) != (key in self.meta) or version['meta'].get(key) != self.meta.get(key):
                    raise IngestError('package provenance identity conflict')
            expected = {PurePosixPath(name).name for name in self.hashes}
            if {item['name'] for item in version['files']} != expected or len(version['files']) != len(expected):
                raise IngestError('package version files do not match intent')
            # R3C-111 begin
            if not matches:
                require_slot(self.root, self.destination['asset'], self.destination['stage'], cat=cat)
            # R3C-111 end
            with protected_recovery(self, number):
                self.event_log()
                if not matches:
                    aid, sid = self.destination['asset'], self.destination['stage']
                    current = cat['assets'].get(aid)
                    asset = self.intent.get('asset')
                    if (not isinstance(asset, dict) or
                            asset.get('stages', {}).get(sid, {}).get('versions', [])[-1:] != [version] or
                            asset['stages'][sid].get('status') not in ('gate', 'in_review')):
                        raise IngestError('invalid package asset intent')
                    original = self.intent.get('original_asset')
                    if current != original:
                        # Ordinary work (a verdict, another stage) may have changed the asset
                        # since the crash. Append this version to the current entry and carry
                        # over only the asset-level fields this submit changed.
                        if current is None or number != len(
                                current.get('stages', {}).get(sid, {}).get('versions', [])) + 1:
                            raise IngestError('asset changed during package recovery: stage version conflict')
                        merged = json.loads(json.dumps(current))
                        for key, value in asset.items():
                            if key != 'stages' and (original or {}).get(key) != value and (
                                    original is not None or key not in merged):
                                merged[key] = value
                        stage = merged['stages'].setdefault(sid, {'status': 'none', 'versions': []})
                        stage['versions'].append(version)
                        stage['status'] = asset['stages'][sid]['status']
                        asset = merged
                    elif number != len((current or {}).get('stages', {}).get(sid, {}).get('versions', [])) + 1:
                        raise IngestError('invalid package asset intent')
                    cat['assets'][aid] = asset
                    self.write_catalog(self.root / 'catalog.json', cat)
                self.write_event(self.root, self.submit_event(version))
                self.enqueue_render(version, number)
            return number

    def enqueue_render(self, version, number):
        """The crash may precede review.submit's enqueue; the job key is the content hash."""
        render = version.get('meta', {}).get('render')
        if not render or os.environ.get('ASSET_REVIEW_RENDER') != '1':
            return
        import auto_render
        if auto_render.job_path(str(self.root), render['hash']).exists():
            return
        directory = review.vdir(str(self.root), self.destination['asset'], self.destination['stage'], number)
        auto_render.enqueue(str(self.root), directory, [item['name'] for item in version['files']])


@contextlib.contextmanager
def protected_recovery(commit, number):
    """Reacquire the same write/delete guards before publishing recovered bytes."""
    args = argparse.Namespace(root=str(commit.root), asset=commit.destination['asset'],
                              stage=commit.destination['stage'], meta=canonical(dict(ingest=commit.marker)).decode())
    transaction = ProtectedSubmission(commit.root, args)
    transaction.intent = True  # never delete evidence from an uncertain transaction
    directory = local_path(commit.root, Path(review.vdir(args.root, args.asset, args.stage, number)).relative_to(
        commit.root).as_posix())
    try:
        if transaction.kernel is None:
            transaction.old_signal = signal.signal(signal.SIGIO, transaction.break_lease)
        active_io().directory(directory)
        transaction.directory = directory
        for path in (*reversed(directory.parents), directory):
            if path.is_relative_to(commit.root):
                handle = transaction.kernel.open(path, directory=True, share=3 if path == commit.root else 1) if transaction.kernel else None
                try:
                    identity = transaction.kernel.identity(handle) if transaction.kernel else (path.stat().st_dev, path.stat().st_ino)
                except BaseException:
                    if handle is not None:
                        transaction.kernel.close(handle)
                    raise
                transaction.directories.append((path, handle, identity))
        for relative, sha in commit.hashes.items():
            path = local_path(directory, PurePosixPath(relative).name)
            held = transaction.hold_file(path)
            transaction.outputs[path.name] = held, sha, commit.sizes[relative]
        transaction.seal()
        yield
    finally:
        transaction.__exit__(*sys.exc_info())


def provenance_policy(root, meta, hashes):
    path = local_path(root, '.provenance-policy.json')
    policy = read_json(path, root, 'policy') if path.exists() else {
        'schema_version': 1, 'require_provenance': False, 'allowed_licences': None}
    if not isinstance(policy, dict) or type(policy.get('schema_version')) is not int or policy['schema_version'] != 1:
        raise IngestError('invalid provenance policy schema')
    allowed = policy.get('allowed_licences')
    if (type(policy.get('require_provenance')) is not bool or
            'allowed_licences' not in policy or
            (allowed is not None and (not isinstance(allowed, list) or not all(map(label, allowed))))):
        raise IngestError('invalid provenance policy')
    if root.exists():
        trusted = review.load_policy(str(root))
        allowed = trusted.allowed_licences
        policy['require_provenance'] = trusted.require_provenance
    provenance = meta.get('provenance')
    required = policy['require_provenance'] or meta.get('require_provenance') is True
    if 'provenance' not in meta:
        if required:
            raise IngestError('provenance is required')
    else:
        expected = {PurePosixPath(path).name: sha for path, sha in hashes.items()}
        if (not isinstance(provenance, dict) or
                not all(label(provenance.get(key)) for key in ('source', 'author', 'licence')) or
                provenance.get('files') != expected):
            raise IngestError('invalid provenance: labels and exact lowercase SHA256 file hashes required')
        if allowed is not None and provenance['licence'] not in allowed:
            raise IngestError('licence is not allowed by trusted policy')
    # Submitted meta.allowed_licences never grants permission.
    return {'require_provenance': required,
            'allowed_licences': sorted(set(allowed)) if allowed is not None else None}


SUBMIT_DEFAULTS = dict(project=None, name=None, note=None, resolves=None,
                       response=None, by='agent', route=None, thread=None,
                       choice=None, skip_gate=None, skip_render=False,
                       build_id=None, phone_clients=None, claim_players=None)


def _ingest_manifest(root, manifest):
    root, manifest = Path(os.path.abspath(root)), Path(os.path.abspath(manifest))
    checked_path(root, root)
    package = read_json(manifest, manifest.parent, 'manifest')
    if not isinstance(package, dict) or not label(package.get('package_id')):
        raise IngestError('package_id must be a nonempty string')
    asset, stage = package.get('asset'), package.get('stage')
    review.check_ids(asset, stage)
    files, meta = package.get('files'), package.get('meta', {})
    if not isinstance(files, list) or not files or not isinstance(meta, dict):
        raise IngestError('files must be a nonempty list and meta an object')
    if len(files) > MAX_FILES:
        raise IngestError('file count exceeds %d-file limit' % MAX_FILES)
    if 'ingest' in meta:
        raise IngestError('meta.ingest is reserved for the adapter')
    sources, basenames = {}, set()
    for relative in files:
        path = local_path(manifest.parent, relative)
        name = path.name
        if (not review.safe_name(name) or name.lower() in
                ('review.json', 'review.md', 'review-thumb.png') or name.lower() in basenames):
            raise IngestError('invalid or duplicate submission basename: ' + name)
        basenames.add(name.lower())
        sources[relative] = path
    # R3C-111 begin
    require_slot(root, asset, stage)  # before journals, reservations or staging
    # R3C-111 end
    sizes = {}
    for relative, path in sources.items():
        with open_checked(path, manifest.parent) as stream:
            sizes[relative] = os.fstat(stream.fileno()).st_size
    if sum(sizes.values()) > MAX_PACKAGE_BYTES:
        raise IngestError('aggregate package bytes exceed %d-byte limit' % MAX_PACKAGE_BYTES)
    hashes = {relative: file_hash(path, manifest.parent, sizes[relative])
              for relative, path in sorted(sources.items())}
    provenance_policy(root, meta, hashes)
    destination = dict(asset=asset, stage=stage)
    options = {key: package.get(key, default) for key, default in SUBMIT_DEFAULTS.items()}
    content_digest = digest(dict(files=hashes, meta=meta,
                                 options=options, destination=destination))
    identity = dict(schema_version=1, package_id=package['package_id'],
                    content_digest=content_digest, destination=destination)
    event_id = digest({key: identity[key] for key in ('package_id', 'content_digest', 'destination')})
    identity['event_id'] = event_id
    work = local_path(root, '.ingest/' + hashlib.sha256(package['package_id'].encode('utf-8')).hexdigest())
    make_directory(work, shared=True)
    checked_path(root, work)
    # A separate package lock never holds the review root's submission lock.
    with package_lock(work):
        journal_path = local_path(work, 'journal.json')
        if journal_path.exists():
            journal = read_json(journal_path, work, 'journal')
            if (not isinstance(journal, dict) or
                    type(journal.get('schema_version')) is not int or
                    any(journal.get(key) != value for key, value in identity.items())):
                raise IngestError('package identity conflict')
            if (journal.get('state') not in ('copying', 'ready', 'failed', 'committing', 'committed') or
                    'version' not in journal or
                    (journal['state'] != 'committed' and journal['version'] is not None) or
                    (journal['state'] == 'committed' and (type(journal['version']) is not int or journal['version'] < 1)) or
                    journal.get('meta', meta) != meta or
                    not isinstance(journal.get('verified_files'), dict) or
                    any(key not in hashes for key in journal['verified_files'])):
                raise IngestError('invalid pre-commit journal')
        else:
            journal = dict(identity, state='copying', verified_files={}, version=None, meta=meta)
        journal.setdefault('meta', meta)
        commit = PackageCommit(root, work, dict(journal, verified_files=hashes), sizes, meta)
        recovered = commit.recover(options)
        if recovered is not None:
            journal.update(state='committed', version=recovered, verified_files=hashes)
            atomic_json(journal_path, journal)
            return journal
        if journal['state'] == 'committed':
            raise IngestError('committed package has no publication evidence')
        if journal['state'] == 'committing' and not commit.release_precommit(options):
            raise IngestError('post-commit replay cannot reconcile a package without commit intent')
        try:
            journal['state'] = 'copying'
            atomic_json(journal_path, journal)
            staging = local_path(work, 'files')
            for relative, sha in hashes.items():
                target = local_path(staging, relative)
                verified = journal['verified_files'].get(relative) == sha
                if not (verified and target.is_file() and staging_matches(target, staging, sha, sizes[relative])):
                    journal['verified_files'].pop(relative, None)
                    atomic_json(journal_path, journal)
                    copy_verified(sources[relative], target, sha,
                                  source_root=manifest.parent, target_root=staging, limit=sizes[relative])
                    journal['verified_files'][relative] = sha
                    atomic_json(journal_path, journal)
            journal['state'] = 'ready'
            atomic_json(journal_path, journal)
        except BaseException:
            journal['state'] = 'failed'
            atomic_json(journal_path, journal)
            raise
        return submit_staged(root, work, journal, sizes, meta, options, asset, stage,
                             lambda: atomic_json(journal_path, journal))


def submit_staged(root, work, journal, sizes, meta, options, asset, stage, save,
                  staging_name='files', commit_work=None):
    commit = PackageCommit(root, commit_work or work, journal, sizes, meta)
    recovered = commit.recover(options)
    if recovered is not None:
        journal.update(state='committed', version=recovered)
        save()
        return journal
    submitted_meta = dict(meta, ingest={key: journal[key] for key in
                                       ('schema_version', 'package_id', 'content_digest', 'event_id')})
    journal['state'] = 'committing'
    save()
    # Final verification is after the commit marker and before submit. Only
    # failures known to precede the call can return to resumable staging.
    with contextlib.ExitStack() as stack:
        try:
            files = stack.enter_context(submission_snapshot(work, journal['verified_files'], sizes, staging_name))
        except BaseException:
            journal['state'] = 'failed'
            save()
            raise
        args = argparse.Namespace(root=str(root), asset=asset, stage=stage,
                                  file=files, meta=canonical(submitted_meta).decode('utf-8'),
                                  _package_commit=commit, **options)
        # Durable intent permits replay only after guarded output verification.
        active_io().catalog_writes(root)
        with verified_submit_io(root, files, journal['verified_files'], sizes, args):
            review.submit(args)
    committed = publication_matches(root, asset, stage, journal['event_id'])
    if len(committed) != 1:
        raise IngestError('submit did not publish exactly one matching version')
    if not commit.has_event(committed[0]):
        raise IngestError('submit did not publish exactly one matching event')
    journal.update(state='committed', version=committed[0]['v'])
    save()
    return journal


def ingest_manifest(root, manifest):
    with confined_io():
        return _ingest_manifest(root, manifest)


def main_manifest(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--root', required=True)
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args(argv)
    try:
        ingest(args.root, args.manifest)
    # R3C-111 begin
    except QueueFull as error:
        print(json.dumps(dict(status='failed', error=error.error), sort_keys=True))
        print(str(error), file=sys.stderr)
        return error.exit_code
    # R3C-111 end
    except (ValueError, OSError) as error:
        parser.exit(1, 'ERROR ' + str(error) + '\n')



# ZIP validation feeds the protected publication lifecycle above.

LIMITS = dict(members=256, file_bytes=64*1024*1024, total_bytes=256*1024*1024,
              compression_ratio=100, archive_bytes=256*1024*1024,
              metadata_bytes=2*1024*1024)
CHUNK = 64*1024


class ArchiveError(IngestError):
    def __init__(self, code, message):
        super().__init__(message)
        self.error = dict(code=code, message=message)


def reject(code, message):
    raise ArchiveError(code, message)


def budgets(overrides):
    result = dict(LIMITS)
    for key, value in (overrides or {}).items():
        if key not in result or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 or value > LIMITS[key]:
            raise ValueError('limits must be positive and may only lower defaults')
        if key != 'compression_ratio' and not isinstance(value, int):
            raise ValueError('byte/count limits must be integers')
        result[key] = value
    return result


def member_name(name):
    # Reject encoding rather than decoding: downstream URL consumers must see
    # exactly the same destination, including double-encoded separators.
    if not name or len(name) > 1024 or any(ord(c) < 32 for c in name) or any(c in name for c in '\\:%<>"|?*') or name.startswith('/'):
        reject('unsafe_member', 'ambiguous or absolute member name')
    parts = name.removesuffix('/').split('/')
    for part in parts:
        stem = part.partition('.')[0].rstrip(' ')
        if not part or part in ('.', '..') or part.endswith(('.', ' ')) or len(part) > 255 or stem.upper() in DEVICES:
            reject('unsafe_member', 'unsafe Windows destination')
    return '/'.join(parts)


def destinations(entries, limits):
    if len(entries) > limits['members']:
        reject('budget_exceeded', 'member count limit')
    seen, leaves, total = {}, set(), 0
    for name, directory, size, compressed in entries:
        normalized = member_name(name)
        key = normalized.casefold()
        if key in seen:
            reject('unsafe_member', 'destination collision')
        seen[key] = directory
        if not directory:
            leaf = normalized.rsplit('/', 1)[-1]
            if leaf.casefold() in leaves:
                reject('unsafe_member', 'submit filename collision')
            leaves.add(leaf.casefold())
            # review.submit publishes basenames and reserves its own metadata.
            if not re.fullmatch(r'[A-Za-z0-9_.-]+', leaf) or leaf.lower() in ('review.json', 'review.md', 'review-thumb.png'):
                reject('unsafe_member', 'unsupported submit filename')
        total += size
        if size > limits['file_bytes'] or total > limits['total_bytes'] or (compressed is not None and size > limits['compression_ratio'] * compressed):
            reject('budget_exceeded', 'declared byte or compression ratio limit')
    for key in seen:
        parts = key.split('/')
        for i in range(1, len(parts)):
            if seen.get('/'.join(parts[:i])) is False:
                reject('unsafe_member', 'file/directory collision')


def zip_plan(source, limits):
    """Bound metadata allocation, then check every central and local name."""
    source.seek(0, os.SEEK_END)
    length = source.tell()
    if length > limits['archive_bytes']:
        reject('budget_exceeded', 'archive byte limit')
    source.seek(max(0, length - 65557))
    tail = source.read(65557)
    end = tail.rfind(b'PK\x05\x06')
    if end < 0 or len(tail) - end < 22:
        reject('corrupt_archive', 'missing or truncated central directory')
    _, disk, cd_disk, disk_count, count, cd_size, cd_offset, comment = struct.unpack('<4s4H2LH', tail[end:end+22])
    if len(tail) - end != 22 + comment or disk or cd_disk or disk_count != count or count == 65535 or cd_offset == 0xffffffff or cd_size == 0xffffffff:
        reject('corrupt_archive', 'invalid or unsupported ZIP directory')
    if count > limits['members'] or cd_size > limits['metadata_bytes']:
        reject('budget_exceeded', 'declared member count or metadata limit')
    if cd_offset + cd_size != length - len(tail) + end:
        reject('corrupt_archive', 'truncated central directory')
    # Count actual records before zipfile allocates ZipInfo objects. Never trust
    # the EOCD count as a bound on the central directory's contents.
    source.seek(cd_offset)
    records, left = 0, cd_size
    while left:
        header = source.read(46)
        if left < 46 or len(header) != 46 or header[:4] != b'PK\x01\x02':
            reject('corrupt_archive', 'invalid central directory record')
        records += 1
        if records > limits['members']:
            reject('budget_exceeded', 'actual member count limit')
        variable = sum(struct.unpack_from('<3H', header, 28))
        left -= 46 + variable
        if left < 0:
            reject('corrupt_archive', 'truncated central directory record')
        source.seek(variable, os.SEEK_CUR)
    if records != count:
        reject('corrupt_archive', 'central directory count mismatch')
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        if len(infos) > limits['members']:
            reject('budget_exceeded', 'actual member count limit')
        if len(infos) != count:
            reject('corrupt_archive', 'central directory count mismatch')
        for info in infos:
            mode = info.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or info.external_attr & 0x400 or (kind == stat.S_IFDIR and not info.is_dir()):
                reject('unsafe_member', 'links and special files are forbidden')
            if info.filename != info.orig_filename:
                reject('unsafe_member', 'NUL in member name')
            if info.flag_bits & ~0x808 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                reject('corrupt_archive', 'unsupported encryption, flags or compression')
            if info.is_dir() and info.file_size:
                reject('corrupt_archive', 'directory contains data')
        destinations([(i.orig_filename, i.is_dir(), i.file_size, i.compress_size) for i in infos], limits)
        plan = []
        previous_end = 0
        for info in sorted(infos, key=lambda i: i.header_offset):
            if info.header_offset != previous_end:
                reject('corrupt_archive', 'overlapping or unlisted local member')
            source.seek(info.header_offset)
            header = source.read(30)
            if len(header) != 30 or header[:4] != b'PK\x03\x04':
                reject('corrupt_archive', 'truncated local header')
            _, _, flags, method, _, _, crc, compressed, size, namesize, extra = struct.unpack('<4s5H3L2H', header)
            name = source.read(namesize).decode('utf-8' if flags & 0x800 else 'cp437')
            member_name(name)
            if name != info.orig_filename or flags != info.flag_bits or method != info.compress_type:
                reject('corrupt_archive', 'local/central header mismatch')
            if not flags & 8 and (crc, compressed, size) != (info.CRC, info.compress_size, info.file_size):
                reject('corrupt_archive', 'local/central size or CRC mismatch')
            offset = info.header_offset + 30 + namesize + extra
            previous_end = offset + info.compress_size
            if flags & 8:
                source.seek(previous_end)
                descriptor = source.read(16)
                signed = descriptor.startswith(b'PK\x07\x08')
                values = descriptor[4:16] if signed else descriptor[:12]
                if len(values) != 12 or struct.unpack('<3L', values) != (info.CRC, info.compress_size, info.file_size):
                    reject('corrupt_archive', 'invalid data descriptor')
                previous_end += 16 if signed else 12
            if previous_end > cd_offset:
                reject('corrupt_archive', 'member extends into central directory')
            plan.append((info, offset))
        if previous_end != cd_offset:
            reject('corrupt_archive', 'unlisted local members')
        return plan


def stream_zip(source, staging, limits):
    plan = zip_plan(source, limits)  # no mkdir/open of a destination before this
    total, files = 0, []
    for index, (info, offset) in enumerate(plan, 1):
        if index > limits['members']:
            reject('budget_exceeded', 'streamed member count limit')
        target = staging / member_name(info.orig_filename)
        if not info.is_dir():
            make_directory(target.parent)
        source.seek(offset)
        remaining, written, crc, consumed = info.compress_size, 0, 0, 0
        decoder = zlib.decompressobj(-15) if info.compress_type == zipfile.ZIP_DEFLATED else None
        with (nullcontext(None) if info.is_dir() else staged_output(target)) as output:
            while remaining:
                data = source.read(min(CHUNK, remaining))
                if not data:
                    reject('corrupt_archive', 'truncated member')
                remaining -= len(data)
                consumed += len(data)
                while data:
                    chunk = decoder.decompress(data, CHUNK) if decoder else data
                    data = decoder.unconsumed_tail if decoder else b''
                    written += len(chunk)
                    total += len(chunk)
                    if written > limits['file_bytes'] or total > limits['total_bytes'] or written > limits['compression_ratio'] * consumed:
                        reject('budget_exceeded', 'streamed byte or compression ratio limit')
                    crc = binascii.crc32(chunk, crc)
                    if output is not None:
                        output.write(chunk)
            if decoder and (not decoder.eof or decoder.unused_data):
                reject('corrupt_archive', 'invalid deflate stream')
            if written != info.file_size or crc != info.CRC:
                reject('corrupt_archive', 'member size or CRC mismatch')
        if not info.is_dir():
            files.append(str(target))
    return files


@contextlib.contextmanager
def staged_output(path):
    with os.fdopen(active_io().open_fd(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL), 'wb') as output:
        yield output
        output.flush()
        os.fsync(output.fileno())


def stage_directory(package, staging, limits):
    io_ = active_io()
    entries, paths, pending = [], [], [package]
    while pending:
        base = pending.pop()
        handle = io_.directory(base)
        with os.scandir(base if io_.kernel else handle) as children:
            for child in children:
                path = base / child.name
                reject_reparse(path)
                info = (path.lstat() if io_.kernel else
                        os.stat(child.name, dir_fd=handle, follow_symlinks=False))
                if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode):
                    reject('unsafe_member', 'links and special files are forbidden')
                directory = stat.S_ISDIR(info.st_mode)
                entries.append((path.relative_to(package).as_posix(), directory,
                                0 if directory else info.st_size, None))
                paths.append(path)
                if len(entries) > limits['members']:
                    reject('budget_exceeded', 'member count limit')
                if directory:
                    io_.directory(path)
                    pending.append(path)
        io_.check(base)
    destinations(entries, limits)  # all names/kinds checked before reading payloads
    total, result = 0, []
    for path, (name, directory, _, _) in zip(paths, entries):
        if directory:
            continue
        target = staging / name
        make_directory(target.parent)
        written = 0
        with open_checked(path, package) as source, staged_output(target) as output:
            while chunk := source.read(CHUNK):
                check_open_file(source, path, package)
                written += len(chunk)
                total += len(chunk)
                if written > limits['file_bytes'] or total > limits['total_bytes']:
                    reject('budget_exceeded', 'streamed byte limit')
                output.write(chunk)
        result.append(str(target))
    return result


def catalog_versions(root, asset, stage):
    path = local_path(root, 'catalog.json')
    if not path.exists():
        return []
    with open_checked(path, root) as stream:
        data = stream.read(review.MAX_LEGACY_CATALOG_BYTES + 1)
        if len(data) > review.MAX_LEGACY_CATALOG_BYTES:
            raise IngestError('catalog exceeds reconciliation budget')
        catalog = json.loads(data)
    return catalog.get('assets', {}).get(asset, {}).get('stages', {}).get(stage, {}).get('versions', [])


def publication_matches(root, asset, stage, event_id):
    return [v for v in catalog_versions(root, asset, stage)
            if v.get('meta', {}).get('ingest', {}).get('event_id') == event_id]


def ingest_package(package, args, *, limits=None):
    """Adapt ZIP/directory staging to the manifest adapter's protected commit.

    A root-local source index binds identity independently of content. Each
    retry verifies fresh staging; complete commit intents recover publication,
    while conflicting content and unowned orphan directories fail closed.
    """
    limits = budgets(limits)
    root, package = Path(args.root).absolute(), Path(package).absolute()
    request = {key: value for key, value in vars(args).items() if key not in ('file', 'package')}
    request['root'] = str(root)
    outcome = dict(schema='r3c-020/ingest-1', status='validating', state='copying',
                   source=str(package), request=request, limits=limits, journal=None, version=None)
    with confined_io() as io_:
        try:
            checked_path(package.parent, package)
            checked_path(root, root / '.ingest')
            review.check_ids(args.asset, args.stage)
            # R3C-111 begin
            require_slot(root, args.asset, args.stage)  # before any adapter write
            # R3C-111 end
            index = root / '.ingest' / ('package-' + digest(dict(source=str(package))))
            make_directory(index, shared=True)
            with package_lock(index):
                marker = index / 'journal.json'
                previous = None
                if marker.exists():
                    previous = read_json(marker, index, 'journal')
                    if (not isinstance(previous, dict) or
                            any(previous.get(key) != outcome[key] for key in ('schema', 'source')) or
                            not isinstance(previous.get('request'), dict) or not isinstance(previous.get('limits'), dict) or
                            previous.get('state') not in ('copying', 'ready', 'failed', 'committing', 'committed') or
                            (previous.get('state') != 'committed' and previous.get('version') is not None) or
                            (previous.get('state') == 'committed' and
                             (type(previous.get('version')) is not int or previous['version'] < 1))):
                        reject('identity_conflict', 'invalid package identity or recovery journal')
                preserve = previous is not None and 'content_digest' in previous
                attempt = index / ('attempt-' + uuid.uuid4().hex)
                staging = attempt / 'staging'
                make_directory(staging)
                outcome['journal'] = str(attempt / 'journal.json')

                def save():
                    if outcome['state'] == 'committing':
                        outcome['status'] = 'committing'
                    atomic_json(Path(outcome['journal']), outcome)
                    if not preserve:
                        atomic_json(marker, outcome)

                save()
                try:
                    if package.is_dir():
                        files = stage_directory(package, staging, limits)
                    else:
                        with open_checked(package, package.parent) as source:
                            files = stream_zip(source, staging, limits)
                    if not files:
                        reject('corrupt_archive', 'empty package')
                    sizes = {Path(f).relative_to(staging).as_posix(): Path(f).stat().st_size for f in files}
                    hashes = {name: file_hash(local_path(staging, name), staging, sizes[name]) for name in sorted(sizes)}
                    meta = review.parse_meta(args.meta)
                    if 'ingest' in meta:
                        reject('unsafe_member', 'meta.ingest is reserved for the adapter')
                    options = {key: getattr(args, key, default) for key, default in SUBMIT_DEFAULTS.items()}
                    destination = dict(asset=args.asset, stage=args.stage)
                    provenance_policy(root, meta, hashes)
                    content = digest(dict(files=hashes, meta=meta, options=options, destination=destination))
                    package_id = index.name
                    outcome.update(schema_version=1, package_id=package_id, content_digest=content,
                                   event_id=digest(dict(package_id=package_id, content_digest=content, destination=destination)),
                                   destination=destination, verified_files=hashes, meta=meta, version=None, state='ready', status='validated')
                    if previous is not None and 'content_digest' in previous and previous['content_digest'] != content:
                        reject('identity_conflict', 'package identity conflict')
                    if previous is not None and previous['state'] in ('committing', 'committed'):
                        commit = PackageCommit(root, index, outcome, sizes, meta)
                        recovered = commit.recover(options)
                        if recovered is None and previous['state'] == 'committing' and commit.release_precommit(options):
                            recovered = False  # nothing was published; fall through to a fresh submit
                        if recovered is None:
                            outcome.update(state='committing', version=None, status='replay_refused',
                                           error=dict(code='post_commit_replay', message='package has no recoverable commit intent'))
                            atomic_json(Path(outcome['journal']), outcome)
                            return outcome
                    preserve = False
                    save()
                    before_versions = catalog_versions(root, args.asset, args.stage)
                    candidate = root / 'items' / args.asset / args.stage / ('v%03d' % (len(before_versions) + 1))
                    outcome['candidate_version'] = len(before_versions) + 1
                    submit_staged(root, attempt, outcome, sizes, meta, options, args.asset, args.stage, save,
                                  staging_name='staging', commit_work=index)
                    outcome['status'] = 'submitted'
                    save()
                    io_.remove_tree(staging)
                    return outcome
                except (Exception, SystemExit) as exc:
                    # R3C-111 begin
                    if isinstance(exc, QueueFull):
                        outcome.update(state='failed', status='failed', error=exc.error)
                    # R3C-111 end
                    elif outcome['state'] == 'committed':
                        # Publication was reconciled before this bookkeeping or
                        # cleanup failure. Never downgrade its version identity.
                        outcome.update(status='committed',
                                       error=dict(code='post_commit_error', message=str(exc)))
                    elif outcome['state'] == 'committing':
                        # Retain uncertain publication identity when bounded
                        # reconciliation cannot prove both catalog and event.
                        try:
                            after_versions = catalog_versions(root, args.asset, args.stage)
                            matches = [v for v in after_versions if v.get('meta', {}).get('ingest', {}).get('event_id') == outcome['event_id']]
                            precommit = after_versions == before_versions and not local_path(root, candidate.relative_to(root).as_posix()).exists()
                            complete = len(matches) == 1 and PackageCommit(root, index, outcome, sizes, meta).has_event(matches[0])
                        except (ValueError, OSError):
                            matches, precommit, complete = [], False, False
                        if complete:
                            outcome.update(state='committed', status='committed', version=matches[0]['v'],
                                           error=dict(code='post_commit_error', message=str(exc)))
                        elif precommit:
                            outcome.update(state='failed', status='failed', error=dict(code='submit_failed', message=str(exc)))
                        else:
                            outcome.update(status='committing', error=dict(code='submit_uncertain', message=str(exc)))
                    else:
                        outcome.update(state='failed', status='failed', error=(exc.error if isinstance(exc, ArchiveError) else
                            dict(code='unsafe_member' if isinstance(exc, IngestError) else 'corrupt_archive', message=str(exc))))
                    try:
                        save()
                    except (IngestError, OSError) as journal_error:
                        if outcome['state'] not in ('committing', 'committed'):
                            raise
                        # Keep the durable committing marker available for
                        # recovery if committed bookkeeping cannot persist.
                        outcome['error']['journal_error'] = str(journal_error)
                    return outcome
        # R3C-111 begin
        except QueueFull as exc:
            outcome.update(state='failed', status='failed', error=exc.error)
            return outcome
        # R3C-111 end
        except (IngestError, OSError) as exc:
            # An unsafe scratch ancestor must not receive even a failed journal.
            busy = getattr(exc, 'winerror', None) == 32  # a sharing violation is contention, not an unsafe member
            outcome.update(state='failed', status='failed', error=(exc.error if isinstance(exc, ArchiveError) else
                           dict(code='package_busy' if busy else 'unsafe_member', message=str(exc))))
            return outcome


def main_package(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', help='directory or ZIP containing deliverables')
    for key in ('root', 'asset', 'stage'):
        parser.add_argument('--' + key, required=True)
    for key in ('project', 'name', 'note', 'meta', 'route', 'thread', 'resolves', 'choice', 'skip-gate', 'build-id'):
        parser.add_argument('--' + key)
    parser.add_argument('--by', default='agent')
    parser.add_argument('--response', action='append')
    parser.add_argument('--skip-render', action='store_true')
    parser.add_argument('--phone-clients', type=int)
    parser.add_argument('--claim-players', type=int)
    args = parser.parse_args(argv)
    # Preserve submit diagnostics while keeping stdout a structured outcome.
    with redirect_stdout(sys.stderr):
        result = ingest(args.package, args)
    print(json.dumps(result, sort_keys=True))
    # R3C-111 begin
    if result.get('error', {}).get('code') == 'queue_full':
        print(result['error']['message'], file=sys.stderr)
        return QueueFull.exit_code
    # R3C-111 end
    return 0 if result['status'] == 'submitted' else 1



def ingest(root=None, manifest=None, *, package=None, args=None, limits=None):
    if args is not None:
        if manifest is not None or package is not None and root is not None:
            raise TypeError('use either root/manifest or package/args')
        return ingest_package(package if package is not None else root, args, limits=limits)
    if package is not None:
        raise TypeError('package ingestion requires args')
    if isinstance(manifest, argparse.Namespace) or (
            not isinstance(manifest, (str, bytes, os.PathLike)) and hasattr(manifest, 'root')):
        return ingest_package(root, manifest, limits=limits)
    if limits is not None:
        raise ValueError('manifest ingestion uses its declared resource limits')
    return ingest_manifest(root, manifest)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if any(value == '--manifest' or value.startswith('--manifest=') for value in argv):
        return main_manifest(argv)
    return main_package(argv)


if __name__ == '__main__':
    sys.exit(main())
