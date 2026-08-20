# Provenance

This is an OpenCode-oriented maintained port of
[`mariusvniekerk/claude-bash-approve`](https://github.com/mariusvniekerk/claude-bash-approve).

- Clean upstream base: `a81006c2950d23c3d2c81e1faecd695865728d53`
- Upstream licence: MIT; the original `LICENSE` is retained verbatim.
- Port version source: `VERSION`
- Runtime source: `hooks/bash-approve/`
- Configuration shipped with the binary: `hooks/bash-approve/categories.yaml`

Release artefacts are built only by `.github/workflows/release-artifact.yml`.
The workflow records the exact source commit, commit-derived UTC build date,
Go toolchain version, target and build flags in `BUILD-INFO.json`; it also
includes `LICENSE`, `NOTICE`, this file and `SHA256SUMS` in the archive. The
archive timestamp is derived from the source commit, and archive ownership and
ordering are normalised.

The runtime never downloads dependencies or builds itself. Production
OpenCode integration invokes the prebuilt executable directly.
