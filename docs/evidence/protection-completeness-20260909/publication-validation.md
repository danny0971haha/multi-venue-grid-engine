# Publication validation

The first staged `git diff --cached --check` exited 2 because a verbatim failing unittest line ends in a space. The original diagnostic is retained losslessly as `corrective-regressions-before.stderr.gz`; its uncompressed bytes match the local raw diagnostic. No test result was rewritten. Native diagnostic compression is an evidence packaging change only.

Scoped Biome formatting exited 0. No dependency install or version change occurred. Final diff/secret checks and exact published-head Python rerun are recorded in the PR receipt.
