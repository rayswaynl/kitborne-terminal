"""One render job at a time on this PC: segment.py and turntable.py wait in a shared queue file instead of racing for the GPU and RAM.

The queue lives next to the recognition lock (%LOCALAPPDATA%/asset-review/render-queue.json) as an ordered list of
{job, kind, pid, queued, deadline}. The first ticket runs; its deadline is set when it reaches the front. A ticket whose
owner process is gone is dropped unless a durable execution fence still requires
acknowledgement. All clients consult the bounded .b8-fences.json sidecar under
the queue mutex. Deadlines never release a live owner or an unresolved fence.
"""
import json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
RUN_LIMIT = 1800  # seconds one job may hold the front of the queue
WAIT_LIMIT = 3600  # seconds a job waits for its turn before it gives up


MAX_FENCE_BYTES = 65536
MAX_FENCE_TICKETS = 128


def load_fence_record(path):
    """Read a bounded record; unknown quiescence cannot acknowledge work."""
    try:
        with open(path, "rb") as stream:
            raw = stream.read(MAX_FENCE_BYTES + 1)
        if len(raw) > MAX_FENCE_BYTES:
            return {}
        record = json.loads(raw)
        return record if isinstance(record, dict) else {}
    except (OSError, ValueError, RecursionError):
        return {}


def ticket_acknowledged(ticket):
    execution = ticket.get("execution", {})
    receipt = load_fence_record(execution.get("path", ""))
    return (receipt.get("token") == execution.get("token")
            and receipt.get("generation") == execution.get("generation")
            and receipt.get("state") == "settled"
            and receipt.get("acknowledged") is True)


class render_turn:
    path = os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'asset-review', 'render-queue.json')

    def __init__(self, kind, run_limit=RUN_LIMIT, wait_limit=WAIT_LIMIT):
        self.kind, self.run_limit, self.wait_limit = kind, run_limit, wait_limit
        self.job = '%s-%d-%d' % (kind, os.getpid(), time.time_ns())

    def edit(self, change):
        """Read-modify-write under the shared mutex; retain unresolved executions."""
        from review import pid_alive
        mutex = self.path + '.mutex'; end = time.time() + 30
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        while True:
            try: fd = os.open(mutex, os.O_CREAT | os.O_EXCL | os.O_WRONLY); break
            except (FileExistsError, PermissionError):
                try:
                    if time.time() - os.path.getmtime(mutex) > 10: os.remove(mutex); continue  # held by a killed process
                except OSError: pass
                if time.time() > end: raise SystemExit('ERROR render queue is locked: ' + mutex)
                time.sleep(0.05)
        try:
            try:
                with open(self.path, encoding='utf-8') as f: queue = json.load(f)
            except (OSError, ValueError): queue = []
            now = time.time()
            queue = [t for t in queue if pid_alive(t['pid'], t['queued'])]
            result = self._fenced_change(queue, now, change)
            tmp = '%s.%d.tmp' % (self.path, os.getpid())
            with open(tmp, 'w', encoding='utf-8', newline='\n') as f: json.dump(queue, f)
            os.replace(tmp, self.path)
            return result
        finally:
            os.close(fd)
            try: os.remove(mutex)
            except OSError: pass

    def _fenced_change(self, queue, now, change):
        """Called only by edit while holding the mutex used by every client."""
        from review import jsave
        path = self.path + '.b8-fences.json'
        registry = load_fence_record(path) if os.path.exists(path) else {'tickets': []}
        tickets = registry.get('tickets')
        if (not isinstance(tickets, list) or len(tickets) > MAX_FENCE_TICKETS
                or any(not isinstance(t, dict) or not isinstance(t.get('job'), str)
                       or not isinstance(t.get('execution'), dict) for t in tickets)):
            raise RuntimeError('Invalid machine render fences; refusing launch')
        tickets = [t for t in tickets if not ticket_acknowledged(t)]
        # A previous client/version may have pruned the dead local supervisor.
        # Restore its durable ticket before any client considers admission.
        queue[:0] = [dict(t) for t in tickets
                     if not any(q['job'] == t['job'] for q in queue)]
        result = change(queue, now)
        if getattr(self, 'execution', None):
            ticket = next((t for t in queue if t['job'] == self.job), None)
            if ticket is not None and not ticket_acknowledged(ticket):
                tickets = [t for t in tickets if t['job'] != self.job]
                tickets.append(dict(ticket))
        # An ordinary context exit must not remove a handed-off execution either.
        queue[:0] = [dict(t) for t in tickets
                     if not any(q['job'] == t['job'] for q in queue)]
        data = dict(tickets=tickets)
        if len(tickets) > MAX_FENCE_TICKETS or len(json.dumps(data).encode()) > MAX_FENCE_BYTES:
            raise RuntimeError('Machine render fence capacity reached; refusing launch')
        if tickets or os.path.exists(path):
            jsave(path, data)
        return result

    def __enter__(self):
        self.edit(lambda q, now: q.append({'job': self.job, 'kind': self.kind, 'pid': os.getpid(), 'queued': now}))
        end = time.time() + self.wait_limit

        def front(queue, now):
            if not queue or queue[0]['job'] != self.job: return False
            queue[0].setdefault('deadline', now + self.run_limit); return True
        while not self.edit(front):
            if time.time() > end:
                self.__exit__(); raise SystemExit('ERROR render queue: waited more than %d s for %s' % (self.wait_limit, self.job))
            time.sleep(1)
        return self

    def __exit__(self, *e):
        self.edit(lambda q, now: q.__setitem__(slice(None), [t for t in q if t['job'] != self.job]))
