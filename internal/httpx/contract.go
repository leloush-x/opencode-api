package httpx

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// The free tier parses the client version out of the User-Agent and answers
// 426 below its floor, and that floor moves with every official release, so a
// pinned version silently rots. The version therefore comes from the official
// update service, with the baked constant in client.go as the fallback and as
// the floor: a resolved version older than the floor is discarded, because a
// stale User-Agent draws 426.
//
// Resolution never blocks a request. The cached version is returned at once and
// a refresh runs in the background once the cache has aged out.
const (
	cliUpdateURL      = "https://opencode.ai/update/api/latest/cli"
	cliVersionTTL     = 30 * time.Minute
	cliVersionTimeout = 10 * time.Second
)

var (
	cliVersion           atomic.Value // string
	cliVersionAt         atomic.Int64 // unix nanoseconds of the last refresh attempt
	cliVersionRefreshing atomic.Bool
)

// cliVersionNow returns the client version to claim and schedules a background
// refresh when the cached one has aged out.
func cliVersionNow() string {
	version, _ := cliVersion.Load().(string)
	if version == "" {
		version = v2ClientVersion
	}
	if time.Since(time.Unix(0, cliVersionAt.Load())) >= cliVersionTTL && cliVersionRefreshing.CompareAndSwap(false, true) {
		go refreshCLIVersion()
	}
	return version
}

// refreshCLIVersion asks the update service for the latest CLI release and
// adopts it when it is newer than the version in use.
func refreshCLIVersion() {
	defer cliVersionRefreshing.Store(false)
	ctx, cancel := context.WithTimeout(context.Background(), cliVersionTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cliUpdateURL, nil)
	if err != nil {
		cliVersionAt.Store(time.Now().UnixNano())
		return
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cliVersionAt.Store(time.Now().UnixNano())
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	// The stamp is written on every attempt, so a dead update service is not
	// hit again on every request.
	cliVersionAt.Store(time.Now().UnixNano())
	if err != nil || resp.StatusCode != http.StatusOK {
		return
	}
	resolved := parseCLIVersion(body)
	if resolved == "" {
		return
	}
	current, _ := cliVersion.Load().(string)
	if current == "" {
		current = v2ClientVersion
	}
	if compareCLIVersion(resolved, current) <= 0 {
		return
	}
	cliVersion.Store(resolved)
}

// cliVersionPayload is the update service's answer.
type cliVersionPayload struct {
	Artifacts []struct {
		Distribution string `json:"distribution"`
		Version      string `json:"version"`
		Active       *bool  `json:"active"`
	} `json:"artifacts"`
}

// parseCLIVersion picks the version of the npm artifact, or of the first
// active one, out of the update service's answer. An empty result means the
// answer carried no usable version.
func parseCLIVersion(body []byte) string {
	var payload cliVersionPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	for _, artifact := range payload.Artifacts {
		if artifact.Distribution == "npm" {
			if version := strings.TrimSpace(artifact.Version); version != "" {
				return version
			}
		}
	}
	for _, artifact := range payload.Artifacts {
		version := strings.TrimSpace(artifact.Version)
		if version == "" {
			continue
		}
		if artifact.Active == nil || *artifact.Active {
			return version
		}
	}
	for _, artifact := range payload.Artifacts {
		if version := strings.TrimSpace(artifact.Version); version != "" {
			return version
		}
	}
	return ""
}

// compareCLIVersion compares two "a.b.c" versions and reports -1, 0 or 1. A
// component that is not a number counts as 0, and a pre-release suffix is
// ignored, so "2.1.2-rc1" and "2.1.2" compare equal.
func compareCLIVersion(a, b string) int {
	left, right := cliVersionParts(a), cliVersionParts(b)
	for i := 0; i < 3; i++ {
		if left[i] == right[i] {
			continue
		}
		if left[i] < right[i] {
			return -1
		}
		return 1
	}
	return 0
}

// cliVersionParts splits a version into its three numeric components.
func cliVersionParts(version string) [3]int {
	var parts [3]int
	fields := strings.Split(strings.TrimSpace(version), "-")
	for i, field := range strings.Split(fields[0], ".") {
		if i > 2 {
			break
		}
		number, err := strconv.Atoi(field)
		if err != nil {
			number = 0
		}
		parts[i] = number
	}
	return parts
}
