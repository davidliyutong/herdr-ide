# herdr's agent detection rules

`internal/agent/detect/manifests/*.toml` are the agent detection manifests
of [herdr](https://github.com/herdrdev/herdr) v0.9.5 (`src/detect/manifests/`
at tag `v0.9.5`, commit 2ecf19a), copied unchanged. They are licensed under
the Apache License 2.0, [LICENSE](LICENSE); herdr's repository has no
NOTICE file. The agent built from this project embeds them, and
`internal/agent/detect` evaluates them the way herdr's `src/detect` does
(regions, gates, priorities); that code is this project's (MIT).
