package store

import "golang.org/x/sys/windows/registry"

// removeUnheld removes nothing on Windows, whose SQLite locks are not
// looked at here: another host's database stays.
func removeUnheld(p string, still func() bool) (bool, error) { return false, nil }

// machineID is the id Windows gives the installation (MachineGuid), ""
// when it cannot be read.
func machineID() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Cryptography`, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return ""
	}
	defer k.Close()
	id, _, err := k.GetStringValue("MachineGuid")
	if err != nil {
		return ""
	}
	return id
}
