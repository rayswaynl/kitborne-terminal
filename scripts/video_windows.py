"""Windows decoder boundary: read-only snapshot, AppContainer and suspended job.

Imported only on Windows. All native failures are fatal to this boundary.
"""

import contextlib
import ctypes as c
from ctypes import wintypes as w
import hashlib
import msvcrt
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

PROFILE = 'AssetReview.VideoDecoder.v1'
NAMESPACE_BOUNDARY = 'AssetReview.VideoDecoder.Boundary'
MEDIUM_INTEGRITY = 0x2000
# Mandatory label: below-Medium (Low) same-user processes get no read, write or
# execute (SYNCHRONIZE) access to the lock mutex or namespace.
LOCK_SDDL = 'D:P(A;;GA;;;%s)S:(ML;;NWNRNX;;;ME)'
MEMORY_BYTES = 256 * 1024 * 1024
CPU_SECONDS = 8
_stage_lock = threading.Lock()
P = c.c_void_p
SIZE = c.c_size_t


class IsolationError(OSError):
    pass


def _api(dll, name, restype, *args):
    function = getattr(dll, name)
    function.restype, function.argtypes = restype, list(args)
    return function


k = c.WinDLL('kernel32', use_last_error=True)
a = c.WinDLL('advapi32', use_last_error=True)
u = c.WinDLL('userenv', use_last_error=True)


class SecurityAttributes(c.Structure):
    _fields_ = [('length', w.DWORD), ('descriptor', P), ('inherit', w.BOOL)]


class FileInfo(c.Structure):
    _fields_ = [
        ('attributes', w.DWORD),
        ('creation', w.FILETIME),
        ('access', w.FILETIME),
        ('write', w.FILETIME),
        ('volume', w.DWORD),
        ('size_high', w.DWORD),
        ('size_low', w.DWORD),
        ('links', w.DWORD),
        ('index_high', w.DWORD),
        ('index_low', w.DWORD),
    ]


class Capabilities(c.Structure):
    _fields_ = [('sid', P), ('capabilities', P), ('count', w.DWORD), ('reserved', w.DWORD)]


class SidAttributes(c.Structure):
    _fields_ = [('sid', P), ('attributes', w.DWORD)]


class Startup(c.Structure):
    _fields_ = [
        ('cb', w.DWORD),
        ('reserved', w.LPWSTR),
        ('desktop', w.LPWSTR),
        ('title', w.LPWSTR),
        ('x', w.DWORD),
        ('y', w.DWORD),
        ('xsize', w.DWORD),
        ('ysize', w.DWORD),
        ('xchars', w.DWORD),
        ('ychars', w.DWORD),
        ('fill', w.DWORD),
        ('flags', w.DWORD),
        ('show', w.WORD),
        ('reserved_size', w.WORD),
        ('reserved_bytes', P),
        ('stdin', w.HANDLE),
        ('stdout', w.HANDLE),
        ('stderr', w.HANDLE),
    ]


class StartupEx(c.Structure):
    _fields_ = [('startup', Startup), ('attributes', P)]


class ProcessInfo(c.Structure):
    _fields_ = [('process', w.HANDLE), ('thread', w.HANDLE), ('pid', w.DWORD), ('tid', w.DWORD)]


class BasicLimit(c.Structure):
    _fields_ = [
        ('process_time', c.c_longlong),
        ('job_time', c.c_longlong),
        ('flags', w.DWORD),
        ('min_working_set', SIZE),
        ('max_working_set', SIZE),
        ('active', w.DWORD),
        ('affinity', SIZE),
        ('priority', w.DWORD),
        ('scheduling', w.DWORD),
    ]


class IoCounters(c.Structure):
    _fields_ = [
        (name, c.c_ulonglong)
        for name in (
            'read_ops',
            'write_ops',
            'other_ops',
            'read_bytes',
            'write_bytes',
            'other_bytes',
        )
    ]


class ExtendedLimit(c.Structure):
    _fields_ = [
        ('basic', BasicLimit),
        ('io', IoCounters),
        ('process_memory', SIZE),
        ('job_memory', SIZE),
        ('peak_process_memory', SIZE),
        ('peak_job_memory', SIZE),
    ]


create_file = _api(
    k, 'CreateFileW', w.HANDLE, w.LPCWSTR, w.DWORD, w.DWORD, P, w.DWORD, w.DWORD, w.HANDLE
)
create_directory = _api(k, 'CreateDirectoryW', w.BOOL, w.LPCWSTR, P)
close_handle = _api(k, 'CloseHandle', w.BOOL, w.HANDLE)
file_info = _api(k, 'GetFileInformationByHandle', w.BOOL, w.HANDLE, P)
set_file_info = _api(k, 'SetFileInformationByHandle', w.BOOL, w.HANDLE, c.c_int, P, w.DWORD)
current_process = _api(k, 'GetCurrentProcess', w.HANDLE)
duplicate = _api(
    k, 'DuplicateHandle', w.BOOL, w.HANDLE, w.HANDLE, w.HANDLE, P, w.DWORD, w.BOOL, w.DWORD
)
local_free = _api(k, 'LocalFree', P, P)
free_sid = _api(a, 'FreeSid', P, P)
create_profile = _api(
    u, 'CreateAppContainerProfile', c.c_long, w.LPCWSTR, w.LPCWSTR, w.LPCWSTR, P, w.DWORD, P
)
derive_sid = _api(u, 'DeriveAppContainerSidFromAppContainerName', c.c_long, w.LPCWSTR, P)
delete_profile = _api(u, 'DeleteAppContainerProfile', c.c_long, w.LPCWSTR)
sid_string = _api(a, 'ConvertSidToStringSidW', w.BOOL, P, P)
open_token = _api(a, 'OpenProcessToken', w.BOOL, w.HANDLE, w.DWORD, P)
token_info = _api(a, 'GetTokenInformation', w.BOOL, w.HANDLE, c.c_int, P, w.DWORD, P)
parse_sd = _api(
    a, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', w.BOOL, w.LPCWSTR, w.DWORD, P, P
)
get_dacl = _api(a, 'GetSecurityDescriptorDacl', w.BOOL, P, P, P, P)
set_security = _api(a, 'SetSecurityInfo', w.DWORD, w.HANDLE, c.c_int, w.DWORD, P, P, P, P)
get_security = _api(a, 'GetSecurityInfo', w.DWORD, w.HANDLE, c.c_int, w.DWORD, P, P, P, P, P)
equal_sid = _api(a, 'EqualSid', w.BOOL, P, P)
get_heap = _api(k, 'GetProcessHeap', w.HANDLE)
heap_free = _api(k, 'HeapFree', w.BOOL, w.HANDLE, w.DWORD, P)
network_config = _api(
    c.WinDLL('FirewallAPI', use_last_error=True),
    'NetworkIsolationGetAppContainerConfig',
    w.DWORD,
    P,
    P,
)
create_job = _api(k, 'CreateJobObjectW', w.HANDLE, P, w.LPCWSTR)
set_job = _api(k, 'SetInformationJobObject', w.BOOL, w.HANDLE, c.c_int, P, w.DWORD)
assign_job = _api(k, 'AssignProcessToJobObject', w.BOOL, w.HANDLE, w.HANDLE)
init_attributes = _api(k, 'InitializeProcThreadAttributeList', w.BOOL, P, w.DWORD, w.DWORD, P)
update_attribute = _api(k, 'UpdateProcThreadAttribute', w.BOOL, P, w.DWORD, SIZE, P, SIZE, P, P)
delete_attributes = _api(k, 'DeleteProcThreadAttributeList', None, P)
create_process = _api(
    k, 'CreateProcessW', w.BOOL, w.LPCWSTR, w.LPWSTR, P, P, w.BOOL, w.DWORD, P, w.LPCWSTR, P, P
)
resume_thread = _api(k, 'ResumeThread', w.DWORD, w.HANDLE)
terminate_process = _api(k, 'TerminateProcess', w.BOOL, w.HANDLE, w.UINT)
wait_process = _api(k, 'WaitForSingleObject', w.DWORD, w.HANDLE, w.DWORD)
exit_code = _api(k, 'GetExitCodeProcess', w.BOOL, w.HANDLE, P)
system_directory = _api(k, 'GetSystemDirectoryW', w.UINT, w.LPWSTR, w.UINT)
create_mutex = _api(k, 'CreateMutexW', w.HANDLE, P, w.BOOL, w.LPCWSTR)
release_mutex = _api(k, 'ReleaseMutex', w.BOOL, w.HANDLE)
create_boundary = _api(k, 'CreateBoundaryDescriptorW', w.HANDLE, w.LPCWSTR, w.ULONG)
add_boundary_sid = _api(k, 'AddSIDToBoundaryDescriptor', w.BOOL, P, P)
add_integrity_label = _api(k, 'AddIntegrityLabelToBoundaryDescriptor', w.BOOL, P, P)
delete_boundary = _api(k, 'DeleteBoundaryDescriptor', None, w.HANDLE)
create_namespace = _api(k, 'CreatePrivateNamespaceW', w.HANDLE, P, P, w.LPCWSTR)
open_namespace = _api(k, 'OpenPrivateNamespaceW', w.HANDLE, P, w.LPCWSTR)
close_namespace = _api(k, 'ClosePrivateNamespace', w.BOOLEAN, w.HANDLE, w.ULONG)
parse_sid = _api(a, 'ConvertStringSidToSidW', w.BOOL, w.LPCWSTR, P)


def _check(ok, operation):
    if not ok:
        raise IsolationError('%s failed (WinError %d)' % (operation, c.get_last_error()))
    return ok


def _extended_path(path):
    path = str(path)
    if path.startswith('\\\\?\\'):
        return path
    return ('\\\\?\\UNC\\' + path[2:]) if path.startswith('\\\\') else '\\\\?\\' + path


def _file(path, access, share=1, disposition=3, flags=0x00200000):
    handle = create_file(_extended_path(path), access, share, None, disposition, flags, None)
    if handle == w.HANDLE(-1).value:
        _check(False, 'CreateFileW')
    info = FileInfo()
    try:
        _check(file_info(handle, c.byref(info)), 'GetFileInformationByHandle')
        if info.attributes & 0x400:
            raise IsolationError('reparse-point handle refused')
        if access & 0x40000 and not info.attributes & 0x10 and info.links != 1:
            raise IsolationError('hard-linked cache file refused before ACL grant')
        return handle
    except BaseException:
        close_handle(handle)
        raise


def _stream(handle, mode):
    try:
        fd = msvcrt.open_osfhandle(
            handle, os.O_BINARY | (os.O_RDONLY if mode == 'rb' else os.O_RDWR)
        )
    except BaseException:
        close_handle(handle)
        raise
    return os.fdopen(fd, mode, buffering=0)


@contextlib.contextmanager
def open_source(path, *, share=3):
    # Deny directory deletion while resolving the final file. Every opened
    # component is inspected without following a reparse point.
    with contextlib.ExitStack() as stack:
        _pin_directories(Path(path).parent, stack)
        source = _stream(_file(path, 0x80000000, share=share), 'rb')
        stack.callback(source.close)
        yield source


def _pin_directories(directory, stack):
    for parent in [*reversed(directory.parents), directory]:
        handle = _file(parent, 0x80, share=3, flags=0x02200000)
        stack.callback(close_handle, handle)


class Source:
    def __init__(self, path):
        self._context = open_source(path)
        self._source = self._context.__enter__()

    def __getattr__(self, name):
        return getattr(self._source, name)

    def close(self):
        self._context.__exit__(None, None, None)


def state_root():
    root = os.environ.get('ASSET_REVIEW_TEST_STATE')
    if not root:
        registry = os.environ.get('ASSET_REVIEW_PROJECTS')
        if not registry:
            for module in ('review', '__main__'):
                registry = getattr(sys.modules.get(module), 'PROJECTS', None)
                if registry:
                    break
        root = str(Path(registry).absolute().parent) if registry else None
    if not root or not Path(root).is_absolute():
        raise IsolationError('review state root unavailable')
    return Path(root)


def snapshot(source, max_bytes, deadline, copy_and_hash):
    root = state_root() / 'video-decoder-snapshots'
    with contextlib.ExitStack() as stack:
        private_directory(root, None, stack)
        handle = _file(
            root / (uuid.uuid4().hex + '.tmp'), 0xC0000000, disposition=1, flags=0x04000100
        )  # TEMPORARY | DELETE_ON_CLOSE; SHARE_READ only
        output = stack.enter_context(_stream(handle, 'w+b'))
        digest, size = copy_and_hash(source, max_bytes, deadline, output)
        output.seek(0)
        readonly = w.HANDLE()
        # The sole handle inherited by the decoder has FILE_GENERIC_READ, never
        # WRITE_DATA, DELETE, WRITE_DAC or DUPLICATE_SAME_ACCESS.
        _check(
            duplicate(
                current_process(),
                handle,
                current_process(),
                c.byref(readonly),
                0x00120089,
                False,
                0,
            ),
            'snapshot read-only DuplicateHandle',
        )
        return _stream(readonly.value, 'rb'), digest, size


@contextlib.contextmanager
def _user_namespace(deadline):
    # The lock lives in a private namespace whose boundary holds the caller's SID plus
    # the Medium integrity label, and whose DACL admits only that SID with a mandatory
    # label: no other account and no Low-integrity process of the same user can
    # pre-create, open or join it. Callers below Medium fail closed.
    if _integrity_level() < MEDIUM_INTEGRITY:
        raise IsolationError('profile lock requires Medium integrity or higher')
    user = _user_sid()
    sid, label, boundary, namespace, descriptor = P(), P(), P(), None, P()
    alias = 'AssetReview' + uuid.uuid4().hex  # process-local label; one per call avoids DUP_NAME
    _check(parse_sid(user, c.byref(sid)), 'ConvertStringSidToSidW')
    try:
        _check(parse_sid('S-1-16-%d' % MEDIUM_INTEGRITY, c.byref(label)), 'integrity label SID')
        boundary.value = create_boundary(NAMESPACE_BOUNDARY, 0)
        _check(boundary, 'CreateBoundaryDescriptorW')
        _check(add_boundary_sid(c.byref(boundary), sid), 'AddSIDToBoundaryDescriptor')
        _check(add_integrity_label(c.byref(boundary), label), 'AddIntegrityLabelToBoundary')
        _check(parse_sd(LOCK_SDDL % user, 1, c.byref(descriptor), None), 'namespace ACL descriptor')
        attributes = SecurityAttributes(c.sizeof(SecurityAttributes), descriptor, False)
        while not namespace:
            namespace = create_namespace(c.byref(attributes), boundary, alias)
            error = c.get_last_error()
            if not namespace and error == 183:  # ERROR_ALREADY_EXISTS: join the live namespace
                namespace = open_namespace(boundary, alias)
                error = c.get_last_error()
            if not namespace:
                # The last holder may close the namespace between the two calls: retry.
                if error not in (2, 3, 183):
                    raise IsolationError('profile namespace failed (WinError %d)' % error)
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired('AppContainer profile namespace', CPU_SECONDS)
                time.sleep(0.01)
        yield alias
    finally:
        if namespace:
            close_namespace(namespace, 0)
        if boundary:
            delete_boundary(boundary)
        if descriptor:
            local_free(descriptor)
        if label:
            local_free(label)
        local_free(sid)


@contextlib.contextmanager
def _profile_guard(name, deadline):
    key = hashlib.sha256((_user_sid() + ':' + name.casefold()).encode()).hexdigest()
    with _user_namespace(deadline) as alias:
        with _profile_mutex(alias + '\\Profile.' + key, deadline):
            yield


@contextlib.contextmanager
def _profile_mutex(lock, deadline):
    descriptor = P()
    _check(parse_sd(LOCK_SDDL % _user_sid(), 1, c.byref(descriptor), None), 'lock ACL descriptor')
    try:
        attributes = SecurityAttributes(c.sizeof(SecurityAttributes), descriptor, False)
        handle = create_mutex(c.byref(attributes), False, lock)
        error = c.get_last_error()
    finally:
        local_free(descriptor)
    if not handle:
        raise IsolationError('profile CreateMutexW failed (WinError %d)' % error)
    try:
        status = wait_process(handle, max(0, int((deadline - time.monotonic()) * 1000)))
        if status == 258:
            raise subprocess.TimeoutExpired('AppContainer profile lock', CPU_SECONDS)
        _check(status in (0, 0x80), 'profile mutex wait')  # abandoned also grants ownership
        try:
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired('AppContainer profile setup', CPU_SECONDS)
            yield
        finally:
            _check(release_mutex(handle), 'profile ReleaseMutex')
    finally:
        close_handle(handle)


@contextlib.contextmanager
def profile(name=None, *, deadline=None):
    name = name or PROFILE
    sid = P()
    deadline = time.monotonic() + CPU_SECONDS if deadline is None else deadline
    try:
        with _profile_guard(name, deadline):
            hr = create_profile(name, name, 'Isolated video decoder', None, 0, c.byref(sid))
            if hr == -2147024713:  # HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)
                hr = derive_sid(name, c.byref(sid))
            if hr != 0 or not sid:
                raise IsolationError(
                    'AppContainer profile failed (HRESULT 0x%08x)' % (hr & 0xFFFFFFFF)
                )
            expected = P()
            try:
                if (
                    derive_sid(name, c.byref(expected)) != 0
                    or not expected
                    or not equal_sid(sid, expected)
                ):
                    raise IsolationError('AppContainer profile SID mismatch')
            finally:
                if expected:
                    free_sid(expected)
            deny_loopback_exemption(sid)
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired('AppContainer profile setup', CPU_SECONDS)
        yield sid
    finally:
        if sid:
            free_sid(sid)


def deny_loopback_exemption(sid):
    count, entries = w.DWORD(), P()
    error = network_config(c.byref(count), c.byref(entries))
    if error:
        raise IsolationError('AppContainer loopback config query failed (WinError %d)' % error)
    records = c.cast(entries, c.POINTER(SidAttributes))
    try:
        if any(equal_sid(sid, records[i].sid) for i in range(count.value)):
            raise IsolationError(
                'AppContainer has a loopback exemption; network isolation unavailable'
            )
    finally:
        for i in range(count.value):
            heap_free(get_heap(), 0, records[i].sid)
        if entries:
            heap_free(get_heap(), 0, entries)


def _sid_text(sid):
    text = w.LPWSTR()
    _check(sid_string(sid, c.byref(text)), 'ConvertSidToStringSidW')
    try:
        return text.value
    finally:
        local_free(text)


def _user_sid():
    return _token_sid(1)  # TokenUser


def _integrity_level():
    return int(_token_sid(25).rsplit('-', 1)[1])  # TokenIntegrityLevel: S-1-16-<rid>


def _token_sid(kind):
    token, size = w.HANDLE(), w.DWORD()
    _check(open_token(current_process(), 8, c.byref(token)), 'OpenProcessToken')
    try:
        token_info(token, kind, None, 0, c.byref(size))
        buffer = c.create_string_buffer(size.value)
        _check(token_info(token, kind, buffer, size, c.byref(size)), 'GetTokenInformation')
        return _sid_text(c.cast(buffer, c.POINTER(P))[0])
    finally:
        close_handle(token)


@contextlib.contextmanager
def _cache_descriptor(sid):
    # Protected ACL: current user owns the cache; only this package gets RX.
    sd = P()
    sddl = 'D:P(A;;FA;;;%s)' % _user_sid()
    if sid:
        sddl += '(A;;FRFX;;;%s)' % _sid_text(sid)
    _check(parse_sd(sddl, 1, c.byref(sd), None), 'cache ACL descriptor')
    try:
        yield sd
    finally:
        local_free(sd)


@contextlib.contextmanager
def _cache_dacl(sid):
    with _cache_descriptor(sid) as sd:
        present, defaulted, dacl = w.BOOL(), w.BOOL(), P()
        _check(
            get_dacl(sd, c.byref(present), c.byref(dacl), c.byref(defaulted)),
            'cache ACL extraction',
        )
        yield dacl


def grant_access(path, sid):
    with _cache_dacl(sid) as dacl:
        handle = _file(path, 0x00060000, flags=0x02200000)
        try:
            error = set_security(handle, 1, 0x80000004, None, None, dacl, None)
            if error:
                raise IsolationError('cache ACL grant failed (WinError %d)' % error)
        finally:
            close_handle(handle)


def private_directory(path, sid, stack):
    # Reapplying a directory ACL propagates to children, including hard links.
    # Create with the private ACL atomically; verify existing ACLs without writes.
    with _cache_descriptor(sid) as sd:
        attributes = SecurityAttributes(c.sizeof(SecurityAttributes), sd, False)
        if not create_directory(_extended_path(path), c.byref(attributes)):
            if c.get_last_error() != 183:  # ERROR_ALREADY_EXISTS
                _check(False, 'cache directory creation')
    _pin_directories(path, stack)
    with _cache_dacl(sid) as expected:
        handle = _file(path, 0x20000, flags=0x02200000)
        actual, sd = P(), P()
        try:
            error = get_security(handle, 1, 4, None, None, c.byref(actual), None, c.byref(sd))
            if error:
                raise IsolationError('cache ACL verification failed (WinError %d)' % error)

            def acl_bytes(pointer):
                size = c.cast(pointer, c.POINTER(c.c_ushort))[1]
                return c.string_at(pointer, size)

            if not actual or acl_bytes(actual) != acl_bytes(expected):
                raise IsolationError('cache directory ACL mismatch')
        finally:
            if sd:
                local_free(sd)
            close_handle(handle)


def _hash(source, deadline):
    digest = hashlib.sha256()
    size = 0
    while True:
        if time.monotonic() >= deadline:
            raise subprocess.TimeoutExpired('decoder staging', CPU_SECONDS)
        chunk = source.read(65536)
        if not chunk:
            source.seek(0)
            return digest.hexdigest()
        size += len(chunk)
        if size > 256 * 1024 * 1024:
            raise IsolationError('decoder executable/DLL byte budget')
        digest.update(chunk)


def verify_hash(source, expected, deadline):
    if _hash(source, deadline) != expected:
        raise IsolationError('staged decoder hash re-verify failed')


@contextlib.contextmanager
def _stage_guard(deadline):
    if not _stage_lock.acquire(timeout=max(0, deadline - time.monotonic())):
        raise subprocess.TimeoutExpired('decoder staging lock', CPU_SECONDS)
    try:
        yield
    finally:
        _stage_lock.release()


def _copy_staged(source, target, digest, sid, deadline):
    temporary = target.with_name(uuid.uuid4().hex + '.tmp')
    handle = _file(temporary, 0xC0050000, share=0, disposition=1)
    with _stream(handle, 'w+b') as output:
        published = False
        try:
            while chunk := source.read(65536):
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired('decoder staging', CPU_SECONDS)
                output.write(chunk)
            output.seek(0)
            verify_hash(output, digest, deadline)
            with _cache_dacl(sid) as dacl:
                error = set_security(handle, 1, 0x80000004, None, None, dacl, None)
                if error:
                    raise IsolationError('cache ACL grant failed (WinError %d)' % error)

            name = _extended_path(target.absolute())
            encoded_name = name.encode('utf-16-le')

            class RenameInfo(c.Structure):
                _fields_ = [
                    ('replace', w.BOOLEAN),
                    ('root', w.HANDLE),
                    ('length', w.DWORD),
                    ('name', w.WCHAR * (len(encoded_name) // c.sizeof(w.WCHAR) + 1)),
                ]

            rename = RenameInfo(False, None, len(encoded_name), name)
            _check(set_file_info(handle, 3, c.byref(rename), c.sizeof(rename)), 'cache publish')
            published = True
        finally:
            if not published:
                delete = w.BOOLEAN(True)
                _check(
                    set_file_info(handle, 4, c.byref(delete), c.sizeof(delete)), 'staging cleanup'
                )


@contextlib.contextmanager
def staged(executable, sid, deadline):
    executable = Path(executable).resolve(strict=True)
    files = [executable, *sorted(executable.parent.glob('*.dll'))]
    if len(files) > 65:
        raise IsolationError('decoder DLL count budget')
    with _stage_guard(deadline), contextlib.ExitStack() as stack:
        originals = [stack.enter_context(open_source(path, share=1)) for path in files]
        hashes = [_hash(source, deadline) for source in originals]
        key = hashlib.sha256(
            repr([(p.name, h) for p, h in zip(files, hashes)]).encode()
        ).hexdigest()
        root = state_root() / 'video-decoder-cache'
        private_directory(root, sid, stack)
        directory = root / key
        private_directory(directory, sid, stack)
        for path, source, digest in zip(files, originals, hashes):
            target = directory / path.name
            if not Path(_extended_path(target)).exists():
                _copy_staged(source, target, digest, sid, deadline)
            grant_access(target, sid)
            pinned = stack.enter_context(open_source(target, share=1))
            verify_hash(pinned, digest, deadline)
        # Keep read-only, share-read handles open through CreateProcess so neither
        # replacement nor modification can race the last hash verification.
        yield directory / executable.name


class Child:
    def __init__(self, process, job, stdout):
        self.process, self.job, self.stdout = process, job, stdout
        self.returncode = None
        self.resources = None
        self._job_lock = threading.Lock()

    def poll(self):
        code = w.DWORD()
        _check(exit_code(self.process, c.byref(code)), 'GetExitCodeProcess')
        self.returncode = None if code.value == 259 else code.value
        return self.returncode

    def wait(self, timeout):
        status = wait_process(self.process, max(0, int(timeout * 1000)))
        if status == 258:
            raise subprocess.TimeoutExpired('isolated decoder', timeout)
        _check(status == 0, 'WaitForSingleObject')
        return self.poll()

    def kill(self):
        with self._job_lock:
            job = self.job
            self.job = None
        if job:
            _check(close_handle(job), 'CloseHandle job')

    def close(self):
        try:
            self.kill()
            self.wait(1)
        finally:
            self.stdout.close()
            close_handle(self.process)
            self.process = None
            if self.resources:
                self.resources.close()


def launch(command, source, timeout, *, profile_name=None, memory_bytes=MEMORY_BYTES):
    """Return a bounded child only after every security gate succeeds."""
    deadline = time.monotonic() + timeout
    with contextlib.ExitStack() as resources:
        sid = resources.enter_context(profile(profile_name, deadline=deadline))
        executable = resources.enter_context(staged(command[0], sid, deadline))
        # System32 is already a trusted DLL search location. Never make an
        # inherited/user directory the cwd, or grant any new directory access.
        cwd = c.create_unicode_buffer(260)
        length = system_directory(cwd, len(cwd))
        if not 0 < length < len(cwd):
            raise IsolationError('short Windows system working directory unavailable')
        _pin_directories(Path(cwd.value), resources)
        # Extended syntax works independently of LongPathsEnabled for the image;
        # lpCurrentDirectory still requires a short ordinary path.
        image = str(executable)
        if len(image.encode('utf-16-le')) // 2 >= 260 and not image.startswith('\\\\?\\'):
            image = _extended_path(image)
        with contextlib.ExitStack() as stack:
            job = create_job(None, None)
            _check(job, 'CreateJobObjectW')
            stack.callback(close_handle, job)
            limits = ExtendedLimit()
            limits.basic.flags = 0x2000 | 0x8 | 0x100 | 0x2
            limits.basic.active = 1
            limits.basic.process_time = CPU_SECONDS * 10000000
            limits.process_memory = memory_bytes
            _check(set_job(job, 9, c.byref(limits), c.sizeof(limits)), 'job resource limits')
            # os.pipe supplies a byte-bounded parent reader; only its write end
            # and a reduced-rights snapshot copy cross the handle list.
            read_fd, write_fd = os.pipe()
            output = os.fdopen(read_fd, 'rb', buffering=0)
            stack.callback(output.close)
            stack.callback(os.close, write_fd)
            inherited = []
            for handle, access in [
                (msvcrt.get_osfhandle(source.fileno()), 0x00120089),
                (msvcrt.get_osfhandle(write_fd), 0),
            ]:
                duplicate_handle = w.HANDLE()
                _check(
                    duplicate(
                        current_process(),
                        handle,
                        current_process(),
                        c.byref(duplicate_handle),
                        access,
                        True,
                        0 if access else 2,
                    ),
                    'inherited DuplicateHandle',
                )
                inherited.append(duplicate_handle.value)
                stack.callback(close_handle, duplicate_handle.value)
            size = SIZE()
            init_attributes(None, 2, 0, c.byref(size))
            if not size.value:
                _check(False, 'attribute list size')
            attributes = c.create_string_buffer(size.value)
            _check(
                init_attributes(attributes, 2, 0, c.byref(size)), 'attribute list initialization'
            )
            stack.callback(delete_attributes, attributes)
            capabilities = Capabilities(sid, None, 0, 0)
            handles = (w.HANDLE * 2)(*inherited)
            _check(
                update_attribute(
                    attributes,
                    0,
                    0x20009,
                    c.byref(capabilities),
                    c.sizeof(capabilities),
                    None,
                    None,
                ),
                'AppContainer capabilities',
            )
            _check(
                update_attribute(attributes, 0, 0x20002, handles, c.sizeof(handles), None, None),
                'inherited handle list',
            )
            startup = StartupEx()
            startup.startup.cb = c.sizeof(startup)
            startup.startup.flags = 0x100
            startup.startup.stdin, startup.startup.stdout, startup.startup.stderr = (
                inherited[0],
                inherited[1],
                inherited[1],
            )
            startup.attributes = c.cast(attributes, P)
            info = ProcessInfo()
            # A minimal environment avoids inherited user secrets and DLL search
            # paths. The image directory and Windows system DLLs suffice.
            environment = c.create_unicode_buffer(
                'LOCALAPPDATA=%s\0SystemRoot=%s\0\0'
                % (os.environ['LOCALAPPDATA'], os.environ['SystemRoot'])
            )
            line = c.create_unicode_buffer(subprocess.list2cmdline([image, *command[1:]]))
            _check(
                create_process(
                    image,
                    line,
                    None,
                    None,
                    True,
                    0x80000 | 0x4 | 0x08000000 | 0x400,
                    environment,
                    cwd.value,
                    c.byref(startup),
                    c.byref(info),
                ),
                'AppContainer CreateProcessW',
            )
            stack.callback(close_handle, info.thread)
            try:
                _check(assign_job(job, info.process), 'job assignment')
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired('decoder setup', timeout)
                _check(resume_thread(info.thread) != 0xFFFFFFFF, 'ResumeThread')
            except BaseException:
                terminate_process(info.process, 125)
                wait_process(info.process, 1000)
                close_handle(info.process)
                raise
            child = Child(info.process, job, output)
            child.resources = resources.pop_all()
            # Transfer just these three resources; close all temporary inherited
            # copies before returning, allowing EOF on the parent pipe.
            stack.pop_all()
            close_handle(info.thread)
            delete_attributes(attributes)
            for handle in inherited:
                close_handle(handle)
            os.close(write_fd)
            return child
