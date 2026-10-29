package agent

import "webherdr/internal/brand"

// brandLegacy temporarily sets brand.LegacyDataDirNames.
func brandLegacy(names ...string) (restore func()) {
	old := brand.LegacyDataDirNames
	brand.LegacyDataDirNames = names
	return func() { brand.LegacyDataDirNames = old }
}
