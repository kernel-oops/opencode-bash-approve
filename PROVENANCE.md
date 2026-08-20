# Provenance

This is an OpenCode-oriented maintained port of
[`mariusvniekerk/claude-bash-approve`](https://github.com/mariusvniekerk/claude-bash-approve).

- Clean upstream base: `a81006c2950d23c3d2c81e1faecd695865728d53`
- Upstream licence: MIT; the original `LICENSE` is retained verbatim.
- Port version source: `VERSION`
- Runtime source: `hooks/bash-approve/`
- Preserved upstream stock policy: `hooks/bash-approve/categories.yaml`
- Maintained deployment policy: `hooks/bash-approve/opencode-balanced.yaml`

Release artefacts are built only by `.github/workflows/release-artifact.yml`.
The workflow records the exact source commit, commit-derived UTC build date,
Go toolchain version, target and build flags in `BUILD-INFO.json`; it also
includes `LICENSE`, `NOTICE`, this file, `THIRD_PARTY_LICENSES.txt` and
`SHA256SUMS` in the archive. `THIRD_PARTY_LICENSES.txt` is deterministically
regenerated and checked against every external module linked for Linux/amd64
with CGO disabled. The archive timestamp is derived from the source commit,
and archive ownership and ordering are normalised.

The runtime never downloads dependencies or builds itself. Production
OpenCode integration invokes the prebuilt executable directly.

For deployment, verify the archive against its adjacent `.tar.gz.sha256`, then
run `sha256sum -c SHA256SUMS` inside the extracted archive. Record the selected
`opencode-balanced.yaml` checksum together with `BUILD-INFO.json`; its `commit`
identifies the maintained source and `upstream_commit` identifies the stock
policy baseline. Always pass the verified policy by its explicit absolute path.
