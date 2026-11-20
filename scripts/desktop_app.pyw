"""Asset Review as a desktop app: start the review server for --root when none answers, then open the viewer as a Chrome app window.
Pin a shortcut to this file (desktop_shortcut.ps1 makes one): pythonw runs it without a console, and the shortcut's
AppUserModelID 'Chrome.127.0.0.1_/' is the ID Chrome gives the 127.0.0.1 app window, so icon and window share one taskbar button."""
import argparse, datetime, json, os, subprocess, sys, traceback, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BROWSERS = [r'C:\Program Files\Google\Chrome\Application\chrome.exe',
            r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe']


def running(root, port):
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/api/info' % port, timeout=1) as r:
            return os.path.normcase(json.loads(r.read()).get('root', '')) == os.path.normcase(root)
    except Exception:
        return False


def port_of(root):
    try:
        with open(os.path.join(root, '.server.json'), encoding='utf-8') as f:
            return int(json.load(f).get('port', 4780))
    except Exception:
        return 4780


ap = argparse.ArgumentParser()
ap.add_argument('--root', required=True)
root = os.path.abspath(ap.parse_args().root)
log = open(os.path.join(root, '.desktop_app.log'), 'a', encoding='utf-8')  # pythonw has no console: keep the evidence
log.write('%s start exe=%s\n' % (datetime.datetime.now().isoformat(timespec='seconds'), sys.executable)); log.flush()
try:
    if not running(root, port_of(root)):
        r = subprocess.run([sys.executable, os.path.join(HERE, 'review.py'), 'up', '--root', root], stdin=subprocess.DEVNULL,
                           stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=60)
        log.write('up exit=%d running=%s\n' % (r.returncode, running(root, port_of(root)))); log.flush()
    browser = next((b for b in BROWSERS if os.path.isfile(b)), None)
    url = 'http://127.0.0.1:%d/' % port_of(root)
    if browser:
        subprocess.Popen([browser, '--app=' + url])
    else:
        os.startfile(url)
    log.write('opened %s\n' % url)
except Exception:
    log.write(traceback.format_exc())
log.close()
