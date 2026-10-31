// Package endpoint is a client of herdr's client "endpoint" protocol,
// generation 1: the stable protocol herdr's own client-rendered shell speaks
// over herdr-client.sock. Messages are bincode 2 values (serde, standard
// configuration: little endian, variable-length integers) behind a u32
// little-endian length prefix.
//
// Only the parts herdr-ide uses are modelled; every server message is still
// decoded completely so that the stream stays aligned.
package endpoint

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"unicode/utf8"
)

var errShort = errors.New("endpoint: truncated message")

// reader decodes bincode values from one message payload.
type reader struct {
	b   []byte
	off int
}

func (r *reader) remaining() int { return len(r.b) - r.off }

func (r *reader) take(n int) ([]byte, error) {
	if n < 0 || n > r.remaining() {
		return nil, errShort
	}
	p := r.b[r.off : r.off+n]
	r.off += n
	return p, nil
}

func (r *reader) u8() (uint8, error) {
	p, err := r.take(1)
	if err != nil {
		return 0, err
	}
	return p[0], nil
}

func (r *reader) bool() (bool, error) {
	v, err := r.u8()
	if err != nil {
		return false, err
	}
	switch v {
	case 0:
		return false, nil
	case 1:
		return true, nil
	}
	return false, fmt.Errorf("endpoint: invalid bool %d", v)
}

// varint reads bincode's variable-length unsigned integer.
func (r *reader) varint() (uint64, error) {
	tag, err := r.u8()
	if err != nil {
		return 0, err
	}
	switch {
	case tag < 251:
		return uint64(tag), nil
	case tag == 251:
		p, err := r.take(2)
		if err != nil {
			return 0, err
		}
		return uint64(binary.LittleEndian.Uint16(p)), nil
	case tag == 252:
		p, err := r.take(4)
		if err != nil {
			return 0, err
		}
		return uint64(binary.LittleEndian.Uint32(p)), nil
	case tag == 253:
		p, err := r.take(8)
		if err != nil {
			return 0, err
		}
		return binary.LittleEndian.Uint64(p), nil
	}
	return 0, fmt.Errorf("endpoint: unsupported varint tag %d", tag)
}

func (r *reader) u16() (uint16, error) {
	v, err := r.varint()
	if err != nil {
		return 0, err
	}
	if v > math.MaxUint16 {
		return 0, fmt.Errorf("endpoint: u16 out of range: %d", v)
	}
	return uint16(v), nil
}

func (r *reader) u32() (uint32, error) {
	v, err := r.varint()
	if err != nil {
		return 0, err
	}
	if v > math.MaxUint32 {
		return 0, fmt.Errorf("endpoint: u32 out of range: %d", v)
	}
	return uint32(v), nil
}

func (r *reader) u64() (uint64, error) { return r.varint() }

func (r *reader) i32() (int32, error) {
	v, err := r.varint()
	if err != nil {
		return 0, err
	}
	if v > math.MaxUint32 {
		return 0, fmt.Errorf("endpoint: i32 out of range: %d", v)
	}
	u := uint32(v)
	return int32(u>>1) ^ -int32(u&1), nil
}

// length reads a sequence length. Every item takes at least minItem bytes, so
// a length the rest of the payload cannot hold is rejected before allocating.
func (r *reader) length(minItem int) (int, error) {
	v, err := r.varint()
	if err != nil {
		return 0, err
	}
	if minItem < 1 {
		minItem = 1
	}
	if v > uint64(r.remaining()/minItem) {
		return 0, errShort
	}
	return int(v), nil
}

func (r *reader) bytes() ([]byte, error) {
	n, err := r.length(1)
	if err != nil {
		return nil, err
	}
	p, err := r.take(n)
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), p...), nil
}

func (r *reader) string() (string, error) {
	n, err := r.length(1)
	if err != nil {
		return "", err
	}
	p, err := r.take(n)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(p) {
		return "", errors.New("endpoint: invalid UTF-8 string")
	}
	return string(p), nil
}

// option reads the 0/1 tag of an Option.
func (r *reader) option() (bool, error) {
	v, err := r.u8()
	if err != nil {
		return false, err
	}
	switch v {
	case 0:
		return false, nil
	case 1:
		return true, nil
	}
	return false, fmt.Errorf("endpoint: invalid option tag %d", v)
}

func (r *reader) optString() (*string, error) {
	ok, err := r.option()
	if err != nil || !ok {
		return nil, err
	}
	s, err := r.string()
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (r *reader) optU32() (*uint32, error) {
	ok, err := r.option()
	if err != nil || !ok {
		return nil, err
	}
	v, err := r.u32()
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// variant reads an enum variant index.
func (r *reader) variant() (uint32, error) { return r.u32() }

// writer encodes bincode values.
type writer struct{ b []byte }

func (w *writer) u8(v uint8) { w.b = append(w.b, v) }

func (w *writer) bool(v bool) {
	if v {
		w.u8(1)
	} else {
		w.u8(0)
	}
}

func (w *writer) varint(v uint64) {
	switch {
	case v < 251:
		w.b = append(w.b, byte(v))
	case v <= math.MaxUint16:
		w.b = append(w.b, 251)
		w.b = binary.LittleEndian.AppendUint16(w.b, uint16(v))
	case v <= math.MaxUint32:
		w.b = append(w.b, 252)
		w.b = binary.LittleEndian.AppendUint32(w.b, uint32(v))
	default:
		w.b = append(w.b, 253)
		w.b = binary.LittleEndian.AppendUint64(w.b, v)
	}
}

func (w *writer) u16(v uint16) { w.varint(uint64(v)) }
func (w *writer) u32(v uint32) { w.varint(uint64(v)) }

func (w *writer) string(s string) {
	w.varint(uint64(len(s)))
	w.b = append(w.b, s...)
}

// char writes a Rust char: its UTF-8 bytes.
func (w *writer) char(c rune) { w.b = utf8.AppendRune(w.b, c) }

func (w *writer) optString(s *string) {
	if s == nil {
		w.u8(0)
		return
	}
	w.u8(1)
	w.string(*s)
}

func (w *writer) optU32(v *uint32) {
	if v == nil {
		w.u8(0)
		return
	}
	w.u8(1)
	w.u32(*v)
}

func (w *writer) variant(i uint32) { w.u32(i) }
