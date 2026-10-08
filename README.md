# Badgery runner picker

Routes a workflow's jobs to Badgery when it is healthy and has what they ask
for, and to your own fallback runners when it is not: Badgery down or
unreachable, or a label no Badgery machine offers at all. When machines offer
the label but none is ready (one restarting, say), the picker waits out the
repository's grace period first. A busy but healthy Badgery keeps the job;
this is a health check, not a scheduler.

```yaml
jobs:
  pick:
    runs-on: ubuntu-latest          # your cheapest runner that isn't Badgery
    timeout-minutes: 35
    permissions:
      id-token: write
    outputs:
      runner: ${{ steps.p.outputs.runner }}
    steps:
      - id: p
        uses: badgery/runner@v1
        with:
          want: badgery-macos
          fallback: macos-15
  build:
    needs: pick
    runs-on: ${{ needs.pick.outputs.runner }}
```

Several routes at once, one output per key:

```yaml
        with:
          routes: |
            linux: badgery-linux -> ubuntu-latest
            mac: badgery-macos -> macos-15
```

`server` defaults to `https://hooks.badgery.ai`; a self-hosted Badgery passes
its own public origin.

On Badgery's hosted service fallback is off until it is turned on for the
repository in the dashboard, and until then Badgery answers "Badgery" for
every route. A self-hosted Badgery has no dashboard to turn it on from, so the
picker being in the workflow is the opt-in there. Either way, when the picker
itself cannot get an answer — Badgery unreachable, an error, no OIDC token —
it chooses the fallback: that is the case it exists for.

It fails open: if Badgery errors, refuses, or cannot be reached within two
seconds, the job goes to your fallback. Every output is one of the two labels
your workflow wrote; Badgery's answer is a verdict, never a label. The pick job
needs `id-token: write`, because the workflow's OIDC token is how Badgery knows
which repository is asking; nothing else is sent.

Tests: `node --test index.test.js`.

This repository is published from Badgery's own source; changes are made
there.
