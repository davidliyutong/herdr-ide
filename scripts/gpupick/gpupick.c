// gpupick: a library preloaded into the programs of a terminal (LD_PRELOAD)
// on a machine with several NVIDIA GPUs. A program started with
// CUDA_VISIBLE_DEVICES sees only the GPUs it names, as a container given
// those GPUs would: opening the device node of any other one fails.
//
// Why: NVIDIA's driver shows the windows of Vulkan programs on a virtual
// display only from the first GPU a program sees, so a program told to
// render on another one cannot create its swapchain. With the others out
// of sight the chosen GPU is the first.
//
// The terminal's environment says which GPUs there are:
//
//   GPUPICK_TABLE    "GPU-<uuid>=<minor>,..." in the order of nvidia-smi
//                    (PCI bus order), minor being the N of /dev/nvidiaN
//   GPUPICK_MIXED    set when the GPUs are of different models: CUDA then
//                    numbers them fastest first unless
//                    CUDA_DEVICE_ORDER=PCI_BUS_ID, so indices are only
//                    taken with that set
//   GPUPICK_DISPLAY  the minor of the GPU the display itself draws with,
//                    when it is an NVIDIA one
//
// What the first program of a tree works out is passed on:
//
//   GPUPICK_KEEP     the minors left visible; programs started with it
//                    keep that set whatever their CUDA_VISIBLE_DEVICES
//   CUDA_VISIBLE_DEVICES  its indices are rewritten to count among the
//                    visible GPUs (2 becomes 0 when only GPU 2 is left),
//                    which is how CUDA numbers them from then on; UUIDs
//                    stay
//   __GLX_VENDOR_LIBRARY_NAME=mesa  unless set, when the display's GPU is
//                    out of sight: NVIDIA's GLX cannot reach the display
//                    then, Mesa's draws through Vulkan on a visible GPU
//
// A CUDA_VISIBLE_DEVICES that names no GPU of the table, names one twice
// or is empty changes nothing.

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

#define MAX_GPUS 64

static int keep[MAX_GPUS]; // minors left visible
static int nkeep;          // 0: every GPU is visible
static int state;          // 0 not worked out, 1 being worked out, 2 done

static int kept(int minor) {
    for (int i = 0; i < nkeep; i++)
        if (keep[i] == minor) return 1;
    return 0;
}

// number reads a decimal number that ends the string or stops at end.
static int number(const char *s, const char *end, int *out) {
    if (s == end || !*s) return 0;
    long v = 0;
    for (; s != end && *s; s++) {
        if (*s < '0' || *s > '9' || v > 100000) return 0;
        v = v * 10 + (*s - '0');
    }
    *out = (int)v;
    return 1;
}

static void resolve(void) {
    const char *inherited = getenv("GPUPICK_KEEP");
    if (inherited && *inherited) {
        for (const char *p = inherited; *p && nkeep < MAX_GPUS;) {
            const char *e = strchr(p, ',');
            if (!e) e = p + strlen(p);
            int m;
            if (!number(p, e, &m)) { nkeep = 0; return; }
            keep[nkeep++] = m;
            p = *e ? e + 1 : e;
        }
        return;
    }
    const char *visible = getenv("CUDA_VISIBLE_DEVICES");
    const char *table = getenv("GPUPICK_TABLE");
    if (!visible || !*visible || !table || !*table) return;

    // The table: UUIDs (pointing into the variable) and minors.
    const char *uuid[MAX_GPUS];
    size_t uuidlen[MAX_GPUS];
    int minor[MAX_GPUS], n = 0;
    for (const char *p = table; *p && n < MAX_GPUS;) {
        const char *e = strchr(p, ',');
        if (!e) e = p + strlen(p);
        const char *eq = memchr(p, '=', (size_t)(e - p));
        if (!eq || !number(eq + 1, e, &minor[n])) return;
        uuid[n] = p;
        uuidlen[n] = (size_t)(eq - p);
        n++;
        p = *e ? e + 1 : e;
    }
    if (n < 2) return;
    const char *order = getenv("CUDA_DEVICE_ORDER");
    int indices = !getenv("GPUPICK_MIXED") || (order && !strcmp(order, "PCI_BUS_ID"));

    // The GPUs CUDA_VISIBLE_DEVICES names, in its order.
    int chosen[MAX_GPUS], isindex[MAX_GPUS], nchosen = 0;
    const char *entry[MAX_GPUS];
    size_t entrylen[MAX_GPUS];
    for (const char *p = visible; nchosen < MAX_GPUS;) {
        const char *e = strchr(p, ',');
        if (!e) e = p + strlen(p);
        const char *a = p, *b = e;
        while (a < b && (*a == ' ' || *a == '\t')) a++;
        while (b > a && (b[-1] == ' ' || b[-1] == '\t')) b--;
        int idx = -1, v;
        if (number(a, b, &v)) {
            if (!indices || v >= n) return;
            idx = v;
            isindex[nchosen] = 1;
        } else {
            // A UUID, or the start of one that only one GPU has.
            if (b - a < 5 || strncmp(a, "GPU-", 4)) return;
            for (int i = 0; i < n; i++) {
                if ((size_t)(b - a) <= uuidlen[i] && !strncmp(a, uuid[i], (size_t)(b - a))) {
                    if (idx >= 0) return;
                    idx = i;
                }
            }
            if (idx < 0) return;
            isindex[nchosen] = 0;
        }
        for (int i = 0; i < nchosen; i++)
            if (chosen[i] == idx) return;
        entry[nchosen] = a;
        entrylen[nchosen] = (size_t)(b - a);
        chosen[nchosen++] = idx;
        if (!*e) break;
        p = e + 1;
    }
    if (nchosen == 0 || nchosen == n) return; // nothing to hide

    // CUDA numbers the GPUs left in bus order: an index becomes the count
    // of chosen GPUs before it in the table.
    char rewritten[MAX_GPUS * 48], kept_list[MAX_GPUS * 8];
    size_t rl = 0, kl = 0;
    for (int i = 0; i < nchosen; i++) {
        int w;
        if (isindex[i]) {
            int rank = 0;
            for (int j = 0; j < nchosen; j++)
                if (chosen[j] < chosen[i]) rank++;
            w = snprintf(rewritten + rl, sizeof rewritten - rl, "%s%d", i ? "," : "", rank);
        } else {
            w = snprintf(rewritten + rl, sizeof rewritten - rl, "%s%.*s", i ? "," : "", (int)entrylen[i], entry[i]);
        }
        if (w < 0 || (size_t)w >= sizeof rewritten - rl) return;
        rl += (size_t)w;
        w = snprintf(kept_list + kl, sizeof kept_list - kl, "%s%d", i ? "," : "", minor[chosen[i]]);
        if (w < 0 || (size_t)w >= sizeof kept_list - kl) return;
        kl += (size_t)w;
    }
    for (int i = 0; i < nchosen; i++) keep[i] = minor[chosen[i]];
    nkeep = nchosen;
    setenv("GPUPICK_KEEP", kept_list, 1);
    setenv("CUDA_VISIBLE_DEVICES", rewritten, 1);
}

static void init(void) {
    int expected = 0;
    if (__atomic_compare_exchange_n(&state, &expected, 1, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) {
        resolve();
        const char *display = getenv("GPUPICK_DISPLAY");
        int m;
        if (nkeep > 0 && display && number(display, NULL, &m) && !kept(m))
            setenv("__GLX_VENDOR_LIBRARY_NAME", "mesa", 0);
        __atomic_store_n(&state, 2, __ATOMIC_SEQ_CST);
        return;
    }
    while (__atomic_load_n(&state, __ATOMIC_SEQ_CST) != 2) sched_yield();
}

__attribute__((constructor)) static void loaded(void) { init(); }

// hidden tells whether path is the device node of a GPU out of sight.
static int hidden(const char *path) {
    if (!path || strncmp(path, "/dev/nvidia", 11)) return 0;
    int m;
    if (!number(path + 11, NULL, &m)) return 0; // nvidiactl, nvidia-uvm, ...
    // A library loaded before this one may open a device first.
    if (__atomic_load_n(&state, __ATOMIC_SEQ_CST) != 2) init();
    return nkeep > 0 && !kept(m);
}

#define OPEN(name)                                                              \
    int name(const char *path, int flags, ...) {                                \
        static int (*next)(const char *, int, ...);                             \
        mode_t mode = 0;                                                        \
        if (flags & (O_CREAT | __O_TMPFILE)) {                                  \
            va_list ap;                                                         \
            va_start(ap, flags);                                                \
            mode = va_arg(ap, mode_t);                                          \
            va_end(ap);                                                         \
        }                                                                       \
        if (hidden(path)) {                                                     \
            errno = EPERM;                                                      \
            return -1;                                                          \
        }                                                                       \
        int (*fn)(const char *, int, ...) = __atomic_load_n(&next, __ATOMIC_ACQUIRE); \
        if (!fn) {                                                              \
            fn = dlsym(RTLD_NEXT, #name);                                       \
            if (!fn) {                                                          \
                errno = ENOSYS;                                                 \
                return -1;                                                      \
            }                                                                   \
            __atomic_store_n(&next, fn, __ATOMIC_RELEASE);                      \
        }                                                                       \
        return fn(path, flags, mode);                                           \
    }

#define OPENAT(name)                                                            \
    int name(int dir, const char *path, int flags, ...) {                       \
        static int (*next)(int, const char *, int, ...);                        \
        mode_t mode = 0;                                                        \
        if (flags & (O_CREAT | __O_TMPFILE)) {                                  \
            va_list ap;                                                         \
            va_start(ap, flags);                                                \
            mode = va_arg(ap, mode_t);                                          \
            va_end(ap);                                                         \
        }                                                                       \
        if (hidden(path)) {                                                     \
            errno = EPERM;                                                      \
            return -1;                                                          \
        }                                                                       \
        int (*fn)(int, const char *, int, ...) = __atomic_load_n(&next, __ATOMIC_ACQUIRE); \
        if (!fn) {                                                              \
            fn = dlsym(RTLD_NEXT, #name);                                       \
            if (!fn) {                                                          \
                errno = ENOSYS;                                                 \
                return -1;                                                      \
            }                                                                   \
            __atomic_store_n(&next, fn, __ATOMIC_RELEASE);                      \
        }                                                                       \
        return fn(dir, path, flags, mode);                                      \
    }

OPEN(open)
OPEN(open64)
OPENAT(openat)
OPENAT(openat64)

// The variants a program compiled with _FORTIFY_SOURCE calls.
int __open_2(const char *path, int flags) { return open(path, flags); }
int __open64_2(const char *path, int flags) { return open64(path, flags); }
int __openat_2(int dir, const char *path, int flags) { return openat(dir, path, flags); }
int __openat64_2(int dir, const char *path, int flags) { return openat64(dir, path, flags); }
