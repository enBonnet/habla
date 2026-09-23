import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    HISTORY_ITEM_CHARS, IDLE_ICON, LINGER_MS, METER_BARS, PAUSING, formatAge,
    formatElapsed, isAppendPosition, parseHistory, phaseInfo, truncate,
} from './constants.js';

// voice-dictate is the engine; this extension only reflects it and drives it.
const ENGINE = ['.local', 'bin', 'voice-dictate'];
const RUNTIME_SUBDIR = 'voice-dictate';
const TICK_MS = 150;            // matches the watcher's own sampling interval
const TRANSCRIPT_PREVIEW = 120;

function runtimeDir() {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), RUNTIME_SUBDIR]);
}

// Written while this extension is loaded so voice-dictate knows it can stay quiet;
// removed on disable, which restores notifications with no config change.
function uiFlagPath() {
    return GLib.build_filenamev([runtimeDir(), 'ui']);
}

function historyPath() {
    const state = GLib.getenv('XDG_STATE_HOME')
        ?? GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state']);
    return GLib.build_filenamev([state, RUNTIME_SUBDIR, 'history.tsv']);
}

function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder().decode(bytes);
    } catch {
        return null;   // absent or mid-write; the next tick will pick it up
    }
}

const LevelMeter = GObject.registerClass(
class HablaLevelMeter extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'habla-meter',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._bars = [];
        for (let i = 0; i < METER_BARS; i++) {
            // Taller towards the right, so the shape reads as a level at a glance.
            const bar = new St.Widget({
                style_class: 'habla-meter-bar',
                y_align: Clutter.ActorAlign.CENTER,
                height: 4 + i * 2,
            });
            this._bars.push(bar);
            this.add_child(bar);
        }
    }

    setLevel(level, speaking) {
        this._paint(Math.round(Math.min(1, Math.max(0, level)) * METER_BARS),
            speaking ? 'lit-speech' : 'lit');
    }

    // Same bars, different job. During the pause that ends a take there is no level
    // worth showing, so they drain from the right instead and the wait becomes
    // something you can read at a glance rather than a number you have to focus on.
    setCountdown(fraction) {
        this._paint(Math.ceil(Math.min(1, Math.max(0, fraction)) * METER_BARS),
            'lit-pause');
    }

    _paint(lit, styleClass) {
        this._bars.forEach((bar, i) => {
            for (const name of ['lit', 'lit-speech', 'lit-pause'])
                bar.remove_style_class_name(name);
            if (i < lit)
                bar.add_style_class_name(styleClass);
        });
    }
});

const Indicator = GObject.registerClass(
class HablaIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Habla', false);
        this._extension = extension;
        this._settings = extension.getSettings();
        this._engine = GLib.build_filenamev([GLib.get_home_dir(), ...ENGINE]);
        this._phase = 'idle';
        this._since = 0;
        this._detail = '';
        this._tickId = 0;
        this._lingerId = 0;
        this._pausing = false;
        this._pauseFrom = 1;
        this._retired = 0;

        const box = new St.BoxLayout({ style_class: 'habla-indicator' });
        this._icon = new St.Icon({
            icon_name: IDLE_ICON,
            style_class: 'system-status-icon',
        });
        this._meter = new LevelMeter();
        this._label = new St.Label({
            style_class: 'habla-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);
        box.add_child(this._meter);
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();
        this._watchState();
        this._reload();
    }

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupMenuItem('Idle', { reactive: false });
        this.menu.addMenuItem(this._statusItem);

        // Clicking the preview copies it, so the common case stays one click and
        // does not need a menu entry of its own.
        this._transcriptItem = new PopupMenu.PopupMenuItem('');
        this._transcriptItem.label.add_style_class_name('habla-transcript');
        this._transcriptItem.label.clutter_text.line_wrap = true;
        this._transcriptItem.connect('activate', () => this._copyLast());
        this.menu.addMenuItem(this._transcriptItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._primaryItem = this._action('Start dictation', () => this._run());
        this._cancelItem = this._action('Discard recording', () => this._run('--cancel'));
        this._redoItem = this._action('Re-transcribe accurately',
            () => this._run('--redo'));

        this._historyItem = new PopupMenu.PopupSubMenuMenuItem('Recent transcripts');
        this.menu.addMenuItem(this._historyItem);
        // Rebuilt when the menu opens rather than on every phase change, so the log
        // is read only when someone is actually looking at it.
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._rebuildHistory();
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._action('Settings', () => this._extension.openPreferences());
    }

    _action(label, callback) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => callback());
        this.menu.addMenuItem(item);
        return item;
    }

    _run(...args) {
        try {
            Gio.Subprocess.new([this._engine, ...args], Gio.SubprocessFlags.NONE);
        } catch (error) {
            logError(error, 'habla: could not run voice-dictate');
            Main.notifyError('Habla', `Could not run ${this._engine}`);
        }
    }

    _copy(text) {
        if (text)
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    _copyLast() {
        this._copy(readFile(GLib.build_filenamev([runtimeDir(), 'last.txt'])));
    }

    _rebuildHistory() {
        const submenu = this._historyItem.menu;
        submenu.removeAll();

        const contents = readFile(historyPath());
        const rows = contents
            ? parseHistory(contents, this._settings.get_int('history-size')) : [];
        this._historyItem.visible = rows.length > 0;
        if (!rows.length)
            return;

        const now = new Date();
        for (const row of rows) {
            const age = formatAge(row.when, now);
            const text = truncate(row.text, HISTORY_ITEM_CHARS);
            const item = new PopupMenu.PopupMenuItem(age ? `${age} · ${text}` : text);
            item.connect('activate', () => this._copy(row.text));
            submenu.addMenuItem(item);
        }
        submenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const clear = new PopupMenu.PopupMenuItem('Clear history');
        clear.connect('activate', () => this._run('--clear-history'));
        submenu.addMenuItem(clear);
    }

    // The engine is a fresh process per key press, so the state file is the only
    // thing tying its phases together. Watching the directory rather than the file
    // because it is replaced by rename on every transition.
    _watchState() {
        const dir = runtimeDir();
        GLib.mkdir_with_parents(dir, 0o700);
        this._monitor = Gio.File.new_for_path(dir)
            .monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitorId = this._monitor.connect('changed', () => this._reload());
    }

    _reload() {
        const raw = readFile(GLib.build_filenamev([runtimeDir(), 'state']));
        let phase = 'idle';
        let since = 0;
        let detail = '';
        if (raw) {
            const [rawPhase, rawSince, rawDetail] = raw.trim().split('\t');
            phase = rawPhase || 'idle';
            since = Number.parseFloat(rawSince) || 0;
            detail = rawDetail ?? '';
        }
        if (phase === this._phase && since === this._since)
            return;
        // The engine never writes `idle`, so a finished phase sits in the state file
        // indefinitely. Without this, the next keypress touching anything in the
        // runtime directory would re-run the badge we already showed and retired.
        if (since && since === this._retired)
            return;
        this._phase = phase;
        this._since = since;
        this._detail = detail;
        this._render();
    }

    refresh() {
        this._render();
    }

    _render() {
        this._clearTimers();
        this._icon.remove_all_transitions();
        this._icon.opacity = 255;
        this._pausing = false;

        const info = phaseInfo(this._phase);
        const hideWhenIdle = this._settings.get_boolean('hide-when-idle');

        this._primaryItem.label.text = info && this._phase === 'recording'
            ? 'Stop and transcribe' : 'Start dictation';
        this._cancelItem.visible = this._phase === 'recording';
        this._redoItem.visible = this._phase !== 'recording';

        const transcript = readFile(
            GLib.build_filenamev([runtimeDir(), 'last.txt']));
        this._transcriptItem.visible = Boolean(transcript);
        if (transcript) {
            this._transcriptItem.label.text = transcript.length > TRANSCRIPT_PREVIEW
                ? `${transcript.slice(0, TRANSCRIPT_PREVIEW)}…` : transcript;
        }

        if (!info) {
            this._statusItem.label.text = 'Idle';
            this._icon.icon_name = IDLE_ICON;
            this._icon.style_class = 'system-status-icon';
            this._label.text = '';
            this._meter.visible = false;
            this.visible = !hideWhenIdle;
            return;
        }

        this.visible = true;
        this._icon.icon_name = info.icon;
        this._icon.style_class = `system-status-icon ${info.styleClass}`;
        if (info.pulse) {
            this._icon.ease({
                opacity: 80,
                duration: 650,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                autoReverse: true,
                repeatCount: -1,
            });
        }
        this._statusItem.label.text = this._detail
            ? `${info.label} — ${this._detail}` : info.label;

        this._meter.visible = info.meter && this._settings.get_boolean('show-level');
        if (this._meter.visible)
            this._meter.setLevel(0, false);

        this._label.visible = info.timer && this._settings.get_boolean('show-timer');
        this._tick();
        if (info.timer || info.meter)
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS,
                () => (this._tick(), GLib.SOURCE_CONTINUE));

        if (Object.hasOwn(LINGER_MS, this._phase)) {
            this._lingerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                LINGER_MS[this._phase], () => {
                    this._lingerId = 0;
                    this._retired = this._since;
                    this._phase = 'idle';
                    this._render();
                    return GLib.SOURCE_REMOVE;
                });
        }
    }

    _tick() {
        const remaining = this._phase === 'recording' ? this._sampleAudio() : -1;
        if (!this._label.visible)
            return;
        if (remaining >= 0)
            this._label.text = `${remaining.toFixed(1)}s`;
        else if (this._since > 0)
            this._label.text = formatElapsed(Date.now() / 1000 - this._since);
    }

    // voice-autostop rewrites the level file several times a second with what the mic
    // is hearing and, once you go quiet, how long this take has left before the pause
    // ends it. Returns those seconds, or -1 while you are still talking.
    _sampleAudio() {
        const raw = readFile(GLib.build_filenamev([runtimeDir(), 'audio', 'level']));
        if (!raw) {
            // The watcher deletes this the moment it decides to end the take, a beat
            // before the engine gets as far as `transcribing`. Holding the pause look
            // across that gap is what stops it flashing back to plain recording.
            if (this._pausing)
                return 0;
            if (this._meter.visible)
                this._meter.setLevel(0, false);
            return -1;
        }

        const [level, speaking, countdown] = raw.trim().split('\t');
        const remaining = Number.parseFloat(countdown ?? '');
        const pausing = remaining >= 0;

        if (pausing && !this._pausing)
            this._pauseFrom = remaining || 1;   // the whole wait, to drain against
        if (pausing !== this._pausing) {
            this._pausing = pausing;
            this._showPausing(pausing);
        }

        if (this._meter.visible) {
            if (pausing)
                this._meter.setCountdown(remaining / this._pauseFrom);
            else
                this._meter.setLevel(Number.parseFloat(level) || 0, speaking === '1');
        }
        return pausing ? remaining : -1;
    }

    // Recording and waiting-to-see-if-you-carry-on are the same phase to the engine but
    // not to you, so they do not get to look the same.
    _showPausing(pausing) {
        const info = pausing ? PAUSING : phaseInfo('recording');
        this._icon.icon_name = info.icon;
        this._icon.style_class = `system-status-icon ${info.styleClass}`;
        this._statusItem.label.text = pausing
            ? 'Pausing — ending the take unless you carry on' : info.label;
    }

    _clearTimers() {
        for (const id of ['_tickId', '_lingerId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
    }

    destroy() {
        this._clearTimers();
        if (this._monitorId) {
            this._monitor.disconnect(this._monitorId);
            this._monitorId = 0;
        }
        this._monitor?.cancel();
        this._monitor = null;
        super.destroy();
    }
});

export default class HablaExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._handlerIds = [];
        this._announce(true);
        this._place();
        for (const key of ['position', 'panel-box']) {
            this._handlerIds.push(this._settings.connect(
                `changed::${key}`, () => this._place()));
        }
        for (const key of ['hide-when-idle', 'show-timer', 'show-level']) {
            this._handlerIds.push(this._settings.connect(
                `changed::${key}`, () => this._indicator?.refresh()));
        }
    }

    _place() {
        this._indicator?.destroy();
        this._indicator = new Indicator(this);
        const position = this._settings.get_int('position');
        Main.panel.addToStatusArea(this.uuid, this._indicator,
            isAppendPosition(position) ? 0 : position,
            this._settings.get_string('panel-box'));
    }

    _announce(present) {
        const file = Gio.File.new_for_path(uiFlagPath());
        try {
            if (!present) {
                file.delete(null);
                return;
            }
            GLib.mkdir_with_parents(runtimeDir(), 0o700);
            GLib.file_set_contents(file.get_path(),
                `${Gio.Credentials.new().get_unix_pid()}\n`);
        } catch (error) {
            if (present)
                logError(error, 'habla: could not claim notification suppression');
        }
    }

    disable() {
        this._announce(false);
        for (const id of this._handlerIds ?? [])
            this._settings.disconnect(id);
        this._handlerIds = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
