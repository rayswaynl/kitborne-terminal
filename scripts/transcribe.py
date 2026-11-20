"""Local speech-to-text for review notes (faster-whisper large-v3, offline from the Hugging Face cache).

python transcribe.py <file.wav>     one file, prints the text
python transcribe.py --serve        worker for the review server: JSON lines {"wav": path} in, {"text": ...} out; exits after 15 idle minutes
"""
import json, os, queue, sys, threading

os.environ.setdefault('HF_HUB_OFFLINE', '1')
# CUDA 12 DLLs (cublas, cudnn) for ctranslate2 when the system has none, e.g. <venv>/Lib/site-packages/torch/lib of the part-recognition venv.
for d in os.environ.get('ASSET_REVIEW_CUDA_DLLS', '').split(os.pathsep):
    if d and os.path.isdir(d):
        os.add_dll_directory(d); os.environ['PATH'] = d + os.pathsep + os.environ.get('PATH', '')
import numpy as np
from faster_whisper import WhisperModel


def load():
    try:
        m = WhisperModel('large-v3', device='cuda', compute_type='float16', local_files_only=True)
        list(m.transcribe(np.zeros(16000, dtype=np.float32), language='nl')[0])  # a missing CUDA library only shows up on the first run
        return m
    except Exception as e:
        print('GPU not usable (%s); using the CPU' % e, file=sys.stderr, flush=True)
        return WhisperModel('large-v3', device='cpu', compute_type='int8', local_files_only=True)


def text_of(model, path):
    segs, _ = model.transcribe(path, language='nl', vad_filter=True, beam_size=5, initial_prompt='Feedback op een game-asset: geluid, model, kleur, animatie.')
    return ' '.join(s.text.strip() for s in segs).strip()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if sys.argv[1:] != ['--serve']:
        print(text_of(load(), sys.argv[1])); sys.exit()
    model = load(); lines = queue.Queue()
    threading.Thread(target=lambda: [lines.put(l) for l in sys.stdin], daemon=True).start()
    print(json.dumps({'ready': True}), flush=True)
    while True:
        try: line = lines.get(timeout=900)
        except queue.Empty: break  # idle: give the GPU memory back; the server starts a new worker when needed
        try: out = {'text': text_of(model, json.loads(line)['wav'])}
        except Exception as e: out = {'error': str(e)}
        print(json.dumps(out, ensure_ascii=False), flush=True)

