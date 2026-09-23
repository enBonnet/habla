# Habla — Voice Dictation for GNOME

Press a key, talk, stop talking. What you said is transcribed locally and pasted
wherever your cursor is — a terminal, a browser, an editor, a chat box.

Transcription runs entirely on your machine with [whisper.cpp](https://github.com/ggerganov/whisper.cpp),
accelerated on an AMD iGPU through ROCm. Nothing is sent anywhere.

Built for GNOME 50 on Wayland (Fedora 44).

## What it does

- **One key press per sentence.** It notices when you stop talking and wraps up by
  itself. A second press stops it immediately if you would rather not wait.
- **Spanish and English**, auto-detected, with dedicated shortcuts when you want to
  force one.
- **A panel indicator** that shows a live input level while recording — so you can see
  it hearing *you* and not the room — counts the pause out before it ends a take, and
  tells recording, waiting and transcribing apart at a glance.
- **Never submits for you.** The text lands as editable text; you read it and press
  Enter yourself.
- **Re-transcribe accurately** with one key if the fast model garbled something. It
  reuses the same recording, so you never say it twice.
- **Keeps what you said.** The menu lists your recent transcripts; click one to put it
  back on the clipboard, to paste somewhere else or to edit.

## How it fits together

Two halves that talk through files in `$XDG_RUNTIME_DIR/voice-dictate/`:

| | |
|---|---|
| `voice-dictate` | Shell script. One-shot per key press: starts or stops the recorder, transcribes, pastes. Publishes its phase to `state`. |
| `voice-autostop` | Watches the clip as it is written and ends the take once you pause. Publishes the input level, and the countdown of the pause that will end the take, to `level`. |
| `voice-transcribe` | Wraps whisper.cpp. Reads a WAV, prints text. |
| the extension | Reads `state` and `level`, draws the indicator, and runs `voice-dictate` for menu actions. |

The engine works with no extension at all — the extension is a face for it, not a
dependency. That split also means a shell crash or an extension reload cannot lose a
recording in progress.

## Requirements

| Package | Why |
|---|---|
| `python3-pywhispercpp` | The actual transcriber. Fedora's `whisper-cpp` package ships **libraries only, no CLI binary**, so these bindings are the usable entry point. |
| `whisper-cpp` | Not for its binaries but for `libggml-hip` — the ROCm backend the engine preloads for GPU acceleration. |
| `ydotool` | Synthesises the paste keystroke. `wtype` cannot be used: it needs the virtual-keyboard Wayland protocol, which Mutter does not implement. |
| `wl-clipboard` | Carries the transcript. |
| `pipewire-utils` | `pw-record` does the capture. |
| `libnotify` | Desktop notifications (optional — set `NOTIFY=0`). |

Plus a ROCm-capable AMD GPU for the fast path. Without one it falls back to CPU
automatically, roughly 5× slower.

`ydotoold` runs as a **plain user service, not root**: `/dev/uinput` already carries a
logind ACL for the seat owner.

## Install

```sh
git clone https://github.com/enBonnet/habla.git
cd habla
./install.sh
```

Then, because GNOME cannot load a new extension into a running Wayland session:

```sh
# log out and back in first
gnome-extensions enable habla@enbonnet.github.com
```

The engine works immediately; only the indicator waits for the re-login.

`install.sh` is safe to re-run — it reuses the keyboard shortcut slots it already
created instead of stacking duplicates, and never overwrites your config. Flags:
`--no-packages`, `--no-model`, `--no-keys`.

### By hand

```sh
sudo dnf install whisper-cpp python3-pywhispercpp ydotool wl-clipboard pipewire-utils libnotify
install -Dm755 -t ~/.local/bin bin/voice-*
install -Dm644 config/config.example ~/.config/voice-dictate/config
install -Dm644 systemd/ydotoold.service ~/.config/systemd/user/ydotoold.service
systemctl --user daemon-reload && systemctl --user enable --now ydotoold.service
glib-compile-schemas schemas
gnome-extensions pack --force --extra-source=constants.js .
zip habla@enbonnet.github.com.shell-extension.zip schemas/gschemas.compiled
gnome-extensions install --force habla@enbonnet.github.com.shell-extension.zip
```

Shortcuts then have to be added under Settings → Keyboard → Custom Shortcuts, each
running `~/.local/bin/voice-dictate` with the arguments in the table below.

## Shortcuts

| Keys | Runs | What |
|---|---|---|
| `Super+Alt+V` | `voice-dictate` | Dictate, detecting Spanish or English |
| `Super+Alt+C` | `voice-dictate --lang es` | Force Spanish |
| `Super+Alt+X` | `voice-dictate --lang en` | Force English |
| `Super+Alt+G` | `voice-dictate --redo` | Re-transcribe the last take with the accurate model |
| `Super+Alt+Esc` | `voice-dictate --cancel` | Throw the recording away |

Auto-detection is reliable on full sentences and shakier on two-word utterances, which
is what the forced-language shortcuts are for.

## Configuration

Everything lives in `~/.config/voice-dictate/config`, read as shell syntax.

| Option | Default | Notes |
|---|---|---|
| `MODEL` | `small-q5_1` | ~1.5 s on a 17 s dictation. See the table below. |
| `MODEL_ACCURATE` | `large-v3-turbo-q5_0` | Used by `--redo` only. |
| `DICTATE_LANG` | `auto` | `auto`, `es`, `en`. |
| `AUTOSTOP` | `1` | `0` = always press twice. |
| `SILENCE_SECS` | `2.0` | How long a pause means "done". Raise it if it cuts you off while thinking. |
| `NO_SPEECH_TIMEOUT` | `8` | Give up if nothing was ever said. |
| `MAX_SECONDS` | `120` | Hard cap on one take. |
| `MIC` | *(default source)* | A name from `pactl list short sources`. |
| `PASTE_KEYS` | `ctrl+shift+v` | Raw keycodes; see below. |
| `COPY_ONLY` | `0` | `1` = clipboard only, never synthesise a keystroke. |
| `GPU` | `1` | `0` pins to CPU. |
| `THREADS` | `16` | CPU threads. |
| `PROMPT` | *(a word list)* | Biases spelling of names you say often. |
| `NOTIFY` | `auto` | `auto` = quiet while the indicator is loaded, failures excepted. `1` = always, `0` = never. |

### Choosing a model

Measured here on a Radeon 860M over ROCm, on a 17-second dictation:

| Model | Time | Quality |
|---|---|---|
| `small-q5_1` | **1.5 s** | The odd short word or accent slips |
| `large-v3-turbo-q5_0` | 8 s | Best |
| `medium-q5_0` | 6–11 s | Erratic, and no more accurate than `small`. Skip it. |

`small` is the default because an 8-second wait per sentence is worse than an
occasional wrong word you can fix with `Super+Alt+G`.

Note that `large-v3-turbo` is **not** fast on CPU: turbo shrinks only the decoder, and
on short clips the encoder is the entire cost.

### Paste keystroke

`ydotool` 1.0.4 speaks raw keycodes only (see `/usr/include/linux/input-event-codes.h`):

```sh
PASTE_KEYS="29:1 42:1 47:1 47:0 42:0 29:0"   # ctrl+shift+v — terminals
PASTE_KEYS="29:1 47:1 47:0 29:0"             # ctrl+v — most GUI apps
```

The transcript goes through the **clipboard** rather than `ydotool type`, deliberately:
`ydotool` types through a US keycode table and mangles every `á é í ó ú ñ ¿ ¡`. The
clipboard is UTF-8 clean, and because terminals honour bracketed paste a multi-line
transcript arrives as one editable block instead of being submitted line by line.

## The menu

Click the indicator for:

- **The last transcript**, shown in full at the top — clicking it copies it.
- **Recent transcripts** — the last 10 (configurable up to 30), newest first, each
  labelled with its age. Clicking one copies it to the clipboard; you paste it wherever
  you want, or edit it first. Nothing is typed for you, so opening the menu can never
  disturb the window you were in.
- Stop, discard, and re-transcribe actions for whatever is running.
- **Clear history**, at the bottom of the submenu.

### Notifications

With the extension loaded, `NOTIFY=auto` (the default) suppresses the routine popups —
recording, transcribing, dictated, nothing heard — because the indicator already shows
all of it. Only failures still raise a notification, since those you would otherwise
only discover by happening to look at the panel.

Disabling the extension restores notifications automatically: it publishes a flag file
while loaded and removes it on disable, so nothing needs reconfiguring.

## What the panel is telling you

Each state has its own colour, so which one you are in is readable without stopping to
look properly:

| | | |
|---|---|---|
| 🔴 red record | **Recording** | Bars show the level; past the middle bar you are being counted as speech, below it you are room noise. The timer counts up. |
| 🟠 amber pause | **Waiting** | You have stopped talking and `SILENCE_SECS` is running out. The same bars drain from the right and the label counts down the seconds you have left to carry on. Say anything and it goes straight back to red. |
| 🔵 blue, breathing | **Transcribing** | Whisper is working. The icon pulses so it is obvious nothing is stuck, and the timer counts how long it has taken. |
| 🟢 green tick | **Done** | The text is on the clipboard and pasted. Clears itself after a couple of seconds. |
| 🟡 yellow warning | **Failed** | Run `voice-dictate` in a terminal to see why. |

The waiting state only appears once the gap outlasts a normal pause between words, so
it does not flicker its way through a sentence.

## Indicator settings

`gnome-extensions prefs habla@enbonnet.github.com`, or the Settings item in its menu:
which side of the panel it sits on and where, whether to hide it when idle, and whether
to show the timer and level meter.

With the timer off you lose the countdown digits during the wait, and with the meter
off you lose the draining bars; the colour change stays either way.

## Things worth knowing

**It hears the room.** Auto-stop keys off *any* speech, and it cannot tell your voice
from a conversation nearby or a video playing. In testing it happily recorded 32
seconds of someone else talking. If that matters, set `MIC` to a close-talking headset
or lower `MAX_SECONDS`.

**The silence threshold is relative, not absolute.** An absolute one is impossible here:
measured RMS of real speech came in at 0.003 while ambient noise on another source was
0.15. The watcher tracks each clip's own noise floor (15th percentile, adapting
downward only so a long sentence cannot drag it up) and counts speech at 2.5× that.

**Whisper hallucinates on silence.** Given nothing to hear it emits plausible sentences,
and given a `PROMPT` it tends to parrot it back verbatim. `voice-transcribe` drops any
result whose words are more than 80% drawn from the prompt.

**Everything you dictate is logged in plaintext** to
`~/.local/state/voice-dictate/history.tsv` — timestamp, audio seconds, transcription
seconds, model, language, length, and the text itself. That log is what backs the
Recent transcripts menu, and what lets you judge whether a model swap is worth it. It
is not encrypted and it does not rotate, so if you dictate something sensitive, clear
it: `voice-dictate --clear-history`, or the menu item.

## Troubleshooting

**Nothing pastes, but the text is on the clipboard.** `PASTE_KEYS` does not match the
focused app. Try the `ctrl+v` variant, or set `COPY_ONLY=1` and paste by hand.

**Nothing happens at all.** Check the daemon: `systemctl --user status ydotoold`. Then
run `voice-dictate` from a terminal, where errors are visible instead of swallowed.

**It stops while you are still thinking.** Raise `SILENCE_SECS`.

**It never stops.** Something is making speech-like noise. Check with
`pactl list short sources`, and set `MIC` explicitly.

**Transcription is slow.** Confirm the GPU is in use — `GPU=1` and
`journalctl --user` around the run, or `rocm-smi` while it works. The engine falls back
to CPU silently, which is about 5× slower.

**The indicator is missing after a re-login.** `gnome-extensions info habla@enbonnet.github.com`,
and check for errors with `journalctl --user -b -o cat /usr/bin/gnome-shell | grep -i habla`.

## Uninstall

```sh
gnome-extensions disable habla@enbonnet.github.com
gnome-extensions uninstall habla@enbonnet.github.com
systemctl --user disable --now ydotoold.service
rm ~/.local/bin/voice-dictate ~/.local/bin/voice-transcribe ~/.local/bin/voice-autostop
rm -rf ~/.config/voice-dictate ~/.local/share/pywhispercpp
```

Keyboard shortcuts are removed under Settings → Keyboard → Custom Shortcuts.

## License

GPL-2.0. See [LICENSE](LICENSE).
