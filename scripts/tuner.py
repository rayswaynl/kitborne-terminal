"""Cutdesk tuner: sliders for the numbers in a game's Config.luau (Draw & Grow first).

A project root opts in with <root>/tuner.json:
  {"repo": "<absolute path to the game's git worktree>",
   "spec": "src/shared/TunerSpec.json", "config": "src/shared/Config.luau"}
The spec lists which values get a slider (same file the Studio tuner reads). Saving rewrites only those
numbers in Config.luau, keeps comments and layout, and logs every save to <root>/tuner-log.jsonl.
"""
import datetime, hashlib, json, os, re, subprocess

NUM = r'-?\d+(?:\.\d+)?'


class TunerConflict(Exception):
    pass


def _cfg(root):
    path = os.path.join(root, 'tuner.json')
    if not os.path.isfile(path):
        return None
    with open(path, encoding='utf-8') as f:
        cfg = json.load(f)
    repo = os.path.abspath(cfg['repo'])
    rel = cfg.get('config', 'src/shared/Config.luau')
    return dict(repo=repo, rel=rel, config=os.path.join(repo, rel), spec=os.path.join(repo, cfg.get('spec', 'src/shared/TunerSpec.json')))


def _read(path):
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()


def _git(repo, *args):
    try:
        return subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, encoding='utf-8', timeout=10, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None


def _sections(text):
    """{name: (start, end)} for every `Config.Name = freeze({ ... })` body."""
    out = {}
    for m in re.finditer(r'^Config\.(\w+)\s*=\s*[\w.]*\(\{[ \t]*\r?$', text, re.M):
        end = text.find('\n})', m.end())
        if end > 0:
            out[m.group(1)] = (m.end(), end)
    return out


def parse(text):
    """Scalar numbers and plain number lists per section: ({'Economy.basePayout': 8}, {'Economy.permitPrices': [20, ...]})."""
    values, arrays = {}, {}
    for name, (a, b) in _sections(text).items():
        body = text[a:b]
        for m in re.finditer(r'^\s*(\w+)\s*=\s*(' + NUM + r')\s*,', body, re.M):
            values[name + '.' + m.group(1)] = float(m.group(2)) if '.' in m.group(2) else int(m.group(2))
        for m in re.finditer(r'^\s*(\w+)\s*=\s*\{([^{}]*)\}\s*,', body, re.M):
            items = [x.strip() for x in m.group(2).split(',') if x.strip()]
            if items and all(re.fullmatch(NUM, x) for x in items):
                arrays[name + '.' + m.group(1)] = [float(x) if '.' in x else int(x) for x in items]
    return values, arrays


def _fmt(v):
    v = round(float(v), 4)
    return str(int(v)) if v == int(v) else ('%.4f' % v).rstrip('0').rstrip('.')


def state(root):
    cfg = _cfg(root)
    if not cfg:
        return dict(enabled=False)
    text = _read(cfg['config'])
    with open(cfg['spec'], encoding='utf-8') as f:
        spec = json.load(f)
    values, arrays = parse(text)
    head = _git(cfg['repo'], 'show', 'HEAD:' + cfg['rel'].replace('\\', '/'))
    committed = parse(head)[0] if head else values
    branch = (_git(cfg['repo'], 'rev-parse', '--abbrev-ref', 'HEAD') or '').strip()
    commit = (_git(cfg['repo'], 'rev-parse', '--short', 'HEAD') or '').strip()
    return dict(enabled=True, repo=cfg['repo'], file=cfg['rel'], branch=branch, commit=commit, spec=spec, values=values,
                arrays=arrays, committed=committed, base=hashlib.sha1(text.encode('utf-8')).hexdigest())


def save(root, changes, base, by):
    cfg = _cfg(root)
    if not cfg:
        raise ValueError('This project has no tuner')
    if not isinstance(changes, dict) or not changes:
        raise ValueError('No values to save')
    with open(cfg['spec'], encoding='utf-8') as f:
        params = {p['section'] + '.' + p['key']: p for p in json.load(f)['params']}
    text = _read(cfg['config'])
    if base and hashlib.sha1(text.encode('utf-8')).hexdigest() != base:
        raise TunerConflict('Config.luau changed in the meantime; reload the tuner')
    old = parse(text)[0]
    done = {}
    for key, value in changes.items():
        p = params.get(key)
        if not p or key not in old:
            raise ValueError('Unknown value: %s' % key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not p['min'] <= value <= p['max']:
            raise ValueError('%s must be between %s and %s' % (key, p['min'], p['max']))
        section, name = key.split('.', 1)
        a, b = _sections(text)[section]
        body, n = re.subn(r'^(\s*' + re.escape(name) + r'\s*=\s*)' + NUM + r'(\s*,)', lambda m: m.group(1) + _fmt(value) + m.group(2), text[a:b], count=1, flags=re.M)
        if n != 1:
            raise ValueError('Not found in Config.luau: %s' % key)
        text = text[:a] + body + text[b:]
        done[key] = [old[key], parse(text)[0][key]]
    tmp = cfg['config'] + '.tuner.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    if parse(_read(tmp))[0].keys() != old.keys():
        os.remove(tmp)
        raise ValueError('Save cancelled: Config.luau would break')
    os.replace(tmp, cfg['config'])
    with open(os.path.join(root, 'tuner-log.jsonl'), 'a', encoding='utf-8') as f:
        f.write(json.dumps(dict(ts=datetime.datetime.now().astimezone().isoformat(timespec='seconds'), by=by, file=cfg['config'], changes=done)) + '\n')
    return dict(ok=True, changed=done, **state(root))

