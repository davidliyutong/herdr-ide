//go:build unix

package monitor

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// maxSensors bounds each of a sample's temperature and fan lists.
	maxSensors = 128
	// maxHwmonChips bounds the hwmon and thermal zone directories scanned.
	maxHwmonChips = 64
	// sensorsBudget bounds a sensor scan; a sample never waits longer for it.
	sensorsBudget = time.Second
	// Plausible temperatures in °C: outside this range a reading is an
	// unconnected input or an error value (-128, 255…), not a temperature.
	minPlausibleC = -50
	maxPlausibleC = 200
)

// sensorsWithin runs scan in its own goroutine and returns its result, or
// nil when it does not finish within sensorsBudget (a hung sysfs read) or ctx
// ends first. While a scan that overran is still running no new one starts,
// so a stuck file costs one goroutine, not one per sample.
func (c *Collector) sensorsWithin(ctx context.Context, scan func() *Sensors) *Sensors {
	if !c.sensorsBusy.CompareAndSwap(false, true) {
		return nil
	}
	done := make(chan *Sensors, 1)
	go func() {
		defer c.sensorsBusy.Store(false)
		done <- scan()
	}()
	timer := time.NewTimer(sensorsBudget)
	defer timer.Stop()
	select {
	case s := <-done:
		return s
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return nil
	}
}

// collectSysfsSensors reads temperatures and fan speeds from the hwmon class
// under sysRoot (normally /sys): hwmon*/name names the chip, tempN_input
// (millidegrees Celsius) with tempN_label, tempN_max and tempN_crit, and
// fanN_input (RPM) with fanN_label, fanN_min and fanN_max. When hwmon has no
// temperature it falls back to the thermal zones (thermal_zone*/type and
// temp, with their hot and critical trip points). Unreadable or implausible
// values are skipped. It returns nil when there is nothing to show.
func collectSysfsSensors(sysRoot string) *Sensors {
	var s Sensors
	hwmonRoot := filepath.Join(sysRoot, "class", "hwmon")
	dirs := sortedDirs(hwmonRoot, "hwmon")
	seen := map[string]int{}
	for _, d := range dirs {
		dir := filepath.Join(hwmonRoot, d)
		chip := readTrim(filepath.Join(dir, "name"))
		if chip == "" {
			chip = d
		}
		// Two chips of one driver (two NVMe drives) keep apart by their
		// directory.
		seen[chip]++
		if seen[chip] > 1 {
			chip += " (" + d + ")"
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		var temps, fans []int
		for _, e := range ents {
			if n, ok := sensorIndex(e.Name(), "temp"); ok {
				temps = append(temps, n)
			} else if n, ok := sensorIndex(e.Name(), "fan"); ok {
				fans = append(fans, n)
			}
		}
		sort.Ints(temps)
		sort.Ints(fans)
		for _, n := range temps {
			if len(s.Temps) >= maxSensors {
				break
			}
			p := filepath.Join(dir, "temp"+strconv.Itoa(n))
			c, ok := readMilliC(p + "_input")
			if !ok {
				continue
			}
			t := TempSensor{Chip: chip, Label: readTrim(p + "_label"), TempC: c}
			if t.Label == "" {
				t.Label = "temp" + strconv.Itoa(n)
			}
			if v, ok := readMilliC(p + "_max"); ok && v > 0 && v <= maxPlausibleC {
				t.HighC = floatPtr(v)
			}
			if v, ok := readMilliC(p + "_crit"); ok && v > 0 && v <= maxPlausibleC {
				t.CritC = floatPtr(v)
			}
			s.Temps = append(s.Temps, t)
		}
		for _, n := range fans {
			if len(s.Fans) >= maxSensors {
				break
			}
			p := filepath.Join(dir, "fan"+strconv.Itoa(n))
			rpm, ok := readNum(p + "_input")
			if !ok || rpm < 0 {
				continue
			}
			f := FanSensor{Chip: chip, Label: readTrim(p + "_label"), RPM: rpm}
			if f.Label == "" {
				f.Label = "fan" + strconv.Itoa(n)
			}
			if v, ok := readNum(p + "_min"); ok && v > 0 {
				f.MinRPM = floatPtr(v)
			}
			if v, ok := readNum(p + "_max"); ok && v > 0 {
				f.MaxRPM = floatPtr(v)
			}
			s.Fans = append(s.Fans, f)
		}
	}
	if len(s.Temps) == 0 {
		s.Temps = thermalZones(filepath.Join(sysRoot, "class", "thermal"))
	}
	return finishSensors(s)
}

// thermalZones reads the thermal class's zones: type names the sensor, temp
// is in millidegrees Celsius, and the trip points of type hot (or passive,
// whichever is lowest) and critical become its thresholds.
func thermalZones(root string) []TempSensor {
	var out []TempSensor
	for _, d := range sortedDirs(root, "thermal_zone") {
		if len(out) >= maxSensors {
			break
		}
		dir := filepath.Join(root, d)
		c, ok := readMilliC(filepath.Join(dir, "temp"))
		if !ok {
			continue
		}
		t := TempSensor{Chip: "thermal", Label: readTrim(filepath.Join(dir, "type")), TempC: c}
		if t.Label == "" {
			t.Label = d
		}
		for i := 0; i < 16; i++ {
			p := filepath.Join(dir, "trip_point_"+strconv.Itoa(i))
			kind := readTrim(p + "_type")
			if kind == "" {
				break
			}
			v, ok := readMilliC(p + "_temp")
			if !ok || v <= 0 || v > maxPlausibleC {
				continue
			}
			switch kind {
			case "critical":
				if t.CritC == nil || v < *t.CritC {
					t.CritC = floatPtr(v)
				}
			case "hot", "passive":
				if t.HighC == nil || v < *t.HighC {
					t.HighC = floatPtr(v)
				}
			}
		}
		out = append(out, t)
	}
	return out
}

// parseDarwinBatteryTemp reads the battery's temperature from
// `ioreg -rn AppleSmartBattery -w0`, whose "Temperature" key is in
// hundredths of a degree Celsius. It is the one temperature macOS exposes
// without root or the SMC and IOHID interfaces, which need cgo.
func parseDarwinBatteryTemp(raw string) *Sensors {
	for _, line := range strings.Split(raw, "\n") {
		rest, ok := strings.CutPrefix(strings.TrimSpace(line), `"Temperature" = `)
		if !ok {
			continue
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(rest), 64)
		if err != nil {
			return nil
		}
		return finishSensors(Sensors{Temps: []TempSensor{{Chip: "battery", Label: "Battery", TempC: round1(v / 100)}}})
	}
	return nil
}

// finishSensors drops implausible temperatures, sorts both lists by chip,
// then label (numbers inside compared as numbers), and returns nil when
// nothing is left.
func finishSensors(s Sensors) *Sensors {
	temps := s.Temps[:0]
	for _, t := range s.Temps {
		if t.TempC >= minPlausibleC && t.TempC <= maxPlausibleC {
			temps = append(temps, t)
		}
	}
	s.Temps = temps
	if len(s.Temps) == 0 {
		s.Temps = nil
	}
	if len(s.Temps) == 0 && len(s.Fans) == 0 {
		return nil
	}
	sort.SliceStable(s.Temps, func(i, j int) bool {
		return sensorLess(s.Temps[i].Chip, s.Temps[i].Label, s.Temps[j].Chip, s.Temps[j].Label)
	})
	sort.SliceStable(s.Fans, func(i, j int) bool {
		return sensorLess(s.Fans[i].Chip, s.Fans[i].Label, s.Fans[j].Chip, s.Fans[j].Label)
	})
	return &s
}

func sensorLess(chipA, labelA, chipB, labelB string) bool {
	if chipA != chipB {
		return naturalLess(chipA, chipB)
	}
	return naturalLess(labelA, labelB)
}

// naturalLess orders strings with runs of digits compared by value, so
// "Core 2" sorts before "Core 10".
func naturalLess(a, b string) bool {
	for a != "" && b != "" {
		da, db := digitRun(a), digitRun(b)
		if da > 0 && db > 0 {
			na, nb := strings.TrimLeft(a[:da], "0"), strings.TrimLeft(b[:db], "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			a, b = a[da:], b[db:]
			continue
		}
		if a[0] != b[0] {
			return a[0] < b[0]
		}
		a, b = a[1:], b[1:]
	}
	return len(a) < len(b)
}

func digitRun(s string) int {
	n := 0
	for n < len(s) && s[n] >= '0' && s[n] <= '9' {
		n++
	}
	return n
}

// sortedDirs lists root's entries named prefix<N>, in order of N, at most
// maxHwmonChips of them.
func sortedDirs(root, prefix string) []string {
	ents, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	type dir struct {
		name string
		n    int
	}
	var ds []dir
	for _, e := range ents {
		rest, ok := strings.CutPrefix(e.Name(), prefix)
		if !ok {
			continue
		}
		if n, err := strconv.Atoi(rest); err == nil && n >= 0 {
			ds = append(ds, dir{e.Name(), n})
		}
	}
	sort.Slice(ds, func(i, j int) bool { return ds[i].n < ds[j].n })
	if len(ds) > maxHwmonChips {
		ds = ds[:maxHwmonChips]
	}
	out := make([]string, len(ds))
	for i, d := range ds {
		out[i] = d.name
	}
	return out
}

// sensorIndex returns N for a file named <kind>N_input.
func sensorIndex(name, kind string) (int, bool) {
	rest, ok := strings.CutPrefix(name, kind)
	if !ok {
		return 0, false
	}
	num, ok := strings.CutSuffix(rest, "_input")
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(num)
	return n, err == nil && n >= 0
}

func readTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return truncateStr(strings.TrimSpace(string(b)), 64)
}

func readNum(path string) (float64, bool) {
	s := readTrim(path)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil && !math.IsNaN(v) && !math.IsInf(v, 0)
}

func readMilliC(path string) (float64, bool) {
	v, ok := readNum(path)
	if !ok {
		return 0, false
	}
	return round1(v / 1000), true
}
