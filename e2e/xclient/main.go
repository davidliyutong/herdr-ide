// Command xclient is the program of the end-to-end tests' program windows
// (e2e/tests/gui.spec.ts): on the display of $DISPLAY (with $XAUTHORITY) it
// shows a red window titled "e2e window" and prints what it receives, one
// line each: mapped, button <n> <x> <y>, key <keycode>, delete. With -anim
// it is 640×360 and repaints itself in another color 60 times a second (a
// window that keeps changing, sent as video).
package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
)

func main() {
	anim := flag.Bool("anim", false, "repaint 60 times a second")
	flag.Parse()
	x, err := xgb.NewConn()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	scr := xproto.Setup(x).DefaultScreen(x)
	atom := func(name string) xproto.Atom {
		r, err := xproto.InternAtom(x, false, uint16(len(name)), name).Reply()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return r.Atom
	}
	win, _ := xproto.NewWindowId(x)
	w, h := uint16(320), uint16(200)
	if *anim {
		w, h = 640, 360
	}
	xproto.CreateWindow(x, scr.RootDepth, win, scr.Root, 0, 0, w, h, 0, xproto.WindowClassInputOutput, scr.RootVisual,
		xproto.CwBackPixel|xproto.CwEventMask, []uint32{0xff0000, xproto.EventMaskButtonPress | xproto.EventMaskKeyPress | xproto.EventMaskStructureNotify})
	title := []byte("e2e window")
	xproto.ChangeProperty(x, xproto.PropModeReplace, win, atom("_NET_WM_NAME"), atom("UTF8_STRING"), 8, uint32(len(title)), title)
	del := atom("WM_DELETE_WINDOW")
	xproto.ChangeProperty(x, xproto.PropModeReplace, win, atom("WM_PROTOCOLS"), xproto.AtomAtom, 32, 1, u32(uint32(del)))
	xproto.MapWindow(x, win)
	if *anim {
		gc, _ := xproto.NewGcontextId(x)
		xproto.CreateGC(x, gc, xproto.Drawable(win), 0, nil)
		go func() {
			for i := uint32(0); ; i++ {
				// A gradient of bands that moves: every frame changes all of it.
				for b := uint16(0); b < 16; b++ {
					xproto.ChangeGC(x, gc, xproto.GcForeground, []uint32{(i*8+uint32(b)*16)%256<<16 | (uint32(b)*16)<<8 | (255 - i*4%256)})
					xproto.PolyFillRectangle(x, xproto.Drawable(win), gc, []xproto.Rectangle{{X: int16(b * w / 16), Y: 0, Width: w / 16, Height: h}})
				}
				x.Sync()
				time.Sleep(16 * time.Millisecond)
			}
		}()
	}
	for {
		ev, err := x.WaitForEvent()
		switch e := ev.(type) {
		case nil:
			if err == nil {
				return
			}
		case xproto.MapNotifyEvent:
			fmt.Println("mapped")
		case xproto.ButtonPressEvent:
			fmt.Printf("button %d %d %d\n", e.Detail, e.EventX, e.EventY)
		case xproto.KeyPressEvent:
			fmt.Printf("key %d\n", e.Detail)
		case xproto.ClientMessageEvent:
			if xproto.Atom(e.Data.Data32[0]) == del {
				fmt.Println("delete")
				return
			}
		}
	}
}

func u32(v uint32) []byte { return []byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)} }
