//go:build unix

package agent

import "testing"

// The conversion's buffer is used again: a smaller window after a larger
// one gets exactly its own pixels, opaque.
func TestBGRXToRGBAUsesBuffersAgain(t *testing.T) {
	big := make([]byte, 8*8*4)
	for i := range big {
		big[i] = 0x55
	}
	rgbaBufs.Put(&bgrxToRGBA(big, 8, 8).Pix)
	img := bgrxToRGBA([]byte{1, 2, 3, 0, 4, 5, 6, 0}, 2, 1)
	if want := []byte{3, 2, 1, 0xff, 6, 5, 4, 0xff}; string(img.Pix) != string(want) || img.Stride != 8 || img.Bounds().Dx() != 2 {
		t.Fatalf("got %v stride %d", img.Pix, img.Stride)
	}
}
