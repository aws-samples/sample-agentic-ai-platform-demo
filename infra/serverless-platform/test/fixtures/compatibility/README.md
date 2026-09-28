# Retained-data compatibility fixtures

These frozen source modules are required by the invocation and execution-journal
rollback tests. The directory names identify the source revisions; no Git history
or network access is required to run the tests.

The files preserve the original readers, writers and their local dependencies
byte for byte. `manifest.json` records their SHA-256 checksums, checked whenever a
test loads a module. Do not replace them with the current implementation: that
would stop testing compatibility with retained data and earlier readers.

These files are test assets only and are not packaged into Lambda deployments.
