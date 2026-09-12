# CI workflow — needs one manual step to activate

`ci.yml` in this directory is the project's GitHub Actions workflow. It is
**not active** where it currently sits: GitHub only runs workflows from
`.github/workflows/`.

It lives here because GitHub refuses a push that creates or edits anything under
`.github/workflows/` unless the pushing token carries the `workflow` OAuth
scope, which the token used to author it did not have:

```
! [remote rejected] (refusing to allow an OAuth App to create or update
  workflow `.github/workflows/ci.yml` without `workflow` scope)
```

Keeping the file here means it is versioned and reviewable rather than sitting
on one machine, and activating it is a rename.

## To activate

Either grant the scope and move it:

```bash
gh auth refresh -s workflow          # opens a browser
git mv ci/ci.yml .github/workflows/ci.yml
git rm ci/README.md
git commit -m "ci: activate the workflow"
git push
```

…or create `.github/workflows/ci.yml` through the GitHub web UI and paste the
contents of `ci/ci.yml` into it. The web editor is not subject to the OAuth
scope restriction.

## What it runs

Typecheck, lint, and the full test suite, on push and PR to `main` and
`post-demo/expansion`.

The integration tests hit a real Postgres rather than a mock, so the job brings
one up as a service container named `medguard_test` — `tests/setup/globalSetup.ts`
refuses to run against a database whose name lacks "test", and that guard is
meant to hold in CI exactly as it does locally.

Two steps exist because of the fresh-clone gotchas documented in the README,
both of which would otherwise fail for reasons pointing nowhere near the cause:
npm 11 blocks install scripts, so the install is `npm ci --ignore-scripts`
followed by an explicit rebuild; and the Prisma client is gitignored generated
output, so it must be generated before anything imports it.

## Verified

The steps were dry-run in a clean clone against a fresh database — no
`node_modules`, no `src/generated`, empty Postgres — reproducing a runner's
starting conditions:

```
Install dependencies    411 packages, 21 binaries in .bin
Generate Prisma client  ok
Typecheck               exit 0
Lint                    clean
Test                    9 files, 108 passed
```

The migration chain applied all 4 migrations and created all 12 tables. What has
**not** been verified is GitHub actually running it — that cannot happen until
the file reaches `.github/workflows/`.
