# Video encoder

The core embeds a video encoder for Linux machines (`encoder-linux-amd64`,
`encoder-linux-arm64`), which it copies to a machine to send program windows
that keep changing as video. It is `scripts/encoder/encoder.c` (part of this
project, MIT) linked with:

| Component | Version | License | Source |
| --- | --- | --- | --- |
| FFmpeg (libavcodec, libavutil, libswscale), configured without GPL or nonfree parts | 9.0.2 | LGPL-2.1-or-later, [FFMPEG-LGPL-2.1.txt](FFMPEG-LGPL-2.1.txt) | https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz |
| libvpx | 1.17.0 | BSD-3-Clause and a patent grant, [LIBVPX-LICENSE.txt](LIBVPX-LICENSE.txt), [LIBVPX-PATENTS.txt](LIBVPX-PATENTS.txt) | https://github.com/webmproject/libvpx/archive/refs/tags/v1.17.0.tar.gz |
| libva | 2.24.1 | MIT, [LIBVA-LICENSE.txt](LIBVA-LICENSE.txt) | https://github.com/intel/libva/releases/download/2.24.1/libva-2.24.1.tar.bz2 |
| libdrm | 2.4.134 | MIT, [LIBDRM-LICENSE.txt](LIBDRM-LICENSE.txt) | https://dri.freedesktop.org/libdrm/libdrm-2.4.134.tar.xz |
| nv-codec-headers | 12.2.72.0 | MIT, [NV-CODEC-HEADERS-LICENSE.txt](NV-CODEC-HEADERS-LICENSE.txt) | https://github.com/FFmpeg/nv-codec-headers/archive/refs/tags/n12.2.72.0.tar.gz |

The libraries are linked statically. `scripts/build-ffmpeg.sh` in this
project's source code builds the encoder from these sources (pinned by
SHA-256) with the exact configuration used, so it can be rebuilt with a
modified FFmpeg. NVIDIA's and the GPU vendors' drivers are not included:
the encoder loads the machine's drivers when it runs.
