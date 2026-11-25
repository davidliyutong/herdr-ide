// How machines get their build (the section machines, which the web UI
// shows among the advanced settings): whether a machine downloads its
// build from the release itself, also per machine, for sites that forbid
// machines to reach it (the hub uploads it then).
import { bool, defineModule } from '#kernel/config/settings/index.ts';

export const DOWNLOAD = 'machines.download';

export const settings = defineModule({
  sections: [{ id: 'machines', order: 95, advanced: true }],
  settings: {
    [DOWNLOAD]: bool({
      default: true,
      scope: 'machine',
      section: 'machines',
      order: 10,
      flag: 'machine-download',
      usage:
        "whether a machine downloads its build (the TypeScript machine executable of the hub's release) from the release itself, checked by its digest; else, and when it cannot, the hub uploads it",
    }),
  },
});
