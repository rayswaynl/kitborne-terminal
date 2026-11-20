"""Owner-managed, root-local provenance policy; submitted metadata is never read here."""
from dataclasses import dataclass
import ctypes
import json
import os
from pathlib import Path
import stat
import struct

if __package__:
    from .evidence_export import no_symlinks, open_source, windows_directory_locks
else:
    from evidence_export import no_symlinks, open_source, windows_directory_locks

POLICY_NAME = '.provenance-policy.json'
POLICY_LIMIT = 64 * 1024
WINDOWS_ACE_LIMIT = 256
# Generic all/write, delete, change ACL/owner, file/directory content and metadata
# writes. SYSTEM and Administrators remain trusted local administrators.
WINDOWS_WRITE_MASK = 0x500D0156
WINDOWS_ADMIN_SIDS = frozenset({'S-1-5-18', 'S-1-5-32-544'})


class PolicyError(ValueError):
    """Stable fail-closed diagnostic, independent of paths or parser details."""


@dataclass(frozen=True)
class TrustedPolicy:
    require_provenance: bool = False
    allowed_licences: tuple[str, ...] | None = None


class _WindowsSecurity:
    """Read owner and DACL from handles; bound ACL work and fail on unknown ACEs."""

    def __init__(self):
        from ctypes import wintypes
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.advapi = ctypes.WinDLL('advapi32', use_last_error=True)
        self.kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        self.kernel.CreateFileW.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.kernel.LocalFree.argtypes = [ctypes.c_void_p]
        self.kernel.LocalFree.restype = ctypes.c_void_p
        self.advapi.GetSecurityInfo.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.DWORD,
            *([ctypes.POINTER(ctypes.c_void_p)] * 5)]
        self.advapi.GetSecurityInfo.restype = wintypes.DWORD
        self.advapi.IsValidAcl.argtypes = [ctypes.c_void_p]
        self.advapi.IsValidAcl.restype = wintypes.BOOL
        self.advapi.GetAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
        self.advapi.GetAce.restype = wintypes.BOOL
        self.advapi.IsValidSid.argtypes = [ctypes.c_void_p]
        self.advapi.IsValidSid.restype = wintypes.BOOL
        self.advapi.GetLengthSid.argtypes = [ctypes.c_void_p]
        self.advapi.GetLengthSid.restype = wintypes.DWORD
        self.advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
        self.advapi.ConvertSidToStringSidW.restype = wintypes.BOOL

    def directory(self, root):
        # READ_CONTROL, SHARE_READ|WRITE (no DELETE), OPEN_EXISTING,
        # BACKUP_SEMANTICS|OPEN_REPARSE_POINT. Ancestors are pinned separately.
        handle = self.kernel.CreateFileW(str(root), 0x20000, 3, None, 3, 0x02200000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise OSError('cannot read root security')
        return handle

    def sid(self, pointer):
        from ctypes import wintypes
        if (not pointer or not self.advapi.IsValidSid(pointer)
                or not 8 <= self.advapi.GetLengthSid(pointer) <= 68):
            raise ValueError('invalid owner or trustee SID')
        label = wintypes.LPWSTR()
        if not self.advapi.ConvertSidToStringSidW(pointer, ctypes.byref(label)):
            raise OSError('cannot read trustee SID')
        try:
            if not label.value:
                raise ValueError('missing trustee SID')
            return label.value
        finally:
            self.kernel.LocalFree(ctypes.cast(label, ctypes.c_void_p))

    def snapshot(self, handle):
        owner, dacl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
        # SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION.
        result = self.advapi.GetSecurityInfo(handle, 1, 5, ctypes.byref(owner), None,
            ctypes.byref(dacl), None, ctypes.byref(descriptor))
        try:
            if result or not descriptor or not dacl or not self.advapi.IsValidAcl(dacl):
                raise ValueError('missing or unreadable policy ACL')
            owner_sid = self.sid(owner)
            _, _, size, count, _ = struct.unpack('<BBHHH', ctypes.string_at(dacl, 8))
            if size < 8 or count > WINDOWS_ACE_LIMIT:
                raise ValueError('policy ACL exceeds inspection budget')
            writers = []
            for index in range(count):
                ace = ctypes.c_void_p()
                if not self.advapi.GetAce(dacl, index, ctypes.byref(ace)):
                    raise ValueError('unreadable policy ACE')
                if not ace or not dacl.value + 8 <= ace.value <= dacl.value + size - 4:
                    raise ValueError('policy ACE outside ACL')
                kind, flags, length = struct.unpack('<BBH', ctypes.string_at(ace, 4))
                if length < 16 or ace.value + length > dacl.value + size or kind not in (0, 1):
                    raise ValueError('unsupported policy ACE')
                # Inherit-only entries do not grant access to this object. Deny
                # entries grant nothing; broad allow entries are conservatively
                # refused even if another ACE would deny some of their rights.
                if flags & 8 or kind == 1:
                    continue
                mask, = struct.unpack('<I', ctypes.string_at(ace.value + 4, 4))
                if mask & WINDOWS_WRITE_MASK:
                    sid = ace.value + 8
                    if not self.advapi.IsValidSid(sid) or self.advapi.GetLengthSid(sid) > length - 8:
                        raise ValueError('policy trustee outside ACE')
                    trustee = self.sid(sid)
                    # OWNER RIGHTS denotes this object's owner, not an unrelated writer.
                    writers.append(owner_sid if trustee == 'S-1-3-4' else trustee)
            return owner_sid, tuple(writers)
        finally:
            if descriptor:
                self.kernel.LocalFree(descriptor)


def _windows_owner_managed(root, fd):
    import msvcrt
    api = _WindowsSecurity()
    with windows_directory_locks(root):
        directory = api.directory(root)
        try:
            root_owner, root_writers = api.snapshot(directory)
            file_owner, file_writers = api.snapshot(msvcrt.get_osfhandle(fd))
            trusted = WINDOWS_ADMIN_SIDS | {root_owner}
            if file_owner != root_owner or any(sid not in trusted for sid in root_writers + file_writers):
                raise ValueError('policy must be owner-managed')
        finally:
            api.kernel.CloseHandle(directory)


def _owner_managed(root, source, root_info, info):
    if info.st_nlink != 1:
        raise ValueError('linked policy is not owner-managed')
    if os.name == 'nt':
        _windows_owner_managed(root, source.fileno())
    elif info.st_uid != root_info.st_uid or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise ValueError('policy must be owner-managed')


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate policy key')
        result[key] = value
    return result


def load_policy(root):
    """Read at most 64 KiB from a confined regular file owned by the root owner.

    Missing configuration preserves legacy submissions. Links, shared-writable
    files, malformed JSON and unsupported schemas fail before preflight/copying.
    Existing descriptor-anchored reads reject symlinked ancestors and swaps.
    This loader never creates or updates trusted configuration.
    """
    root = Path(os.path.abspath(root))
    try:
        no_symlinks(root)
        owner = root.stat()
        if not stat.S_ISDIR(owner.st_mode):
            raise ValueError('root must be a directory')
        try:
            (root / POLICY_NAME).lstat()
        except FileNotFoundError:
            return TrustedPolicy()
        with open_source(root, POLICY_NAME) as source:
            info = os.fstat(source.fileno())
            _owner_managed(root, source, owner, info)
            if info.st_size > POLICY_LIMIT:
                raise PolicyError('provenance.policy_oversized')
            raw = source.read(POLICY_LIMIT + 1)
        if len(raw) > POLICY_LIMIT:
            raise PolicyError('provenance.policy_oversized')
        value = json.loads(raw, object_pairs_hook=_unique)
        if (not isinstance(value, dict)
                or set(value) != {'schema_version', 'require_provenance', 'allowed_licences'}
                or type(value['schema_version']) is not int or value['schema_version'] != 1
                or type(value['require_provenance']) is not bool):
            raise ValueError('invalid policy schema')
        licences = value['allowed_licences']
        if licences is not None and (not isinstance(licences, list)
                or any(not isinstance(label, str) or not label.strip() for label in licences)):
            raise ValueError('invalid policy licences')
        return TrustedPolicy(value['require_provenance'],
                             None if licences is None else tuple(licences))
    except PolicyError:
        raise
    except (OSError, ValueError, RecursionError):
        raise PolicyError('provenance.policy_invalid') from None
