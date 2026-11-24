// Command xclient is the program of the end-to-end tests' program windows
// (e2e/tests/gui.spec.ts): on the display of $DISPLAY (with $XAUTHORITY) it
// shows a red window titled "e2e window" and prints what it receives, one
// line each: mapped, button <n> <x> <y>, key <keycode>, delete.
package main

import (
	"fmt"
	"os"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
)

func main() {
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
	xproto.CreateWindow(x, scr.RootDepth, win, scr.Root, 0, 0, 320, 200, 0, xproto.WindowClassInputOutput, scr.RootVisual,
		xproto.CwBackPixel|xproto.CwEventMask, []uint32{0xff0000, xproto.EventMaskButtonPress | xproto.EventMaskKeyPress | xproto.EventMaskStructureNotify})
	title := []byte("e2e window")
	xproto.ChangeProperty(x, xproto.PropModeReplace, win, atom("_NET_WM_NAME"), atom("UTF8_STRING"), 8, uint32(len(title)), title)
	del := atom("WM_DELETE_WINDOW")
	xproto.ChangeProperty(x, xproto.PropModeReplace, win, atom("WM_PROTOCOLS"), xproto.AtomAtom, 32, 1, u32(uint32(del)))
	xproto.MapWindow(x, win)
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
