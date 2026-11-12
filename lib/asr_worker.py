import sys, json, os

def main():
    model_name = os.environ.get('BT_ASR_MODEL', 'base')
    try:
        import torch, whisper
        device = 'mps' if torch.backends.mps.is_available() else 'cpu'
        model = whisper.load_model(model_name, device=device)
    except Exception as e:
        print(json.dumps({'error': f'ASR 初始化失败: {e}'}), flush=True)
        return
    print(json.dumps({'ready': True, 'device': device, 'model': model_name}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            wav = req.get('wav')
            if not wav or not os.path.exists(wav):
                print(json.dumps({'error': '音频文件不存在'}), flush=True)
                continue
            audio = whisper.load_audio(wav)
            kwargs = {'fp16': False}
            lang = req.get('language') or ''
            if lang:
                kwargs['language'] = lang
            result = model.transcribe(audio, **kwargs)
            segs = [
                {'start': float(s.get('start') or 0), 'end': float(s.get('end') or 0), 'text': str(s.get('text') or '').strip()}
                for s in (result.get('segments') or [])
                if str(s.get('text') or '').strip()
            ]
            print(json.dumps({'segments': segs, 'language': result.get('language') or lang or ''}, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({'error': str(e)}), flush=True)

if __name__ == '__main__':
    main()
