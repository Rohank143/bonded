# Staged world-state seeds

World-state seeds still being validated, such as the number-gap seeds
([docs/NUMBER-GAPS.md](../../../docs/NUMBER-GAPS.md)). Only `arena world --staged` runs them, with
prices moving overnight. Ratings never read this folder: a seed moves to `../world-seeds/` with an
`ATTACK_LIBRARY_VERSION` bump once its validation runs earn it.
