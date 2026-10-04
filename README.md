# LN Browser manual build controller

This public repository contains **only build orchestration**, not the Donut
application source. Source lives in the private repository
[`nguyenducluongg/donut`](https://github.com/nguyenducluongg/donut).

Nothing builds on push, pull request, tag, schedule, or repository dispatch.
Only the repository owner can manually run the workflow from `main`. One
standard GitHub-hosted runner builds one platform per run. No local build or
self-hosted Mac runner is used.

## One-time setup (no build is triggered)

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
   owned by `nguyenducluongg`, with an expiry, selecting **only `donut`**.
   Grant repository **Contents: Read and write** (Metadata read is automatic).
   Write access is needed to store results in private Releases, not to publish
   source in this public repository. Do not use a broad/classic token.
2. In this repo, open **Settings → Environments → New environment** and name it
   exactly **`private-source-build`**. Restrict deployment branches to `main`.
   Optionally require review by the owner before secrets are released.
3. Add an **environment secret** named **`DONUT_SOURCE_TOKEN`**, containing the
   token from step 1. Never put the token in a file, commit, workflow input, or chat.

[GitHub token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
and [environment documentation](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Click to build manually

1. Open [Actions → Build Donut manually](https://github.com/nguyenducluongg/lnbrowserbuild/actions/workflows/manual-build.yml).
2. Click **Run workflow**. Keep the workflow branch **`main`**.
3. Set `source_ref` to `main` (latest private source) or a full source commit SHA
   (recommended for a reproducible build). This input is visible publicly: do
   not use a confidential branch name or any credential.
4. Choose `macos-arm64` for an Apple Silicon Mac. Alternatives: `macos-x64`,
   `windows-x64`, `linux-x64`. Keep `run_tests` enabled.
5. Click the green **Run workflow** button. Approve the environment if configured.
6. Download results from **the private repo's [Releases](https://github.com/nguyenducluongg/donut/releases)**,
   not from this repo's Actions artifacts. Success produces a private prerelease;
   failure produces a draft with `build.log` and `BUILD-MANIFEST.json` for the owner.

After a source/controller update, start a **new Run workflow**, not a rerun of
an old failed job. GitHub reruns keep the original event's controller SHA/ref.
[Rerun semantics](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).
Local entry point on the SSD is now
`/Volumes/SSD/Desktop/vibecoding/donutbrowser/workspace`: `donut/` is private
source; `lnbrowserbuild/` is this controller. Old lab paths are compatibility links.

[GitHub's manual-run instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

## Privacy, build scope, and limits

- Compiler, install, test, and packaging output is redirected to a private log.
  No public source archives, compiled artifacts, logs, or dependency caches are
  uploaded. Credentials are scoped to checkout/publish steps and not retained
  by Git or passed to dependency installation/build steps.
- Repository privacy is checked before checkout and again before private upload.
  Changing `donut` to public must fail closed. Run timing, status, platform, inputs,
  commit hashes and checkout metadata can still be visible in the public workflow.
- This is privacy hardening, **not a cryptographic confidentiality guarantee**:
  the GitHub runner and executed source/dependencies must be trusted. Compiled
  frontend JS is part of a desktop binary and can be inspected by its recipient.
- Builds use Node 24, the source's pinned pnpm version, frozen JS/Rust lockfiles,
  one Cargo job, and no cache shared with forks. A clean build can take longer.
  The first user-triggered run passed authentication, checkout and private-log
  publication, then failed a source test that referenced removed upstream release
  workflows. That test now checks the current Tauri packaging contract; fresh
  compilation/runtime are still pending. Controller tests pass 9 checks.
- This builds the **Donut manager**, not the Wayfern browser engine. It does not
  bundle/download/re-patch Wayfern, start browser profiles, or run browser E2E.
  Keep the selected fixed Wayfern binary separately; packaging is not proof of
  fresh REST/MCP runtime acceptance.
- macOS packages are **ad-hoc signed, not Apple-notarized**. Windows packages are
  unsigned. Existing Apple signing secrets are not needed or included.
- Standard public hosted runner compute is free under
  [GitHub's documented billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
  Larger runners are not used; private source stays private. This does not promise
  that every storage/product charge is zero. Follow GitHub usage policies.

Local controller checks (no build): `node --test ci/private-release.test.mjs`.
