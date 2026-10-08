# Badgery runner picker

Routes a workflow's jobs to Badgery when it is healthy and has what they ask
for, and to your own fallback runners when it is not: Badgery down or
unreachable, no connected host offering the label, or a label Badgery does not
have. A busy but healthy Badgery keeps the job; this is a health check, not a
scheduler.

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
its own public origin. Fallback is off until it is turned on for the
repository in the dashboard; until then the picker always answers Badgery,
except when Badgery cannot be reached at all.

It fails open: if Badgery errors, refuses, or cannot be reached within two
seconds, the job goes to your fallback. Every output is one of the two labels
your workflow wrote; Badgery's answer is a verdict, never a label. The pick job
needs `id-token: write`, because the workflow's OIDC token is how Badgery knows
which repository is asking; nothing else is sent.

Tests: `node --test index.test.js`.

This repository is published from Badgery's own source; changes are made
there.
