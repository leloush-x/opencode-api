package config

import (
	"os"
	"path/filepath"
	"testing"
)

// writeConfig writes a minimal valid configuration that enables the anonymous
// lane, so Normalize accepts it without upstream keys.
func writeConfig(t *testing.T, extra string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	body := `{"server_keys":["local-key"],"anonymous":true` + extra + `}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadReadsKeysFromEnvironment(t *testing.T) {
	path := writeConfig(t, `,"zen_keys":["from-file"]`)
	t.Setenv("ZEN_KEYS", " key-a , key-b ,, ")
	t.Setenv("GO_KEYS", "go-key")
	t.Setenv("SERVER_KEYS", "local-key")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.ZenKeys) != 2 || cfg.ZenKeys[0] != "key-a" || cfg.ZenKeys[1] != "key-b" {
		t.Fatalf("zen keys = %q, want [key-a key-b]", cfg.ZenKeys)
	}
	if len(cfg.GoKeys) != 1 || cfg.GoKeys[0] != "go-key" {
		t.Fatalf("go keys = %q, want [go-key]", cfg.GoKeys)
	}
}

func TestLoadKeepsFileKeysWithoutEnvironment(t *testing.T) {
	path := writeConfig(t, `,"zen_keys":["from-file"]`)
	// t.Setenv would leave a value behind, so clear explicitly.
	t.Setenv("ZEN_KEYS", "")
	os.Unsetenv("ZEN_KEYS")
	os.Unsetenv("GO_KEYS")
	os.Unsetenv("SERVER_KEYS")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.ZenKeys) != 1 || cfg.ZenKeys[0] != "from-file" {
		t.Fatalf("zen keys = %q, want [from-file]", cfg.ZenKeys)
	}
}
