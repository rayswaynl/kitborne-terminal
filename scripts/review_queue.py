"""R3C-111: fresh, read-only owner queue counts and admission backpressure."""
import os
from pathlib import Path

DEFAULT_LIMIT = 6
FULL_EXIT = 75


class QueueFull(ValueError):
    """A refused publication; CLI adapters choose the exit code, never servers."""
    exit_code = FULL_EXIT

    def __init__(self, total, limit):
        super().__init__("The owner's queue is full (%d of %d). Decide on or archive a version first, or raise the limit in Settings. Nothing was submitted." % (total, limit))
        self.error = dict(code='queue_full', message=str(self))


def read_json(path, default):
    # Lazy import avoids the review -> review_queue import cycle. Keep the same
    # bounded catalog read as every other control-state reader.
    from review import jload
    return jload(path, default)


def sidecar(path):
    try:
        value = read_json(path, {})
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}  # a damaged setting/review is not a limit/final decision


def queue_limit(root):
    value = sidecar(Path(root) / 'review-queue.json').get('limit', DEFAULT_LIMIT)
    return value if type(value) is int and value > 0 else DEFAULT_LIMIT


def waiting_rows(root, cat=None):
    """Latest waiting version per stage, preserving today's oldest order.

    No new fields are required. Final reviews and the real archive command
    release slots; neither counting nor settings migrate stored history.
    """
    root = Path(root)
    cat = cat if cat is not None else read_json(root / 'catalog.json', {'assets': {}})
    rows = []
    stage_order = [stage['id'] for stage in cat.get('stages', [])]
    for aid, asset in cat.get('assets', {}).items():
        stages = asset.get('stages', {})
        for sid in dict.fromkeys(stage_order + list(stages)):
            stage = stages.get(sid, {})
            versions = stage.get('versions', [])
            if stage.get('status') != 'in_review' or not versions:
                continue
            version = versions[-1]
            if version.get('reviewed') in ('approved', 'changes', 'rejected'):
                continue
            rv = sidecar(root / 'items' / aid / sid / ('v%03d' % version['v']) / 'review.json')
            if not rv.get('draft') and rv.get('verdict') in ('approved', 'changes', 'rejected'):
                continue
            rows.append(dict(asset=aid, stage=sid, v=version['v'], at=version.get('at') or ''))
    rows.sort(key=lambda row: row['at'])
    return rows


def queue_size(root, cat=None):
    rows, limit = waiting_rows(root, cat), queue_limit(root)
    return dict(limit=limit, total=len(rows), shown=min(limit, len(rows)), full=len(rows) >= limit, items=rows[:limit])


def require_slot(root, asset=None, stage=None, *, cat=None):
    rows, limit = waiting_rows(root, cat), queue_limit(root)
    # Replacing a waiting stage costs no slot, even outside the visible batch.
    if any(row['asset'] == asset and row['stage'] == stage for row in rows):
        return
    if len(rows) >= limit:
        raise QueueFull(len(rows), limit)


def catalog_queue(root, cat):
    cat['review_queue'] = queue_size(root, cat)
    return cat


def save_limit(root, value, file_lock, save):
    if type(value) is not int or value < 1:
        raise ValueError('The queue limit must be a positive whole number')
    # Only publication is serialized; preflight and rendering never block this.
    try:
        with file_lock(root):
            save(os.path.join(root, 'review-queue.json'), {'limit': value})
            return queue_size(root)
    except SystemExit as error:
        # The existing CLI FileLock reports contention with SystemExit. Convert
        # it at this HTTP boundary so the handler can always send a JSON error.
        raise ValueError('The queue setting could not be saved: ' + str(error)) from error
