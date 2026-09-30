# omp-dictate

An [omp](https://github.com/can1357/oh-my-pi) extension: `/dictate` turns your microphone into live text in the composer.

- Transcript appears **while you speak** (rolling partial hypotheses, not a batch at the end).
- **Enter** finishes the dictation and inserts the transcript into the composer as editable text — it does **not** send it. Edit, then press Enter again to send.
- **Esc** / **Ctrl+C** discards the dictation.
- Audio never leaves the machine: it goes to a local `fermion serve` process over `127.0.0.1`.

```
/dictate        start dictating — speak, watch the text appear
/dictate 20     same, but finish and insert automatically after 20 s

● rec 0:04  ▮▮▮▮▮▮▯▯▯▯▯▯  default source
Enter insert · Esc discard · cap 120s

  The quick brown fox jumps over the lazy dog.
  Dictation should show these words as they arise▍
```

## Requirements

- omp with extension support (verified on 18.4.4).
- Linux with PipeWire (`pw-record` from `pipewire`/`pipewire-audio`, or `pipewire-bin` on Arch).
- A local speech-to-text server exposing fermion's live endpoint:

```sh
uv tool install fermion-research      # or: pip install fermion-research
fermion serve --model phonon-2 --host 127.0.0.1 --port 8000
```

The extension talks to `GET /v1/audio/stream` — fermion's WebSocket live-transcription route, which is mounted only when the served model is a speech model. Any speech model served by `fermion serve` works; the extension never names one itself.

## Install

As an omp plugin (this repo is also a marketplace):

```sh
omp plugin marketplace add IlyaasK/omp-dictate
omp plugin install dictate@omp-dictate
```

Then restart omp (extension modules are loaded at startup). In the TUI the equivalent is `/marketplace add IlyaasK/omp-dictate` and `/marketplace install dictate@omp-dictate`.

As a single file:

```sh
# user-level, loaded in every session
cp extensions/dictate.ts ~/.omp/agent/extensions/

# or per run
omp --extension ./extensions/dictate.ts
```

## Usage

| Key | Effect |
| --- | --- |
| `Enter` | finish, insert the transcript into the composer — **not sent** |
| `Esc` / `Ctrl+C` | discard the dictation |
| *(timeout)* | `/dictate N` (or `DICTATE_MAX_SECONDS`) auto-inserts after N seconds, so a forgotten dictation cannot record forever |

The view replaces the composer area while dictating, which is how `Enter` is captured instead of being submitted. Requires the interactive TUI (`ctx.hasUI`); in RPC/print mode the command reports that it needs the TUI.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DICTATE_ENDPOINT` | `http://127.0.0.1:8000/v1/audio/transcriptions` | Host/port of the fermion server. The WebSocket URL is derived from it (`http`→`ws`, path → `/v1/audio/stream`). |
| `DICTATE_STREAM_URL` | — | Explicit WebSocket endpoint, overrides the derivation. |
| `DICTATE_TARGET` | system default source | PipeWire **node name** for `pw-record --target` (e.g. a specific microphone). |
| `DICTATE_MAX_SECONDS` | `120` | Hard cap for a forgotten dictation. |

Useful commands while it runs:

```sh
pactl list short sources     # find a source node name for DICTATE_TARGET
pw-record --list-formats     # the extension uses --format f32
```

## How it works

1. `pw-record --rate 16000 --channels 1 --format f32 --latency 20ms -a -` — raw 16 kHz mono f32 PCM on stdout. Capture starts before the WebSocket opens; frames are queued for the handshake so the first words are not lost.
2. Frames are pushed to `ws://…/v1/audio/stream` after the config frame `{"sample_rate":16000,"format":"pcm_f32le"}`.
3. The server answers `{"type":"partial","text":…}` (the whole current hypothesis, replacing the previous one), `{"type":"final","text":…,"segment":N}` (one per finished phrase) and `{"type":"done","text":…}` (full transcript) at the end.
4. `Enter` sends `{"type":"end"}` after letting the recorder's stdout drain, waits for `done` (30 s ceiling), then writes the transcript into the composer with the editor text that was there before.

The level meter is the RMS of the captured blocks; the elapsed clock and meter tick locally, so the display moves even while the model is silent.

`SIGTERM` then a 500 ms drain is used to stop `pw-record` — the tail of the audio still belongs to the phrase being decoded.

## Cleanup and failure behavior

- `Esc`, the cap timeout, a dead port and a mid-stream server error all tear down the subprocess and socket and hand control back to the composer; a failed session inserts nothing.
- Errors are surfaced as notifications, e.g. `dictate: cannot reach ws://127.0.0.1:8000/v1/audio/stream — start it with \`fermion serve --model phonon-2\``.
- If the stream closes before you press Enter, whatever was already finalized is discarded — press Enter to insert, or Esc to discard; there is no silent partial insert.
- `session_shutdown` kills a live recorder.

## Verification

Exercised against omp 18.4.4 on Arch (PipeWire 1.x) with `fermion serve --model phonon-2`: live partials growing phrase-by-phrase, insert-without-send (session transcript stays empty), a second Enter sending exactly the inserted text, Esc discarding streamed text, `/dictate N` auto-insert, and the unreachable-endpoint error path. Audio was driven through a virtual PipeWire source so the capture path (`pw-record` → WebSocket) is the same one used with a real microphone.

## License

MIT — see [LICENSE](LICENSE).
