// Command gen writes the JPEG vectors of the GUI helper's tests (jpeg.zig):
// what the Go agent's encoder (internal/jpegstrip) makes of the test
// pictures, which the helper's port must reproduce byte for byte.
//
//	go run ./scripts/gui-helper/src/testdata/gen.go
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"veldr/internal/jpegstrip"
)

// picture is jpeg.zig's testPicture.
func picture(w, h int) []byte {
	pix := make([]byte, w*h*4)
	for i := 0; i < w*h; i++ {
		x, y := uint32(i%w), uint32(i/w)
		pix[i*4] = byte(x*7 + y)
		pix[i*4+1] = byte(y * 3)
		pix[i*4+2] = byte((x ^ y) * 5)
	}
	return pix
}

func main() {
	dir := filepath.Join("scripts", "gui-helper", "src", "testdata")
	for _, c := range []struct{ w, h, parts int }{{37, 21, 1}, {100, 70, 3}, {64, 64, 8}} {
		b, err := jpegstrip.Encode(nil, picture(c.w, c.h), c.w*4, c.w, c.h, 85, c.parts)
		if err != nil {
			panic(err)
		}
		name := filepath.Join(dir, fmt.Sprintf("jpeg-%dx%d-%d.jpg", c.w, c.h, c.parts))
		if err := os.WriteFile(name, b, 0o644); err != nil {
			panic(err)
		}
	}
}
