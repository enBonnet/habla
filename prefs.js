import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences }
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { isAppendPosition } from './constants.js';

const BOXES = [
    ['left', 'Left'],
    ['center', 'Center'],
    ['right', 'Right'],
];

export default class HablaPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Habla',
            icon_name: 'audio-input-microphone-symbolic',
        });

        const displayGroup = new Adw.PreferencesGroup({
            title: 'Indicator',
            description: 'What the top bar shows while you are dictating',
        });
        page.add(displayGroup);

        displayGroup.add(this._toggle(settings, 'hide-when-idle', 'Hide when idle',
            'Show the indicator only while dictation is running'));
        displayGroup.add(this._toggle(settings, 'show-timer', 'Elapsed time',
            'Count up while recording and transcribing'));
        displayGroup.add(this._toggle(settings, 'show-level', 'Input level',
            'Live meter while recording. The middle bar sits at the speech '
            + 'threshold, so anything past it is being heard as speech'));

        const historyRow = new Adw.SpinRow({
            title: 'Recent transcripts',
            subtitle: 'How many to list in the menu. Click one to copy it.',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 30, step_increment: 1, page_increment: 5,
            }),
        });
        settings.bind('history-size', historyRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(historyRow);

        const positionGroup = new Adw.PreferencesGroup({
            title: 'Panel position',
            description: 'Where the indicator sits in the top bar',
        });
        page.add(positionGroup);

        const boxModel = new Gtk.StringList();
        for (const [, label] of BOXES)
            boxModel.append(label);
        const boxRow = new Adw.ComboRow({ title: 'Side', model: boxModel });
        const currentBox = BOXES.findIndex(
            ([id]) => id === settings.get_string('panel-box'));
        boxRow.set_selected(currentBox === -1 ? 2 : currentBox);
        boxRow.connect('notify::selected', () => {
            const [id] = BOXES[boxRow.selected];
            settings.set_string('panel-box', id);
        });
        positionGroup.add(boxRow);

        const row = new Adw.ActionRow({
            title: 'Slot',
            subtitle: this._describe(settings.get_int('position')),
        });
        const left = new Gtk.Button({
            icon_name: 'pan-start-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Move left',
        });
        const right = new Gtk.Button({
            icon_name: 'pan-end-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Move right',
        });
        left.connect('clicked', () => {
            const current = settings.get_int('position');
            settings.set_int('position', current <= 0 ? 0 : current - 1);
        });
        right.connect('clicked', () => {
            const current = settings.get_int('position');
            settings.set_int('position', current + 1);
        });
        row.add_prefix(left);
        row.add_suffix(right);
        settings.connect('changed::position', () => {
            row.subtitle = this._describe(settings.get_int('position'));
        });
        positionGroup.add(row);

        const keysGroup = new Adw.PreferencesGroup({
            title: 'Keyboard shortcuts',
            description: 'Owned by GNOME Settings → Keyboard → Custom Shortcuts, '
                + 'not by this extension',
        });
        page.add(keysGroup);
        for (const [keys, what] of [
            ['Super+Alt+V', 'Dictate, detecting Spanish or English'],
            ['Super+Alt+C', 'Dictate in Spanish'],
            ['Super+Alt+X', 'Dictate in English'],
            ['Super+Alt+G', 'Re-transcribe the last take accurately'],
            ['Super+Alt+Esc', 'Discard the recording'],
        ]) {
            keysGroup.add(new Adw.ActionRow({ title: keys, subtitle: what }));
        }

        window.add(page);
    }

    _describe(position) {
        return isAppendPosition(position)
            ? 'First in the box' : `Slot ${position + 1}`;
    }

    _toggle(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({ title, subtitle });
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
