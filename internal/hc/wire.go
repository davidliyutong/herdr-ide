// Package hc speaks herdr-core's API (protocol generation 1): JSON-RPC 2.0
// over a connection that the hello switches to framed mode, where channel 0
// carries the calls and every attached terminal or event subscription has a
// channel of its own.
//
// A frame is [channel u32 LE][kind u8][length u32 LE][payload]. The core
// sends stream bytes only against credit: a channel starts with Window bytes
// and the receiver returns what it has passed on (Stream.Ack). Nothing limits
// what a viewer sends.
package hc

import (
	"encoding/binary"
	"fmt"
	"io"
)

// Generation is the protocol generation this package speaks.
const Generation = 1

const (
	headerLen = 9
	// MaxPayload is the largest payload of one frame.
	MaxPayload = 16 << 20
	// Window is the credit a stream starts with.
	Window = 256 << 10
	// maxHello bounds the reply to the hello, the one line read in plain mode.
	maxHello = 1 << 20
	// maxQueued bounds the bytes of one channel waiting in memory. A core
	// that honors credit never has more than Window outstanding; the rest is
	// room for the frames that carry no credit (resizes, the close).
	maxQueued = 2 * Window
)

// Frame kinds.
const (
	kindData           = 0
	kindCredit         = 1
	kindClose          = 2
	kindResize         = 3
	kindFocus          = 4
	kindFacts          = 5
	kindAutomaticInput = 6
)

// appendFrame appends one frame to b.
func appendFrame(b []byte, channel uint32, kind byte, payload []byte) []byte {
	b = binary.LittleEndian.AppendUint32(b, channel)
	b = append(b, kind)
	b = binary.LittleEndian.AppendUint32(b, uint32(len(payload)))
	return append(b, payload...)
}

// readFrame reads one frame. It returns io.EOF only when the connection ends
// between two frames.
func readFrame(r io.Reader) (channel uint32, kind byte, payload []byte, err error) {
	var h [headerLen]byte
	if _, err = io.ReadFull(r, h[:1]); err != nil {
		return 0, 0, nil, err
	}
	if _, err = io.ReadFull(r, h[1:]); err != nil {
		return 0, 0, nil, unexpected(err)
	}
	n := binary.LittleEndian.Uint32(h[5:])
	if n > MaxPayload {
		return 0, 0, nil, fmt.Errorf("hc: frame of %d bytes exceeds %d", n, MaxPayload)
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(r, payload); err != nil {
		return 0, 0, nil, unexpected(err)
	}
	return binary.LittleEndian.Uint32(h[:4]), h[4], payload, nil
}

func unexpected(err error) error {
	if err == io.EOF {
		return io.ErrUnexpectedEOF
	}
	return err
}
