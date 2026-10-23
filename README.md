# pi-tools
Set of extensions and themes for pi coding agent

## DCP setup

[pi-dcp](pi-dcp/README.md) supports model-specific exclusions through `disabledModels` in its extension configuration. Keep Pi's `compaction.enabled` set to `true`: DCP blocks normal threshold compaction only for models where DCP is enabled and healthy. Excluded models use Pi's normal compaction. Manual compaction and overflow recovery remain available for all models.

If you followed the older instruction to disable Pi compaction, enable it once in Pi settings and run `/reload`. See the [DCP installation instructions](pi-dcp/README.md#installation) and [model exclusion configuration](pi-dcp/README.md#disable-dcp-for-specific-models) for details.

## Pi dependency policy

Extensions use `"*"` for Pi-provided package dependencies so a Pi update does not require changing extension version ranges. Pi supplies these packages at runtime; do not bundle a separate runtime copy. Development dependencies also use `"*"` where local typechecking needs them.

Package lockfiles record exact development installs for repeatable checks, not a required Pi host version. To test against a newer Pi release, update the Pi packages in the affected extension with `npm update`, then run its checks. A wildcard does not guarantee API compatibility: keep capability checks and rerun tests after Pi updates. Historical version-adoption plans do not override this policy.
