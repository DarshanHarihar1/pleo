# Spike fixtures

Save evidence here when a **live** checklist item fails (not for synthetic-only tests).

## Naming

| Artifact | Pattern |
|---|---|
| ScanReport JSON | `<host>-<yyyymmdd>-scan.json` |
| Trimmed HTML | `<host>-<yyyymmdd>.html` |
| Notes / screenshot | same folder or note in `../README.md` |

## Failure mode tags

One-line tag in notes: `label-empty` | `writeback-revert` | `iframe-invisible` | `shadow-miss` | `widget-unsupported`

Strip large scripts from HTML snapshots; keep `label` / `for` / `aria-*` structure.

This folder may be empty until the first live failure.
