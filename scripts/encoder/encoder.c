// encoder turns raw frames of a program window into a video stream, for the
// agent (internal/agent/guivideo.go). It is built with the ffmpeg libraries
// by scripts/build-ffmpeg.sh and pushed to machines by the core.
//
//   encoder -w W -h H -kinds avc1,vp8 [-quality Q]
//
// It opens the first encoder that works for the kinds, in order (avc1:
// h264_nvenc, then h264_vaapi on the first render node that takes it; vp8:
// libvpx) and writes one line to stdout:
//
//   ok <encoder> <coded width> <coded height>
//
// or "error <message>" and exits. Then, for each frame read from stdin
// ([u32 flags][W*H*4 bytes BGRX], flags 1 = make a key frame), it writes
// the frame's packet to stdout: [u32 size][u32 flags][data], flags 1 = key
// frame. Numbers are little-endian. It ends at the end of stdin.

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>

// VA-API frames are uploaded from NV12 frames of this pool.
static AVBufferRef *hw_frames;

static int read_full(void *buf, size_t n) {
  uint8_t *p = buf;
  while (n > 0) {
    ssize_t r = read(0, p, n);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return -1;
    p += r;
    n -= (size_t)r;
  }
  return 0;
}

static int write_full(const void *buf, size_t n) {
  const uint8_t *p = buf;
  while (n > 0) {
    ssize_t r = write(1, p, n);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return -1;
    p += r;
    n -= (size_t)r;
  }
  return 0;
}

static void put32(uint8_t *b, uint32_t v) {
  b[0] = v;
  b[1] = v >> 8;
  b[2] = v >> 16;
  b[3] = v >> 24;
}

// open_encoder opens one encoder for a w×h window (coded size even), or
// returns NULL.
static AVCodecContext *open_encoder(const char *name, int w, int h, int quality) {
  const AVCodec *codec = avcodec_find_encoder_by_name(name);
  if (!codec) return NULL;
  AVCodecContext *c = avcodec_alloc_context3(codec);
  if (!c) return NULL;
  c->width = (w + 1) & ~1;
  c->height = (h + 1) & ~1;
  c->time_base = (AVRational){1, 60};
  c->framerate = (AVRational){60, 1};
  c->gop_size = 0x7fffffff; // key frames only when asked for
  c->max_b_frames = 0;
  if (!strcmp(name, "h264_nvenc")) {
    c->pix_fmt = AV_PIX_FMT_BGR0; // converted on the GPU
    c->profile = AV_PROFILE_H264_HIGH;
    av_opt_set(c->priv_data, "preset", "p2", 0);
    av_opt_set(c->priv_data, "tune", "ull", 0);
    av_opt_set(c->priv_data, "rc", "vbr", 0);
    av_opt_set_int(c->priv_data, "cq", quality, 0);
    av_opt_set_int(c->priv_data, "zerolatency", 1, 0);
    av_opt_set_int(c->priv_data, "delay", 0, 0);
    av_opt_set_int(c->priv_data, "forced-idr", 1, 0);
    c->bit_rate = 0;
    c->rc_max_rate = 40000000;
    c->rc_buffer_size = 4000000;
  } else if (!strcmp(name, "h264_vaapi")) {
    c->pix_fmt = AV_PIX_FMT_VAAPI;
    c->hw_frames_ctx = av_buffer_ref(hw_frames);
    av_opt_set(c->priv_data, "rc_mode", "CQP", 0);
    av_opt_set_int(c->priv_data, "qp", quality, 0);
    // One frame in the GPU at a time: each frame's packet comes back
    // before the next frame is read.
    av_opt_set_int(c->priv_data, "async_depth", 1, 0);
  } else if (!strcmp(name, "libvpx")) {
    c->pix_fmt = AV_PIX_FMT_YUV420P;
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    c->thread_count = n > 8 ? 8 : (n < 1 ? 1 : (int)n);
    c->bit_rate = 8000000;
    c->rc_max_rate = 20000000;
    c->qmin = 4;
    c->qmax = 50;
    av_opt_set(c->priv_data, "deadline", "realtime", 0);
    av_opt_set_int(c->priv_data, "cpu-used", 16, 0);
    av_opt_set_int(c->priv_data, "lag-in-frames", 0, 0);
    av_opt_set_int(c->priv_data, "crf", quality, 0);
    av_opt_set_int(c->priv_data, "error-resilient", 1, 0);
  } else {
    avcodec_free_context(&c);
    return NULL;
  }
  if (avcodec_open2(c, codec, NULL) < 0) {
    avcodec_free_context(&c);
    return NULL;
  }
  return c;
}

// open_vaapi opens h264_vaapi on the first render node whose driver can
// encode H.264.
static AVCodecContext *open_vaapi(int w, int h, int quality) {
  if (!avcodec_find_encoder_by_name("h264_vaapi")) return NULL;
  for (int n = 0; n < 8; n++) {
    char path[32];
    snprintf(path, sizeof path, "/dev/dri/renderD%d", 128 + n);
    if (access(path, R_OK | W_OK) != 0) continue;
    AVBufferRef *dev = NULL;
    if (av_hwdevice_ctx_create(&dev, AV_HWDEVICE_TYPE_VAAPI, path, NULL, 0) < 0) continue;
    hw_frames = av_hwframe_ctx_alloc(dev);
    av_buffer_unref(&dev);
    if (!hw_frames) continue;
    AVHWFramesContext *fc = (AVHWFramesContext *)hw_frames->data;
    fc->format = AV_PIX_FMT_VAAPI;
    fc->sw_format = AV_PIX_FMT_NV12;
    fc->width = (w + 1) & ~1;
    fc->height = (h + 1) & ~1;
    fc->initial_pool_size = 4;
    AVCodecContext *c = NULL;
    if (av_hwframe_ctx_init(hw_frames) == 0) c = open_encoder("h264_vaapi", w, h, quality);
    if (c) return c;
    av_buffer_unref(&hw_frames);
  }
  return NULL;
}

int main(int argc, char **argv) {
  int w = 0, h = 0, quality = 0;
  const char *kinds = "avc1";
  for (int i = 1; i + 1 < argc; i += 2) {
    if (!strcmp(argv[i], "-w")) w = atoi(argv[i + 1]);
    else if (!strcmp(argv[i], "-h")) h = atoi(argv[i + 1]);
    else if (!strcmp(argv[i], "-kinds")) kinds = argv[i + 1];
    else if (!strcmp(argv[i], "-quality")) quality = atoi(argv[i + 1]);
  }
  if (w < 16 || h < 16 || w > 8192 || h > 8192) {
    printf("error bad size %dx%d\n", w, h);
    return 2;
  }
  av_log_set_level(AV_LOG_ERROR);

  AVCodecContext *c = NULL;
  const char *name = NULL;
  char list[64];
  snprintf(list, sizeof list, "%s", kinds);
  for (char *k = strtok(list, ","); k && !c; k = strtok(NULL, ",")) {
    if (!strcmp(k, "avc1")) {
      int q = quality > 0 ? quality : 26;
      name = "h264_nvenc";
      c = open_encoder(name, w, h, q);
      if (!c) {
        name = "h264_vaapi";
        c = open_vaapi(w, h, q);
      }
    } else if (!strcmp(k, "vp8")) {
      name = "libvpx";
      c = open_encoder(name, w, h, quality > 0 ? quality : 10);
    }
  }
  if (!c) {
    printf("error no encoder for %s\n", kinds);
    return 1;
  }
  printf("ok %s %d %d\n", name, c->width, c->height);
  fflush(stdout);

  // f is what the encoder reads (or, for VA-API, what is uploaded).
  AVFrame *f = av_frame_alloc();
  f->format = hw_frames ? AV_PIX_FMT_NV12 : c->pix_fmt;
  f->width = c->width;
  f->height = c->height;
  if (av_frame_get_buffer(f, 0) < 0) return 1;
  struct SwsContext *sws = NULL;
  AVFrame *bgr = NULL;
  if (f->format != AV_PIX_FMT_BGR0) {
    bgr = av_frame_alloc();
    bgr->format = AV_PIX_FMT_BGR0;
    bgr->width = c->width;
    bgr->height = c->height;
    if (av_frame_get_buffer(bgr, 0) < 0) return 1;
    // Converted in slices on up to 8 threads (sws_scale_frame).
    sws = sws_alloc_context();
    if (!sws) return 1;
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    sws->threads = n > 8 ? 8 : (n < 1 ? 1 : (int)n);
    sws->flags = SWS_POINT;
  }
  AVFrame *in = bgr ? bgr : f;
  size_t size = (size_t)w * h * 4;
  uint8_t *buf = malloc(size);
  AVPacket *pkt = av_packet_alloc();
  AVFrame *hw = hw_frames ? av_frame_alloc() : NULL;
  if (!buf || !pkt || (hw_frames && !hw)) return 1;

  for (int64_t pts = 0;; pts++) {
    uint8_t hdr[8];
    if (read_full(hdr, 4) < 0 || read_full(buf, size) < 0) break;
    uint32_t flags = hdr[0] | hdr[1] << 8 | hdr[2] << 16 | (uint32_t)hdr[3] << 24;
    if (av_frame_make_writable(in) < 0) return 1;
    // Copy rows; padding repeats the last column and row.
    for (int y = 0; y < c->height; y++) {
      const uint8_t *src = buf + (size_t)(y < h ? y : h - 1) * w * 4;
      uint8_t *dst = in->data[0] + (size_t)y * in->linesize[0];
      memcpy(dst, src, (size_t)w * 4);
      if (c->width > w) memcpy(dst + (size_t)w * 4, src + (size_t)(w - 1) * 4, 4);
    }
    if (sws) {
      if (av_frame_make_writable(f) < 0) return 1;
      if (sws_scale_frame(sws, f, in) < 0) return 1;
    }
    f->pts = pts;
    if (flags & 1) {
      f->pict_type = AV_PICTURE_TYPE_I;
      f->flags |= AV_FRAME_FLAG_KEY;
    } else {
      f->pict_type = AV_PICTURE_TYPE_NONE;
      f->flags &= ~AV_FRAME_FLAG_KEY;
    }
    AVFrame *send = f;
    if (hw) {
      av_frame_unref(hw);
      if (av_hwframe_get_buffer(hw_frames, hw, 0) < 0 || av_hwframe_transfer_data(hw, f, 0) < 0) return 1;
      hw->pts = f->pts;
      hw->pict_type = f->pict_type;
      hw->flags = f->flags;
      send = hw;
    }
    if (avcodec_send_frame(c, send) < 0) return 1;
    for (;;) {
      int r = avcodec_receive_packet(c, pkt);
      if (r == AVERROR(EAGAIN)) break;
      if (r < 0) return 1;
      put32(hdr, (uint32_t)pkt->size);
      put32(hdr + 4, (pkt->flags & AV_PKT_FLAG_KEY) ? 1 : 0);
      if (write_full(hdr, 8) < 0 || write_full(pkt->data, (size_t)pkt->size) < 0) return 1;
      av_packet_unref(pkt);
    }
  }
  // Release the encoder (the GPU session) here: the CUDA driver's exit
  // handlers can hang a process that leaves it to them.
  avcodec_free_context(&c);
  fflush(stdout);
  _exit(0);
}
