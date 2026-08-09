# Pleo

AI-assisted autofill for job applications — a Chrome MV3 extension. Local-first, bring-your-own API key, and it never submits anything for you.

Full design rationale, data model, and architecture: **[`Pleo-HLD.md`](Pleo-HLD.md)** (High-Level Design, source of truth).

## Repo layout

```
Pleo-HLD.md      # design source of truth
docs/            # implementation plan + per-phase build notes
extension/       # the shipped Chrome extension (build, load-unpacked, usage)
```

## Get started

See **[`extension/README.md`](extension/README.md)** for build steps, loading the unpacked extension, and first-run setup (profile vault + BYOK API key).

## Build history

`docs/implementation-plan.md` and `docs/phases/*` track how the extension was built phase by phase, from the extraction spike (§15 M0 in the HLD) through hardening and ship-to-self.
