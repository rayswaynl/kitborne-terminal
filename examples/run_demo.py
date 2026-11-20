"""Runs the crate demo end to end without a browser: submit v1, reviewer sends it back, read the notes, submit v2, reviewer approves.

The reviewer steps use `review.py verdict`, so this also works as a smoke test. By default it uses a new temporary review folder
and its own project registry, and removes both afterwards. Pass --root to run it in a folder of your choice instead.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REVIEW = os.path.join(HERE, '..', 'scripts', 'review.py')
V1, V2 = os.path.join(HERE, 'crate-concept.png'), os.path.join(HERE, 'crate-concept-v2.png')
ASSET, STAGE = 'wooden-crate', 'concept'


def run(env, *args):
    print('\n$ review.py ' + ' '.join(args), flush=True)
    p = subprocess.run([sys.executable, '-X', 'utf8', REVIEW, *args], env=env, capture_output=True, text=True, encoding='utf-8')
    print((p.stdout + p.stderr).rstrip())
    if p.returncode:
        sys.exit('FAILED (exit %d): review.py %s' % (p.returncode, args[0]))
    return p.stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--root', help='review folder to use (default: a new temporary folder)')
    ap.add_argument('--keep', action='store_true', help='keep the temporary review folder so you can open it with serve afterwards')
    a = ap.parse_args()

    env, tmp = dict(os.environ), None
    if a.root:
        root = a.root
    else:
        tmp = tempfile.mkdtemp(prefix='kitborne-demo-')
        root = os.path.join(tmp, 'my-review')
        env = {k: v for k, v in env.items() if not k.startswith('ASSET_REVIEW_')}  # no optional integrations
        env['ASSET_REVIEW_PROJECTS'] = os.path.join(tmp, 'projects.json')
    print('Review folder: ' + os.path.abspath(root))
    if not (os.path.exists(V1) and os.path.exists(V2)):
        subprocess.run([sys.executable, os.path.join(HERE, 'make_example.py')], check=True)

    common = ['--root', root, '--asset', ASSET, '--stage', STAGE]
    reviewer = ['--by', 'demo-reviewer', '--source', 'run_demo']
    run(env, 'submit', *common, '--route', 'sprite', '--file', V1, '--note', 'First concept')
    run(env, 'verdict', *common, '--verdict', 'changes', '--text', 'The front corners need metal brackets.', *reviewer)
    run(env, 'notes', *common)
    ids = [n['id'] for n in json.loads(run(env, 'notes', *common, '--json'))[0]['todo']]
    run(env, 'submit', *common, '--file', V2, '--note', 'Added metal corner brackets', '--resolves', ','.join(ids),
        '--response', '%s=added L-shaped metal brackets on all four front corners' % ids[0])
    run(env, 'verdict', *common, '--verdict', 'approved', '--text', 'Brackets look right.', *reviewer)
    run(env, 'wait', *common, '--timeout', '5')

    with open(os.path.join(root, 'catalog.json'), encoding='utf-8') as f:
        st = json.load(f)['assets'][ASSET]['stages'][STAGE]
    ok = st.get('status') == 'approved' and len(st['versions']) == 2
    print('\nDEMO %s: %s/%s has %d versions, status %s' % ('PASS' if ok else 'FAIL', ASSET, STAGE, len(st['versions']), st.get('status')))
    if tmp and not a.keep:
        shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
