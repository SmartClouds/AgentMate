"""OmniVoice for AgentMate Studio: a small sidecar that keeps the model loaded and answers JSON lines.

Our own code, calling only OmniVoice's public API (OmniVoice.from_pretrained and generate). Started
by Studio as `python -X utf8 omnivoice_server.py <model folder>` (user site off). It prints one line,
{"type": "ready", ...}, once the model is loaded, then for each request line

    {"id": 1, "op": "speak", "text": "...", "ref_audio": "voice.wav", "ref_text": "...", "out": "x.wav"}

writes a 16-bit WAV to `out` and answers {"id": 1, "ok": true} (or "ok": false with "error"). A
{"op": "quit"} line ends it. OmniVoice's weights are CC BY-NC 4.0: non-commercial use only.
"""

import array
import json
import sys
import traceback
import wave


def send(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def samples_of(audio):
    """The first channel of what generate returned, as a flat list of floats from -1 to 1."""
    if hasattr(audio, "detach"):
        audio = audio.detach().float().cpu()
    values = audio.tolist() if hasattr(audio, "tolist") else list(audio)
    while values and isinstance(values[0], list):
        values = values[0] if len(values) == 1 else [row[0] for row in values]
    return values


def write_wav(path, samples, rate):
    pcm = array.array("h", (int(max(-1.0, min(1.0, s)) * 32767) for s in samples))
    if sys.byteorder != "little":
        pcm.byteswap()
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm.tobytes())


def main():
    if len(sys.argv) < 2:
        send({"type": "fatal", "error": "No model folder given."})
        return 2
    model_dir = sys.argv[1]
    try:
        import torch
        from omnivoice import OmniVoice

        if torch.cuda.is_available():
            device, dtype = "cuda:0", torch.float16
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            device, dtype = "mps", torch.float16
        else:
            device, dtype = "cpu", torch.float32
        model = OmniVoice.from_pretrained(model_dir, device_map=device, dtype=dtype)
    except Exception as error:  # noqa: BLE001 - every failure is reported, then the process ends
        send({"type": "fatal", "error": f"{type(error).__name__}: {error}"})
        return 1
    rate = int(getattr(model, "sampling_rate", 0) or getattr(model, "sample_rate", 0) or 24000)
    send({"type": "ready", "device": device, "sampleRate": rate})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if request.get("op") == "quit":
            break
        job = request.get("id")
        try:
            if request.get("op") != "speak":
                raise ValueError(f"Unknown request {request.get('op')!r}")
            options = {"text": request["text"]}
            if request.get("ref_audio"):
                options["ref_audio"] = request["ref_audio"]
            if request.get("ref_text"):
                options["ref_text"] = request["ref_text"]
            result = model.generate(**options)
            audio = result[0] if isinstance(result, (list, tuple)) else result
            write_wav(request["out"], samples_of(audio), rate)
            send({"id": job, "ok": True})
        except Exception as error:  # noqa: BLE001 - one bad request must not end the sidecar
            sys.stderr.write(traceback.format_exc())
            send({"id": job, "ok": False, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
