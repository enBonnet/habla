#!/usr/bin/bash
# Installs Habla: the dictation engine, its services and hotkeys, and the GNOME
# Shell extension. Safe to re-run -- it reuses existing hotkey slots rather than
# stacking duplicates, and never overwrites your config.
#
#   ./install.sh                 everything
#   ./install.sh --no-packages   skip dnf (e.g. not on Fedora)
#   ./install.sh --no-model      skip the whisper model download
#   ./install.sh --no-keys       leave GNOME keyboard shortcuts alone

set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
UUID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["uuid"])' "$HERE/metadata.json")
BIN_DIR=$HOME/.local/bin
CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/voice-dictate
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user

DO_PACKAGES=1 DO_MODEL=1 DO_KEYS=1
for arg in "$@"; do
    case $arg in
        --no-packages) DO_PACKAGES=0 ;;
        --no-model)    DO_MODEL=0 ;;
        --no-keys)     DO_KEYS=0 ;;
        -h|--help)     sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$1"; }

[[ ${XDG_SESSION_TYPE:-} == wayland ]] || warn "not a Wayland session; ydotool paste may behave differently"

if (( DO_PACKAGES )); then
    say "Installing packages"
    # whisper-cpp ships libraries only (no CLI) -- python3-pywhispercpp is the usable
    # entry point, and the whisper-cpp package additionally provides the HIP/ROCm
    # backend that the engine preloads for GPU acceleration.
    packages=(whisper-cpp python3-pywhispercpp ydotool wl-clipboard pipewire-utils libnotify)
    if command -v dnf >/dev/null; then
        missing=()
        for p in "${packages[@]}"; do rpm -q "$p" >/dev/null 2>&1 || missing+=("$p"); done
        if (( ${#missing[@]} )); then
            echo "    ${missing[*]}"
            if command -v pkexec >/dev/null && [[ -z ${SUDO_USER:-} ]]; then
                pkexec dnf install -y "${missing[@]}"
            else
                sudo dnf install -y "${missing[@]}"
            fi
        else
            echo "    all present"
        fi
    else
        warn "no dnf; install manually: ${packages[*]}"
    fi
fi

say "Installing the engine into $BIN_DIR"
install -Dm755 -t "$BIN_DIR" "$HERE"/bin/voice-dictate "$HERE"/bin/voice-transcribe \
    "$HERE"/bin/voice-autostop
echo "    voice-dictate, voice-transcribe, voice-autostop"
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on your PATH (the hotkeys use absolute paths, so this only affects running them by hand)" ;;
esac

say "Configuration"
mkdir -p "$CONFIG_DIR"
if [[ -e $CONFIG_DIR/config ]]; then
    echo "    keeping your existing $CONFIG_DIR/config"
    echo "    (compare against $HERE/config/config.example for new options)"
else
    install -Dm644 "$HERE/config/config.example" "$CONFIG_DIR/config"
    echo "    wrote $CONFIG_DIR/config"
fi

say "ydotoold user service"
# /dev/uinput carries a logind ACL for the seat owner, so this needs no privileges.
install -Dm644 "$HERE/systemd/ydotoold.service" "$UNIT_DIR/ydotoold.service"
systemctl --user daemon-reload
systemctl --user enable --now ydotoold.service
echo "    $(systemctl --user is-active ydotoold.service)"

if (( DO_MODEL )); then
    say "Whisper models"
    if ! python3 -c 'import pywhispercpp' >/dev/null 2>&1; then
        warn "python3-pywhispercpp not importable; skipping the model download (install the packages, then re-run with --no-packages --no-keys)"
    else
    python3 - "$CONFIG_DIR/config" <<'PY'
import re, sys, pathlib
text = pathlib.Path(sys.argv[1]).read_text()
def value(key, fallback):
    m = re.search(rf'^{key}=([^\s#]+)', text, re.M)
    return m.group(1).strip('"\'') if m else fallback
wanted = {value('MODEL', 'small-q5_1'), value('MODEL_ACCURATE', 'large-v3-turbo-q5_0')}
from pywhispercpp.constants import MODELS_DIR
for name in sorted(wanted):
    target = pathlib.Path(MODELS_DIR) / f'ggml-{name}.bin'
    if target.exists():
        print(f'    {name}: present ({target.stat().st_size // 2**20} MB)')
        continue
    print(f'    {name}: downloading...')
    from pywhispercpp.model import Model
    Model(name, redirect_whispercpp_logs_to=None)
PY
    fi
fi

if (( DO_KEYS )); then
    say "Keyboard shortcuts"
    python3 - "$BIN_DIR/voice-dictate" <<'PY'
import ast, subprocess, sys

ENGINE = sys.argv[1]
BASE = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings'
SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding'
PARENT = 'org.gnome.settings-daemon.plugins.media-keys'
WANTED = [
    ('Dictate (auto ES/EN)',     '<Super><Alt>v',      ''),
    ('Dictate (Spanish)',        '<Super><Alt>c',      '--lang es'),
    ('Dictate (English)',        '<Super><Alt>x',      '--lang en'),
    ('Dictate cancel',           '<Super><Alt>Escape', '--cancel'),
    ('Dictate redo (accurate)',  '<Super><Alt>g',      '--redo'),
]

def get(path, key):
    out = subprocess.run(['gsettings', 'get', f'{SCHEMA}:{path}', key],
                         capture_output=True, text=True)
    return ast.literal_eval(out.stdout.strip()) if out.returncode == 0 else ''

def put(path, key, value):
    subprocess.check_call(['gsettings', 'set', f'{SCHEMA}:{path}', key, value])

current = ast.literal_eval(subprocess.check_output(
    ['gsettings', 'get', PARENT, 'custom-keybindings'], text=True).strip())

# Reuse any slot already pointing at our engine, so re-running does not stack copies.
ours = {get(p, 'command'): p for p in current if ENGINE in str(get(p, 'command'))}
used = {int(p.rstrip('/').rsplit('custom', 1)[1]) for p in current
        if p.rstrip('/').rsplit('custom', 1)[-1].isdigit()}
free = (i for i in range(1000) if i not in used)

added = 0
for name, binding, args in WANTED:
    command = f'{ENGINE} {args}'.strip()
    path = ours.get(command)
    if path is None:
        path = f'{BASE}/custom{next(free)}/'
        used.add(int(path.rstrip("/").rsplit("custom", 1)[1]))
        current.append(path)
        added += 1
    put(path, 'name', name)
    put(path, 'binding', binding)
    put(path, 'command', command)
    print(f'    {binding:<22}{name}')

subprocess.check_call(['gsettings', 'set', PARENT, 'custom-keybindings', str(current)])
print(f'    {added} new slot(s); {len(current)} custom shortcuts in total (existing ones untouched)')
PY
fi

say "GNOME Shell extension"
command -v zip >/dev/null || { echo "zip(1) is required to bundle the compiled schema" >&2; exit 1; }
glib-compile-schemas "$HERE/schemas"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
gnome-extensions pack --force --out-dir="$tmp" --extra-source=constants.js "$HERE"
# gnome-extensions pack on GNOME 50 omits schemas/gschemas.compiled; without it
# getSettings() fails after install, so append the freshly compiled cache.
(cd "$HERE" && zip -q "$tmp"/*.shell-extension.zip schemas/gschemas.compiled)
gnome-extensions install --force "$tmp"/*.shell-extension.zip
echo "    installed $UUID"

# Superseded by the extension. Left running for this session so you are not left
# without an indicator; it simply will not come back after you log in again.
if systemctl --user is-enabled voice-indicator.service >/dev/null 2>&1; then
    systemctl --user disable voice-indicator.service >/dev/null 2>&1 || true
    echo "    disabled the old AppIndicator daemon (the extension replaces it)"
fi

say "Done"
cat <<NEXT
    GNOME cannot load a new extension into a running Wayland session, so:

      1. Log out and back in
      2. gnome-extensions enable $UUID

    Then press Super+Alt+V and talk. Everything else already works right now.
NEXT
