package main

import (
	"encoding/json"
	"fmt"
	"runtime"
)

const (
	binaryName              = "approve-bash"
	openCodeProtocol        = "opencode-bash-approve"
	openCodeProtocolVersion = 1
)

// These values are intentionally variables so release builds can set exact
// identity data with -ldflags -X. Development builds remain unambiguous.
var (
	buildVersion = "dev"
	buildCommit  = "unknown"
	buildDate    = "unknown"
)

type buildIdentity struct {
	Name            string `json:"name"`
	Version         string `json:"version"`
	Commit          string `json:"commit"`
	BuildDate       string `json:"build_date"`
	GoVersion       string `json:"go_version"`
	Protocol        string `json:"protocol"`
	ProtocolVersion int    `json:"protocol_version"`
}

func currentBuildIdentity() buildIdentity {
	return buildIdentity{
		Name:            binaryName,
		Version:         buildVersion,
		Commit:          buildCommit,
		BuildDate:       buildDate,
		GoVersion:       runtime.Version(),
		Protocol:        openCodeProtocol,
		ProtocolVersion: openCodeProtocolVersion,
	}
}

func humanVersion() string {
	id := currentBuildIdentity()
	return fmt.Sprintf(
		"%s %s (commit %s, built %s, %s; %s/%d)",
		id.Name,
		id.Version,
		id.Commit,
		id.BuildDate,
		id.GoVersion,
		id.Protocol,
		id.ProtocolVersion,
	)
}

func machineVersion() ([]byte, error) {
	return json.Marshal(currentBuildIdentity())
}
