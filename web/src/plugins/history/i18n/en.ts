// The terminal history plugin's English messages: the source of its
// message keys (web/src/i18n/en.ts gathers every plugin's). Placeholders:
// {name}.

export const en = {
  'history.title': 'Terminal History',
  'history.description':
    'Snapshots of the terminals’ output, kept on each machine’s disk, to see what a terminal showed before its terminal core started again.',
  'settings.section.history': 'Terminal History',
  'settings.history.capture': 'Keep snapshots of terminal output',
  'settings.history.capture.desc':
    'Writes what the terminals show to this machine’s disk at intervals, to show it after the terminal core started again (a reboot). Terminal output can contain secrets, such as keys, tokens and passwords printed in a terminal: they are written to that machine’s disk too.',
  'settings.history.interval': 'Time between snapshots',
  'settings.history.interval.desc': 'How often a terminal’s output is saved while it changes.',
  'settings.history.interval.unit': 's',
  'settings.history.lines': 'Lines per terminal',
  'settings.history.lines.desc': 'The most lines of a terminal’s output a snapshot keeps.',
  'settings.history.lines.unit': 'lines',
  'settings.history.maxTerminals': 'Terminals',
  'settings.history.maxTerminals.desc': 'The most terminals of a machine that keep a snapshot; the oldest snapshots go first.',
  'settings.history.maxTotalMB': 'Space on disk',
  'settings.history.maxTotalMB.desc': 'The most space the snapshots take on a machine; the oldest go first.',
  'settings.history.maxTotalMB.unit': 'MB',
  'settings.history.days': 'Keep for',
  'settings.history.days.desc': 'Snapshots older than this are removed.',
  'settings.history.days.unit': 'days',
  'history.note': '-- output saved {time}; the program above has ended --',
  'history.settings.saved': 'Saved Output',
  'history.settings.noMachine': 'No machine is shown.',
  'history.settings.loading': 'Reading the snapshots…',
  'history.settings.none': '{machine} keeps no snapshots.',
  'history.settings.count': '{machine} keeps {count} snapshots of terminal output, {size} in all.',
  'history.settings.restoreScreenOn':
    'The terminal core’s own restore_screen is on for {machine}: after a clean stop it shows a replaced program’s last screen above the new shell itself, so saved output is shown there only after the machine restarted; this app never changes the terminal core’s configuration file.',
  'history.settings.restoreScreenOff':
    'The terminal core’s own restore_screen is off for {machine}: saved output is shown above the new shell after every start of the terminal core; this app never changes the terminal core’s configuration file.',
  'history.settings.clear': 'Clear Saved Output',
  'history.settings.clearTitle': 'Clear saved output?',
  'history.settings.clearMessage':
    'The snapshots of every terminal are removed from the disk of {machine}. Terminals that show saved output above their new shell stop showing it.',
  'history.settings.clearConfirm': 'Clear',
  'history.settings.removed': 'Removed the snapshots of {count} terminals.',
  'history.error.offline': 'The machine is not connected.',
  'history.error.network': 'The server did not answer.',
  'history.error.busy': 'The machine is taking snapshots; try again in a moment.',
  'history.error.not_found': 'The snapshot is not there anymore.',
  'history.error.transport': 'The machine did not answer.',
  'history.error.bad_reply': 'The machine’s answer was not understood.',
  'history.error.io': 'The machine could not read or write its saved output.',
  'history.error.timeout': 'The machine took too long to answer.',
} as const;
