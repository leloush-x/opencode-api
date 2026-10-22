package httpx

import "testing"

func TestParseCLIVersionPrefersNpm(t *testing.T) {
	body := []byte(`{"artifacts":[{"distribution":"aur","version":"2.1.1","active":true},{"distribution":"npm","version":"2.1.2","active":true}]}`)
	if got := parseCLIVersion(body); got != "2.1.2" {
		t.Fatalf("parseCLIVersion = %q, want 2.1.2", got)
	}
}

func TestParseCLIVersionFallsBackToActiveArtifact(t *testing.T) {
	body := []byte(`{"artifacts":[{"distribution":"aur","version":"2.1.1","active":false},{"distribution":"homebrew","version":"2.1.2"}]}`)
	if got := parseCLIVersion(body); got != "2.1.2" {
		t.Fatalf("parseCLIVersion = %q, want 2.1.2", got)
	}
}

func TestParseCLIVersionRejectsGarbage(t *testing.T) {
	for _, body := range [][]byte{[]byte("not json"), []byte(`{"artifacts":[]}`), []byte(`{"artifacts":[{"version":""}]}`)} {
		if got := parseCLIVersion(body); got != "" {
			t.Fatalf("parseCLIVersion = %q, want empty", got)
		}
	}
}

func TestCompareCLIVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"2.1.2", "2.1.1", 1},
		{"2.1.1", "2.1.2", -1},
		{"2.0.32", "2.1.2", -1},
		{"2.1.2", "2.1.2", 0},
		{"2.1.2-rc1", "2.1.2", 0},
		{"3.0.0", "2.9.9", 1},
	}
	for _, test := range cases {
		if got := compareCLIVersion(test.a, test.b); got != test.want {
			t.Fatalf("compareCLIVersion(%q, %q) = %d, want %d", test.a, test.b, got, test.want)
		}
	}
}
