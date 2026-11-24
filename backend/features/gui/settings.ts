// The settings of program windows (section "gui"): each can be set per
// remote machine, and a flag fixes it for every machine. gui.enabled is
// also the feature's switch, which the feature applies per machine itself.
import { GUIDisplay } from '#shared/proto/agentproto/index.ts';
import { bool, defineModule, enumOf } from '#kernel/config/settings/index.ts';

export const Key = {
  GUI: 'gui.enabled',
  Display: 'gui.display',
  GPU: 'gui.gpu',
  GPUPick: 'gui.gpuPick',
  Video: 'gui.video',
} as const;

/** OpenGL on machines with VirtualGL: programs started with vglrun, or
 * every program of new panes. */
export const GPUMode = { Vglrun: 'vglrun', All: 'all' } as const;

const section = 'gui';

export const settings = defineModule({
  sections: [{ id: section, order: 70, advanced: true }],
  settings: {
    [Key.GUI]: bool({
      default: true,
      scope: 'remote-machine',
      section,
      order: 10,
      flag: 'gui',
      usage:
        'show windows of programs on remote Linux machines: new panes get a virtual display (DISPLAY), Xvfb is fetched in user space when missing; true or false (on or off); also per machine in the UI',
    }),
    [Key.Display]: enumOf([GUIDisplay.Auto, GUIDisplay.Xvfb], {
      default: GUIDisplay.Auto,
      scope: 'remote-machine',
      section,
      order: 15,
      flag: 'gui-display',
      usage:
        'the virtual display: auto (Xwayland drawing with a GPU where the machine has one and an Xwayland, so that OpenGL and Vulkan programs render on the GPU; Xvfb elsewhere) or xvfb (always Xvfb); a display changes kind while no program uses it; also per machine in the UI',
    }),
    [Key.GPU]: enumOf([GPUMode.Vglrun, GPUMode.All], {
      default: GPUMode.Vglrun,
      scope: 'remote-machine',
      section,
      order: 20,
      flag: 'gui-gpu',
      usage:
        'OpenGL on machines with VirtualGL: vglrun (programs started with vglrun render on the GPU) or all (every program in new panes runs under VirtualGL); also per machine in the UI',
    }),
    [Key.GPUPick]: bool({
      default: false,
      scope: 'remote-machine',
      section,
      order: 25,
      flag: 'gui-gpu-pick',
      usage:
        "on machines with several NVIDIA GPUs, preload a library into the programs of new panes that leaves a program started with CUDA_VISIBLE_DEVICES only the GPUs it names (indices are rewritten to count among those), so that a Vulkan program can show its window from the chosen GPU instead of only from the driver's first one; true or false; also per machine in the UI",
    }),
    [Key.Video]: bool({
      default: true,
      scope: 'remote-machine',
      section,
      order: 30,
      flag: 'gui-video',
      usage:
        'send program windows that keep changing as video (H.264 on NVIDIA, Intel or AMD GPUs, else VP8 on the CPU) to browsers that decode it, encoded on the machine by the encoder the core brings; pictures otherwise (false: always pictures); also per machine in the UI',
    }),
  },
});
