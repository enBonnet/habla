// Phases are written by voice-dictate into $XDG_RUNTIME_DIR/voice-dictate/state as
// "<phase>\t<unix time it started>\t<detail>". Anything not listed here is idle.
export const PHASES = {
    recording: {
        icon: 'media-record-symbolic',
        label: 'Recording',
        styleClass: 'habla-recording',
        timer: true,
        meter: true,
    },
    transcribing: {
        icon: 'content-loading-symbolic',
        label: 'Transcribing',
        styleClass: 'habla-working',
        timer: true,
        meter: false,
        // Whisper takes seconds, not milliseconds, and the panel is glanced at rather
        // than watched. Breathing is what says "still going" without being read.
        pulse: true,
    },
    pasting: {
        icon: 'edit-paste-symbolic',
        label: 'Pasting',
        styleClass: 'habla-working',
        timer: false,
        meter: false,
    },
    done: {
        icon: 'object-select-symbolic',
        label: 'Done',
        styleClass: 'habla-done',
        timer: false,
        meter: false,
    },
    error: {
        icon: 'dialog-warning-symbolic',
        label: 'Failed',
        styleClass: 'habla-error',
        timer: false,
        meter: false,
    },
};

// Not a phase of its own: the engine is still recording, and this is voice-autostop
// counting out the pause that will end the take. It arrives through the level file
// rather than the state file because it changes several times a second.
export const PAUSING = {
    icon: 'media-playback-pause-symbolic',
    label: 'Pausing',
    styleClass: 'habla-pausing',
};

export const IDLE_ICON = 'audio-input-microphone-symbolic';

// How long a finished phase stays on screen before the indicator goes quiet again.
export const LINGER_MS = {
    pasting: 1500,
    done: 2500,
    error: 6000,
};

export const METER_BARS = 5;

// Sentinel for the `position` key meaning "append at the end of the box". Any
// negative value is treated as append, matching the convention in guigna.
export const POSITION_APPEND = -1;

export function isAppendPosition(position) {
    return position < 0;
}

export function phaseInfo(phase) {
    return Object.hasOwn(PHASES, phase) ? PHASES[phase] : null;
}

export function formatElapsed(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${(whole % 60).toString().padStart(2, '0')}`;
}

// How much of a transcript fits on one submenu row before it is elided.
export const HISTORY_ITEM_CHARS = 52;

// voice-dictate appends one tab-separated row per transcript to history.tsv:
// iso time, audio seconds, whisper seconds, model, language, characters, text.
// The text field is always single-line, because voice-transcribe collapses
// whitespace before printing. Returns newest first.
export function parseHistory(contents, limit) {
    const rows = [];
    for (const line of contents.split('\n')) {
        if (!line)
            continue;
        const fields = line.split('\t');
        if (fields.length < 7)
            continue;
        const when = new Date(fields[0]);
        rows.push({
            when: Number.isNaN(when.getTime()) ? null : when,
            model: fields[3],
            language: fields[4],
            text: fields.slice(6).join('\t'),
        });
    }
    return rows.slice(-limit).reverse();
}

export function formatAge(date, now = new Date()) {
    if (!date)
        return '';
    const seconds = Math.max(0, (now.getTime() - date.getTime()) / 1000);
    if (seconds < 60)
        return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return days === 1 ? 'yesterday' : `${days}d ago`;
}

export function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
