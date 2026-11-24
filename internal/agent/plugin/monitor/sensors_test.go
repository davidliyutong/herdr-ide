//go:build unix

package monitor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// writeTree writes files (path relative to root → content) under root.
func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for p, content := range files {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCollectSysfsSensorsHwmon(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		"class/hwmon/hwmon0/name":         "coretemp",
		"class/hwmon/hwmon0/temp1_input":  "52000",
		"class/hwmon/hwmon0/temp1_label":  "Package id 0",
		"class/hwmon/hwmon0/temp1_max":    "84000",
		"class/hwmon/hwmon0/temp1_crit":   "100000",
		"class/hwmon/hwmon0/temp10_input": "47500",
		"class/hwmon/hwmon0/temp10_label": "Core 10",
		"class/hwmon/hwmon0/temp2_input":  "49000",
		"class/hwmon/hwmon0/temp2_label":  "Core 2",
		// An unconnected input reports an error value: skipped.
		"class/hwmon/hwmon0/temp3_input": "-128000",
		// Unparsable: skipped.
		"class/hwmon/hwmon0/temp4_input": "N/A",
		"class/hwmon/hwmon1/name":        "nvme",
		"class/hwmon/hwmon1/temp1_input": "38800",
		"class/hwmon/hwmon2/name":        "nvme",
		"class/hwmon/hwmon2/temp1_input": "41000",
		"class/hwmon/hwmon3/name":        "nct6798",
		"class/hwmon/hwmon3/fan1_input":  "1180",
		"class/hwmon/hwmon3/fan1_label":  "CPU fan",
		"class/hwmon/hwmon3/fan1_min":    "300",
		"class/hwmon/hwmon3/fan1_max":    "2200",
		// A stopped fan stays: 0 RPM is information.
		"class/hwmon/hwmon3/fan2_input": "0",
		"class/hwmon/hwmon3/fan2_min":   "0",
		// Thermal zones are not read while hwmon has temperatures.
		"class/thermal/thermal_zone0/type": "acpitz",
		"class/thermal/thermal_zone0/temp": "27800",
	})
	s := collectSysfsSensors(root)
	if s == nil {
		t.Fatal("no sensors")
	}
	type tk struct {
		chip, label string
		c           float64
	}
	want := []tk{
		{"coretemp", "Core 2", 49},
		{"coretemp", "Core 10", 47.5},
		{"coretemp", "Package id 0", 52},
		{"nvme", "temp1", 38.8},
		{"nvme (hwmon2)", "temp1", 41},
	}
	if len(s.Temps) != len(want) {
		t.Fatalf("temps = %+v", s.Temps)
	}
	for i, w := range want {
		got := s.Temps[i]
		if got.Chip != w.chip || got.Label != w.label || got.TempC != w.c {
			t.Errorf("temps[%d] = %+v, want %+v", i, got, w)
		}
	}
	pkg := s.Temps[2]
	if pkg.HighC == nil || *pkg.HighC != 84 || pkg.CritC == nil || *pkg.CritC != 100 {
		t.Errorf("package thresholds = %v, %v", pkg.HighC, pkg.CritC)
	}
	if s.Temps[0].HighC != nil || s.Temps[0].CritC != nil {
		t.Errorf("core 2 has thresholds: %+v", s.Temps[0])
	}
	if len(s.Fans) != 2 {
		t.Fatalf("fans = %+v", s.Fans)
	}
	f := s.Fans[0]
	if f.Chip != "nct6798" || f.Label != "CPU fan" || f.RPM != 1180 || f.MinRPM == nil || *f.MinRPM != 300 || f.MaxRPM == nil || *f.MaxRPM != 2200 {
		t.Errorf("fans[0] = %+v", f)
	}
	if f := s.Fans[1]; f.Label != "fan2" || f.RPM != 0 || f.MinRPM != nil || f.MaxRPM != nil {
		t.Errorf("fans[1] = %+v", f)
	}
}

func TestCollectSysfsSensorsThermalFallback(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		// A chip with only fans: the zones still supply the temperatures.
		"class/hwmon/hwmon0/name":                       "pwmfan",
		"class/hwmon/hwmon0/fan1_input":                 "3400",
		"class/thermal/thermal_zone0/type":              "cpu-thermal",
		"class/thermal/thermal_zone0/temp":              "61234",
		"class/thermal/thermal_zone0/trip_point_0_type": "passive",
		"class/thermal/thermal_zone0/trip_point_0_temp": "80000",
		"class/thermal/thermal_zone0/trip_point_1_type": "hot",
		"class/thermal/thermal_zone0/trip_point_1_temp": "90000",
		"class/thermal/thermal_zone0/trip_point_2_type": "critical",
		"class/thermal/thermal_zone0/trip_point_2_temp": "105000",
		"class/thermal/thermal_zone1/type":              "gpu-thermal",
		"class/thermal/thermal_zone1/temp":              "55000",
		// No temperature: skipped.
		"class/thermal/thermal_zone2/type":   "broken",
		"class/thermal/cooling_device0/type": "Processor",
	})
	s := collectSysfsSensors(root)
	if s == nil || len(s.Temps) != 2 || len(s.Fans) != 1 {
		t.Fatalf("sensors = %+v", s)
	}
	cpu := s.Temps[0]
	if cpu.Chip != "thermal" || cpu.Label != "cpu-thermal" || cpu.TempC != 61.2 {
		t.Errorf("temps[0] = %+v", cpu)
	}
	if cpu.HighC == nil || *cpu.HighC != 80 || cpu.CritC == nil || *cpu.CritC != 105 {
		t.Errorf("trip points = %v, %v", cpu.HighC, cpu.CritC)
	}
	if s.Temps[1].Label != "gpu-thermal" {
		t.Errorf("temps[1] = %+v", s.Temps[1])
	}
}

func TestCollectSysfsSensorsEmptyAndBounded(t *testing.T) {
	if s := collectSysfsSensors(t.TempDir()); s != nil {
		t.Fatalf("empty tree gave %+v", s)
	}
	root := t.TempDir()
	files := map[string]string{"class/hwmon/hwmon0/name": "many"}
	for i := 1; i <= maxSensors+20; i++ {
		files["class/hwmon/hwmon0/temp"+strconv.Itoa(i)+"_input"] = "40000"
		files["class/hwmon/hwmon0/fan"+strconv.Itoa(i)+"_input"] = "1000"
	}
	writeTree(t, root, files)
	s := collectSysfsSensors(root)
	if s == nil || len(s.Temps) != maxSensors || len(s.Fans) != maxSensors {
		t.Fatalf("got %d temps, %d fans; want %d each", len(s.Temps), len(s.Fans), maxSensors)
	}
}

func TestSensorsWithinBudget(t *testing.T) {
	c := newCollector()
	release := make(chan struct{})
	start := time.Now()
	got := c.sensorsWithin(context.Background(), func() *Sensors {
		<-release
		return &Sensors{}
	})
	if got != nil || time.Since(start) > sensorsBudget+time.Second {
		t.Fatalf("hung scan returned %v after %v", got, time.Since(start))
	}
	// While the hung scan runs no new one starts.
	ran := false
	if s := c.sensorsWithin(context.Background(), func() *Sensors { ran = true; return nil }); s != nil || ran {
		t.Fatal("a second scan started while the first was hung")
	}
	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for c.sensorsBusy.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	want := &Sensors{Fans: []FanSensor{{Chip: "x", Label: "y", RPM: 1}}}
	if s := c.sensorsWithin(context.Background(), func() *Sensors { return want }); s != want {
		t.Fatalf("scan after release = %v", s)
	}
}

func TestParseDarwinBatteryTemp(t *testing.T) {
	raw := `+-o AppleSmartBattery  <class AppleSmartBattery, id 0x1000008e4, registered, matched, active, busy 0 (1 ms), retain 8>
    {
      "PostChargeWaitSeconds" = 120
      "BatteryData" = {"Temperature"=9999,"CycleCount"=12}
      "VirtualTemperature" = 3409
      "Temperature" = 3074
      "AdapterDetails" = {"Watts"=90,"Description"="pd charger"}
    }
`
	s := parseDarwinBatteryTemp(raw)
	if s == nil || len(s.Temps) != 1 || len(s.Fans) != 0 {
		t.Fatalf("sensors = %+v", s)
	}
	if got := s.Temps[0]; got.Chip != "battery" || got.Label != "Battery" || got.TempC != 30.7 || got.HighC != nil {
		t.Errorf("battery = %+v", got)
	}
	if s := parseDarwinBatteryTemp(""); s != nil {
		t.Errorf("no battery gave %+v", s)
	}
	// Absent sensors leave the field out of the JSON.
	b, _ := json.Marshal(Metrics{})
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, ok := m["sensors"]; ok {
		t.Errorf("empty metrics carry sensors: %s", b)
	}
}

func TestNaturalLess(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"Core 2", "Core 10", true},
		{"Core 10", "Core 2", false},
		{"temp1", "temp1", false},
		{"fan", "fan1", true},
		{"a07", "a7", false},
		{"acpitz", "coretemp", true},
	}
	for _, c := range cases {
		if got := naturalLess(c.a, c.b); got != c.want {
			t.Errorf("naturalLess(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
