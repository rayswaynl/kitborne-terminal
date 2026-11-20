"""Find and name the parts of an image for the review viewer.

Open-vocabulary detection (Grounding DINO) finds labelled boxes from a word list; SAM turns each box into an exact outline.
Both run locally (GPU if present) with free Hugging Face models. Runs in the separate venv, not in review.py's stdlib Python:

  <venv>/Scripts/python.exe segment.py <image> [...] [--vocab "tank=Tank,roof=Dak"] [--preview]

Writes parts/<image name>.json next to each image (atomic), and with --preview a parts/<name>.preview.png overlay.
"""
import argparse, datetime, json, os, sys, time
os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')
from renderq import render_turn

DET, SEG = 'IDEA-Research/grounding-dino-base', 'facebook/sam-vit-base'
# English prompt -> label shown in the viewer. Projects extend this with <review root>/vocab.json ({"prompt": "Label"}).
VOCAB = {
    'tank': 'Tank', 'tank turret': 'Turret', 'tank track': 'Track', 'cannon barrel': 'Cannon', 'radio antenna': 'Antenna', 'jeep': 'Jeep', 'truck': 'Truck', 'railway track': 'Rail track',
    'soldier': 'Soldier', 'helmet': 'Helmet', 'rifle': 'Rifle', 'machine gun': 'Rifle', 'backpack': 'Backpack', 'stretcher': 'Stretcher',
    'house': 'House', 'factory': 'Factory', 'roof': 'Roof', 'brick chimney': 'Chimney', 'window': 'Window', 'door': 'Door', 'water tower': 'Water tower',
    'flag': 'Flag', 'emblem': 'Emblem', 'fence': 'Fence', 'sandbags': 'Sandbags', 'crate': 'Crate', 'barrel': 'Barrel', 'telegraph pole': 'Pole',
    'tree': 'Tree', 'bush': 'Bush', 'rock': 'Rock', 'flowers': 'Flowers', 'grass': 'Grass', 'dirt path': 'Path', 'mud': 'Mud', 'puddle': 'Puddle',
    'hill': 'Hill', 'sky': 'Sky', 'cloud': 'Cloud', 'smoke': 'Smoke', 'fire': 'Fire', 'explosion': 'Explosion', 'muzzle flash': 'Muzzle flash',
}
# Zoom pass: big objects are cropped and searched again for their own parts (a turret is hard to find in a whole scene, easy in a crop).
SUBPARTS = {
    'tank': {'tank turret': 'Turret', 'cannon barrel': 'Cannon', 'tank track': 'Track', 'road wheel': 'Road wheel', 'hatch': 'Hatch', 'radio antenna': 'Antenna', 'headlight': 'Headlight', 'exhaust pipe': 'Exhaust'},
    'jeep': {'wheel': 'Wheel', 'windshield': 'Windshield', 'headlight': 'Headlight', 'seat': 'Seat', 'spare tire': 'Spare tire'},
    'truck': {'wheel': 'Wheel', 'windshield': 'Windshield', 'headlight': 'Headlight', 'cargo bed': 'Cargo bed'},
    'soldier': {'helmet': 'Helmet', 'face': 'Face', 'rifle': 'Rifle', 'backpack': 'Backpack', 'boots': 'Boots', 'hand': 'Hand', 'belt pouches': 'Belt pouches'},
    'house': {'roof': 'Roof', 'window': 'Window', 'door': 'Door', 'brick chimney': 'Chimney'},
    'factory': {'roof': 'Roof', 'window': 'Window', 'door': 'Door', 'brick chimney': 'Chimney'},
}
ZOOM_MAX, ZOOM_MIN_AREA, ZOOM_T = 6, 0.01, 0.24  # objects that get a zoom pass, the smallest that is worth it, and the lower score bar inside a crop
BACKDROP = {'sky', 'grass', 'dirt path', 'hill', 'mud'}  # on a flat grey studio backdrop these words are wrong; real skies and fields have colour or texture
BOX_T, TEXT_T, CHUNK, MAX_PER_LABEL = 0.30, 0.25, 1, 14  # one word per pass: Grounding DINO scores single prompts far higher (house 0.52 alone, 0.23 in a list)


def iou(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    i = max(0, x1 - x0) * max(0, y1 - y0); u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i
    return i / u if u > 0 else 0


def mask_iou(a, b):
    import numpy as np
    u = np.logical_or(a, b).sum()
    return np.logical_and(a, b).sum() / u if u else 0


class Segmenter:
    def __init__(self):
        import torch
        from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection, SamModel, SamProcessor
        self.dev = 'cuda' if torch.cuda.is_available() else 'cpu'
        self.dp = AutoProcessor.from_pretrained(DET); self.dm = AutoModelForZeroShotObjectDetection.from_pretrained(DET).to(self.dev).eval()
        self.sp = SamProcessor.from_pretrained(SEG); self.sm = SamModel.from_pretrained(SEG).to(self.dev).eval()

    def detect(self, img, vocab, box_t=None, text_t=None):
        prompts = list(vocab); found = []
        for i in range(0, len(prompts), CHUNK):
            chunk = prompts[i:i + CHUNK]
            inp = self.dp(images=img, text='. '.join(chunk) + '.', return_tensors='pt').to(self.dev)
            out = self.dm(**inp)
            res = self.dp.post_process_grounded_object_detection(out, inp.input_ids, threshold=box_t or BOX_T, text_threshold=text_t or TEXT_T, target_sizes=[img.size[::-1]])[0]
            labels = res.get('text_labels') or res.get('labels')
            for box, score, lab in zip(res['boxes'].tolist(), res['scores'].tolist(), labels):
                lab = str(lab).strip()
                key = next((p for p in chunk if p == lab), None) or next((p for p in chunk if p in lab or lab in p), None)
                if key: found.append({'prompt': key, 'score': score, 'box': box})
        keep = []  # per label: strongest first, drop near-duplicates; across labels: drop the weaker of two almost identical boxes
        for d in sorted(found, key=lambda d: -d['score']):
            same = [k for k in keep if vocab[k['prompt']] == vocab[d['prompt']]]
            if len(same) >= MAX_PER_LABEL or any(iou(d['box'], k['box']) > 0.5 for k in same): continue
            if any(iou(d['box'], k['box']) > 0.88 for k in keep): continue
            keep.append(d)
        return keep

    def masks(self, img, boxes):
        import numpy as np
        out = []
        for i in range(0, len(boxes), 8):  # small batches: SAM returns full-size masks, 3 per box
            bs = boxes[i:i + 8]
            inp = self.sp(images=img, input_boxes=[bs], return_tensors='pt').to(self.dev)
            o = self.sm(**inp, multimask_output=True)
            m = self.sp.post_process_masks(o.pred_masks.cpu(), inp['original_sizes'].cpu(), inp['reshaped_input_sizes'].cpu())[0]  # (n, 3, H, W)
            best = o.iou_scores.cpu()[0].argmax(-1)
            for j in range(len(bs)): out.append(m[j, best[j]].numpy().astype(np.uint8))
        return out


def polygons(mask, W, H):
    import cv2
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cs = sorted(cs, key=cv2.contourArea, reverse=True)
    if not cs: return []
    big = cv2.contourArea(cs[0]); out = []
    for c in cs[:6]:
        a = cv2.contourArea(c)
        if a < max(40, big * 0.12): continue
        p = cv2.approxPolyDP(c, 0.0035 * cv2.arcLength(c, True), True)[:, 0, :]
        if len(p) >= 3: out.append([[round(float(x) / W, 4), round(float(y) / H, 4)] for x, y in p[:160]])
    return out


def accept(dets, ms, W, H, kept, hsv=None):
    """Masks -> parts, strongest first. kept holds (label, quarter mask, part) of parts already accepted; it grows.
    A zoom-pass find that matches an earlier whole-image part renames it in context: a "pole" inside a tank becomes "Antenne · Tank"."""
    import numpy as np
    out = []
    for d, m in sorted(zip(dets, ms), key=lambda dm: -dm[0]['score']):
        area = float(m.sum()) / (W * H)
        if area < 0.0004: continue
        if hsv is not None and (d['prompt'] in BACKDROP or area > 0.15):
            px = hsv[m.astype(bool)]; flat = (px[:, 1] < 30) & (np.abs(px[:, 2].astype(int) - int(np.median(px[:, 2]))) < 20)
            if flat.mean() > 0.5: continue  # mostly one flat grey: a studio backdrop, whatever the detector called it
        small = m[::4, ::4].astype(bool)
        twin = next((p for lab, k, p in kept if mask_iou(small, k) > (0.6 if lab == d['label'] else 0.72)), None)
        if twin is not None:  # same object twice: keep the stronger name (Tank, not Jeep), unless the zoom pass knows the context
            if d.get('parent') is not None and twin.get('parent') is None and twin is not d.get('parent_part'):
                twin.update(label=d['label'], prompt=d['prompt'], parent=d['parent'])
            continue
        polys = polygons(m, W, H)
        if not polys: continue
        x0, y0, x1, y1 = d['box']
        p = {'label': d['label'], 'prompt': d['prompt'], 'score': round(d['score'], 3), 'area': round(area, 4), 'box': d['box'], 'parent': d.get('parent'),
             'bbox': [round(x0 / W, 4), round(y0 / H, 4), round((x1 - x0) / W, 4), round((y1 - y0) / H, 4)], 'polygons': polys}
        kept.append((d['label'], small, p)); out.append(p)
    return out


def zoom(seg, img, parts, vocab):
    """Crop each big object and look for its own parts there. Returns detections in full-image pixels with a parent index."""
    W, H = img.size; found = []
    big = [i for i, p in sorted(enumerate(parts), key=lambda ip: -ip[1]['area']) if p['prompt'] in SUBPARTS and p['area'] >= ZOOM_MIN_AREA][:ZOOM_MAX]
    for i in big:
        x0, y0, x1, y1 = parts[i]['box']; pw, ph = x1 - x0, y1 - y0
        cx0, cy0, cx1, cy1 = max(0, x0 - pw * 0.06), max(0, y0 - ph * 0.06), min(W, x1 + pw * 0.06), min(H, y1 + ph * 0.06)
        sub = dict(SUBPARTS[parts[i]['prompt']]); sub.update({k: v for k, v in vocab.items() if k in sub})
        for d in seg.detect(img.crop((int(cx0), int(cy0), int(cx1), int(cy1))), sub, box_t=ZOOM_T, text_t=0.2):
            bx0, by0, bx1, by1 = d['box']; b = [bx0 + int(cx0), by0 + int(cy0), bx1 + int(cx0), by1 + int(cy0)]
            if (b[2] - b[0]) * (b[3] - b[1]) > 0.6 * pw * ph: continue  # "turret" that is really the whole tank
            found.append({'prompt': d['prompt'], 'label': sub[d['prompt']], 'score': d['score'], 'box': b, 'parent': i})
    return found


def run(seg, path, vocab, preview):
    import cv2, numpy as np
    from PIL import Image, ImageDraw, ImageFont
    img = Image.open(path).convert('RGB'); W, H = img.size; t0 = time.time()
    dets = [dict(d, label=vocab[d['prompt']]) for d in seg.detect(img, vocab)]
    kept = []
    parts = accept(dets, seg.masks(img, [d['box'] for d in dets]) if dets else [], W, H, kept, cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2HSV))
    subs = zoom(seg, img, parts, vocab) if ZOOM_MAX else []
    for p in parts: p['_key'] = id(p)
    keys = [p['_key'] for p in parts]
    for d in subs: d['parent_part'] = parts[d['parent']]; d['parent'] = keys[d['parent']]
    parts += accept(subs, seg.masks(img, [d['box'] for d in subs]) if subs else [], W, H, kept)
    parts.sort(key=lambda p: p['area'])  # small parts first: the viewer picks the smallest part under the pointer
    count = {}
    for p in parts:
        if not p.get('parent'): count[p['label']] = count.get(p['label'], 0) + 1
    seen = {}
    for i, p in enumerate(parts):
        p['id'] = 'p%02d' % (i + 1)
        if p.get('parent'): continue
        if count[p['label']] > 1: seen[p['label']] = seen.get(p['label'], 0) + 1; p['name'] = '%s %d' % (p['label'], seen[p['label']])
        else: p['name'] = p['label']
    byk = {p['_key']: p for p in parts if '_key' in p}
    kids = {}
    for p in parts:
        if p.get('parent'): kids.setdefault((p['parent'], p['label']), []).append(p)
    for (pk, lab), ps in kids.items():  # a part found inside an object is named after it: "Loopwiel 3 · Tank 2"
        par = byk[pk]
        for n, p in enumerate(sorted(ps, key=lambda q: (q['bbox'][0], q['bbox'][1]))):
            p['parent'] = par['id']; p['name'] = '%s%s · %s' % (lab, ' %d' % (n + 1) if len(ps) > 1 else '', par['name'])
    for p in parts:
        p.pop('_key', None); p.pop('box', None)
        if not p.get('parent'): p.pop('parent', None)
    doc = {'schema': 'asset-review/parts-1', 'file': os.path.basename(path), 'w': W, 'h': H, 'made': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
           'models': {'detector': DET, 'segmenter': SEG}, 'seconds': round(time.time() - t0, 2), 'parts': parts}
    od = os.path.join(os.path.dirname(os.path.abspath(path)), 'parts'); os.makedirs(od, exist_ok=True)
    dst = os.path.join(od, os.path.basename(path) + '.json'); tmp = dst + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(doc, f, ensure_ascii=False)
    json.load(open(tmp, encoding='utf-8')); os.replace(tmp, dst)
    if preview:
        ov = img.copy(); g = ImageDraw.Draw(ov, 'RGBA'); f = ImageFont.truetype('segoeuib.ttf', max(14, W // 90))
        for i, p in enumerate(sorted(parts, key=lambda p: -p['area'])):
            hue = (i * 47) % 360; col = tuple(int(c) for c in cv2.cvtColor(np.uint8([[[hue // 2, 200, 230]]]), cv2.COLOR_HSV2RGB)[0, 0])
            for poly in p['polygons']: g.polygon([(x * W, y * H) for x, y in poly], fill=col + (60,), outline=col + (255,), width=2)
            x, y = p['polygons'][0][0]; g.text((x * W + 4, y * H + 2), p['name'], font=f, fill=(255, 255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0, 255))
        ov.save(os.path.join(od, os.path.basename(path) + '.preview.png'))
    print('PARTS %s: %d parts in %.1f s -> %s' % (os.path.basename(path), len(parts), doc['seconds'], dst), flush=True)
    return doc


def main():
    global ZOOM_MAX
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('images', nargs='+'); ap.add_argument('--vocab', help='extra words, "prompt=Label,prompt2=Label2"'); ap.add_argument('--vocab-file'); ap.add_argument('--preview', action='store_true')
    ap.add_argument('--zoom', type=int, default=ZOOM_MAX, help='objects that get a parts zoom pass (0 = off, faster)')
    a = ap.parse_args()
    ZOOM_MAX = a.zoom
    vocab = dict(VOCAB)
    if a.vocab_file and os.path.exists(a.vocab_file): vocab.update(json.load(open(a.vocab_file, encoding='utf-8')))
    for kv in filter(None, (a.vocab or '').split(',')):
        k, _, v = kv.partition('='); vocab[k.strip().lower()] = (v or k).strip()
    with render_turn('segment'), gpu_turn():
        t = time.time(); seg = Segmenter(); print('MODELS loaded on %s in %.1f s' % (seg.dev, time.time() - t), flush=True)
        import torch
        with torch.inference_mode():
            for p in a.images:
                try: run(seg, p, vocab, a.preview)
                except Exception as e: print('ERROR %s: %s' % (p, e), file=sys.stderr, flush=True)


class gpu_turn:
    """One recognition run at a time on this PC: parallel submits queue up instead of loading the models several times."""
    path = os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'asset-review', 'segment.lock')
    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True); end = time.time() + 900
        while True:
            try: self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY); os.write(self.fd, str(os.getpid()).encode()); return self
            except FileExistsError:
                try:
                    from review import pid_alive
                    with open(self.path, encoding='ascii') as lock: owner = int(lock.read())
                    if time.time() - os.path.getmtime(self.path) > 1800 or not pid_alive(owner):
                        os.remove(self.path); continue
                except ValueError: pass  # acquisition can be observed before the PID has been written
                except OSError: pass
                if time.time() > end: raise SystemExit('ERROR another recognition run holds %s for more than 15 minutes' % self.path)
                time.sleep(1)
    def __exit__(self, *e):
        os.close(self.fd)
        try:
            with open(self.path, encoding='ascii') as lock: owner = int(lock.read())
            if owner == os.getpid(): os.remove(self.path)
        except ValueError: pass
        except OSError: pass


if __name__ == '__main__':
    main()
