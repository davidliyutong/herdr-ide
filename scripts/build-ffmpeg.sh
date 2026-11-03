#!/usr/bin/env bash
# Builds the encoder that machines use to send program windows as video
# (--gui-video): scripts/encoder/encoder.c on a minimal LGPL ffmpeg that
# encodes H.264 through NVENC (the driver's libraries, loaded at run time)
# and VP8 through libvpx (BSD). Static except for glibc, built against
# glibc 2.28 (AlmaLinux 8) so that it runs on most Linux machines. Needs
# Docker; scripts/build.sh embeds the result when present. Sources are
# pinned by SHA-256; builds are kept in dist/ffmpeg/build-<platform>, so
# changing encoder.c only recompiles it. The ffmpeg program is kept next to
# it for measurements.
#
#   scripts/build-ffmpeg.sh        # dist/ffmpeg/linux-amd64/encoder.gz
set -euo pipefail
cd "$(dirname "$0")/.."

FFMPEG=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
# 12.2 headers: NVIDIA drivers 550.54 and newer.
NVHEADERS=n12.2.72.0
NVHEADERS_SHA256=dbeaec433d93b850714760282f1d0992b1254fc3b5a6cb7d76fc1340a1e47563
LIBVPX=v1.17.0
LIBVPX_SHA256=1020f184046187baa2985dbde38e0691f49c44088bca7a1842b0236c6081dc0a
PLATFORMS=${FFMPEG_PLATFORMS:-linux/amd64}

src=dist/ffmpeg/src
mkdir -p "$src"
fetch() { # url file sha256
  if [[ ! -f "$src/$2" ]]; then curl -sSfL -o "$src/$2.part" "$1" && mv "$src/$2.part" "$src/$2"; fi
  echo "$3  $src/$2" | shasum -a 256 -c - >/dev/null || { echo "$2: checksum mismatch" >&2; exit 1; }
}
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG.tar.xz" "ffmpeg-$FFMPEG.tar.xz" "$FFMPEG_SHA256"
fetch "https://github.com/FFmpeg/nv-codec-headers/archive/refs/tags/$NVHEADERS.tar.gz" "nv-codec-headers-$NVHEADERS.tar.gz" "$NVHEADERS_SHA256"
fetch "https://github.com/webmproject/libvpx/archive/refs/tags/$LIBVPX.tar.gz" "libvpx-$LIBVPX.tar.gz" "$LIBVPX_SHA256"

for p in $PLATFORMS; do
  plat=${p/\//-}
  out=dist/ffmpeg/$plat
  build=dist/ffmpeg/build-$plat
  mkdir -p "$out" "$build"
  docker run --rm --platform "$p" -v "$PWD/$src:/src:ro" -v "$PWD/scripts/encoder:/encoder:ro" \
    -v "$PWD/$build:/b" -v "$PWD/$out:/out" \
    -e FFMPEG="$FFMPEG" -e NVHEADERS="$NVHEADERS" -e LIBVPX="$LIBVPX" almalinux:8 bash -euo pipefail -c '
    dnf -y -q install dnf-plugins-core >/dev/null && dnf config-manager --set-enabled powertools
    dnf -y -q install gcc gcc-c++ make diffutils pkgconf-pkg-config xz perl nasm >/dev/null
    cd /b
    stamp=$FFMPEG-$NVHEADERS-$LIBVPX
    if [[ ! -f done-$stamp ]]; then
      rm -rf deps ff src && mkdir src && cd src
      tar xf /src/nv-codec-headers-$NVHEADERS.tar.gz && make -s -C nv-codec-headers-*/ PREFIX=/b/deps install
      tar xf /src/libvpx-$LIBVPX.tar.gz && cd libvpx-*/
      ./configure --prefix=/b/deps --enable-static --disable-shared --enable-pic --disable-examples --disable-tools \
        --disable-docs --disable-unit-tests --enable-vp8 --enable-vp9 --enable-realtime-only --as=nasm >/dev/null
      make -s -j"$(nproc)" install >/dev/null && cd ..
      tar xf /src/ffmpeg-$FFMPEG.tar.xz && cd ffmpeg-$FFMPEG
      PKG_CONFIG_PATH=/b/deps/lib/pkgconfig ./configure --prefix=/b/ff --pkg-config-flags=--static \
        --disable-everything --disable-autodetect --disable-doc --disable-network --disable-debug \
        --disable-ffplay --disable-ffprobe --enable-ffmpeg --enable-swscale \
        --enable-ffnvcodec --enable-cuda --enable-nvenc --enable-libvpx \
        --enable-protocol=pipe,file --enable-demuxer=rawvideo --enable-decoder=rawvideo \
        --enable-encoder=h264_nvenc,hevc_nvenc,av1_nvenc,libvpx_vp8,libvpx_vp9,rawvideo \
        --enable-muxer=h264,hevc,ivf,mp4,nut,rawvideo,null \
        --enable-bsf=h264_metadata,hevc_metadata,extract_extradata,h264_mp4toannexb,vp9_superframe \
        --enable-parser=h264,hevc,vp8,vp9 --enable-filter=scale,format,pad,null,copy \
        --extra-ldflags="-static-libgcc" >/dev/null
      make -s -j"$(nproc)" install >/dev/null
      cp COPYING.LGPLv2.1 /b/LICENSE.ffmpeg
      cd /b && touch done-$stamp
    fi
    gcc -O2 -Wall -I/b/ff/include /encoder/encoder.c -o /b/encoder -static-libgcc \
      $(PKG_CONFIG_PATH=/b/ff/lib/pkgconfig:/b/deps/lib/pkgconfig pkg-config --static --libs libavcodec libswscale libavutil) -ldl
    strip -o /out/encoder /b/encoder
    strip -o /out/ffmpeg /b/ff/bin/ffmpeg
    cp /b/LICENSE.ffmpeg /out/
    ldd /out/encoder
  '
  gzip -9 -n -c "$out/encoder" > "$out/encoder.gz"
  echo "    $p encoder $(du -h "$out/encoder" | cut -f1) ($(du -h "$out/encoder.gz" | cut -f1) gzip)"
done
