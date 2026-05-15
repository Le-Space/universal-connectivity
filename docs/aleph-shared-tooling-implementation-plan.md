# Aleph Shared Tooling Implementation Plan

## Goal

Create a new shared project and GitHub repository that becomes the source of
truth for Aleph VM deployment and rootfs-building tooling used by:

- `universal-connectivity`
- `relay-deployer-pwa`

The new shared repo should let both projects consume the same deployment and
rootfs logic while keeping changes inside `universal-connectivity` as small as
possible for future upstream PRs.

## Outcome We Want

- One shared repo for Aleph deployment and rootfs tooling.
- Shared TypeScript/JavaScript libraries for browser and Node environments.
- Shared manifest schema and validation logic.
- Shared GitHub Action wrapper(s) for deployment and optionally build/publish.
- Optional reusable GitHub workflow(s) published from the shared repo.
- A comprehensive Docusaurus documentation site for the shared repo.
- Minimal wrapper code left in `universal-connectivity`.
- `relay-deployer-pwa` consumes the shared browser/core library instead of
  owning duplicated deployment logic.

## Important Constraint

`universal-connectivity` remains the source of truth for:

- `go-peer`
- `js-peer`
- `node-js-peer`
- the `uc-go-peer` application behavior

The new shared repo becomes the source of truth for the Aleph packaging,
deployment, manifest, and workflow tooling around that application.

## Verified Current State

### In `universal-connectivity`

- Newer headless deployment SDK exists in `go-peer/aleph/vm-sdk`.
- GitHub composite action exists in `.github/actions/aleph-vm-deploy`.
- Reusable workflow exists in `.github/workflows/uc-go-peer-rootfs-reusable.yml`.
- Rootfs build flow exists in `go-peer/aleph/rootfs`.
- `uc-go-peer` rootfs profile contract exists in
  `go-peer/aleph/root-profiles/uc-go-peer.json`.
- `js-peer` is republished after VM deployment using final browser bootstrap
  multiaddrs.
- Deployment flow includes:
  - rootfs STORE validation
  - CRN discovery and country preference
  - port-forward aggregate publication
  - runtime polling
  - guest configuration
  - metadata retrieval
  - reachability verification
  - retention cleanup

### In `relay-deployer-pwa`

- Browser-oriented deployment library already exists under `src/lib`.
- Shared-looking pieces already exist for:
  - Aleph API access
  - deployment validation
  - rootfs manifest validation
  - port-forward aggregate publishing
  - CRN geo logic
- The PWA also contains repo-specific and product-specific behavior:
  - Svelte UI state and polling UX
  - MetaMask/browser wallet integration
  - prepaid / AA-wallet logic
  - legacy profile support
  - browser-specific instance inspection behavior and CORS handling

## Recommended Architecture

Use a new monorepo rather than a single package.

Suggested structure:

```text
shared-aleph-tooling/
  README.md
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .github/
    actions/
      aleph-vm-deploy/
    workflows/
      build-rootfs.yml
      deploy-vm.yml
  packages/
    core/
    browser/
    node/
    rootfs/
    github-action/
    shared-types/
  templates/
    uc-go-peer/
  examples/
    universal-connectivity/
    relay-deployer-pwa/
  docs/
    docusaurus/
```

## Package Boundaries

### `packages/core`

Framework-agnostic Aleph logic:

- Aleph message creation and parsing
- deployment orchestration
- CRN fetch, ranking, and selection
- runtime polling
- rootfs reference resolution
- port-forward aggregate logic
- verification helpers
- retention cleanup
- manifest schema helpers

This package must not depend directly on:

- GitHub Actions APIs
- browser wallet APIs
- direct process env usage
- repo-local file paths

### `packages/browser`

Browser adapter around `core`:

- injected signer interface for MetaMask or wallet provider
- browser-safe fetch/http helpers
- UI-friendly progress callbacks or event hooks
- PWA-oriented helper functions

### `packages/node`

Node adapter around `core`:

- private-key-based signing
- CLI entrypoints
- env parsing
- structured logging
- headless automation helpers

### `packages/rootfs`

Shared rootfs packaging helpers:

- manifest schema and generation
- rootfs contract parsing
- upload/pin/wait helpers
- build orchestration
- shared builder utilities

This package should support pluggable profile inputs instead of baking
application-specific behavior directly into the library.

### `packages/github-action`

Action-facing wrapper for GitHub:

- stable action input/output mapping
- thin shell/Node wrapper over `packages/node`
- releaseable as a GitHub Action from the new repo

### `packages/shared-types`

Optional package if type sharing becomes large enough to justify a separate
module.

## GitHub Distribution Model

We should support three consumption models:

1. npm packages
2. GitHub Action(s)
3. reusable GitHub workflow(s)

Important note:

- npm is for libraries and CLI packages
- GitHub Actions are consumed with `uses: owner/repo/path@tag`
- reusable workflows are consumed with
  `uses: owner/repo/.github/workflows/file.yml@tag`

So the new repo should publish both npm artifacts and GitHub-hosted automation
artifacts where appropriate.

## Docusaurus Requirement

The new shared repo must include a Docusaurus docs site.

### Docusaurus goals

- onboarding for both consumer repos
- architecture explanation
- API documentation for packages
- migration guides
- operational workflows
- profile authoring guidance
- release and versioning notes
- troubleshooting

### Recommended Docusaurus sections

- `docs/overview/`
  - what the project is
  - repo layout
  - supported environments
- `docs/architecture/`
  - package boundaries
  - runtime model
  - manifest model
  - action/workflow model
- `docs/guides/`
  - use from `universal-connectivity`
  - use from `relay-deployer-pwa`
  - deploy a VM from Node
  - deploy a VM from browser wallet
  - build and publish a rootfs
  - add a new rootfs profile
- `docs/reference/`
  - manifest schema
  - action inputs/outputs
  - workflow inputs/outputs
  - package APIs
- `docs/migration/`
  - UC migration plan
  - PWA migration plan
  - breaking changes and compatibility notes
- `docs/operations/`
  - release process
  - testing strategy
  - debugging failed deployments

## What To Extract First

These areas are clearly shared and should be moved early:

- rootfs manifest schema and validation
- Aleph API helpers
- CRN geo/ranking/selection
- deploy message creation and broadcasting
- port-forward aggregate publication
- runtime inspection and polling
- guest configuration flow
- verification helpers
- retention cleanup
- shared deployment/result types

## What To Keep Repo-Specific At First

### Keep in `relay-deployer-pwa`

- Svelte UI
- wallet connection UX
- prepaid / AA-wallet flow
- browser storage and local UI persistence
- instance-history presentation and action feedback

### Keep in `universal-connectivity`

- `go-peer`
- `js-peer`
- `node-js-peer`
- `uc-go-peer` business logic
- app-specific guest setup behavior where it is still tightly bound to the app

## Migration Strategy

### Phase 0: Discovery And Design

- Build a feature matrix comparing UC and PWA behavior.
- Mark each capability as:
  - shared now
  - repo-specific
  - maybe shared later
- Freeze public compatibility goals for:
  - GitHub Action inputs/outputs
  - manifest schema
  - deployment result shape

Deliverables:

- feature matrix
- package boundary document
- dependency graph
- migration risk list

### Phase 1: Create New Repo Skeleton

- Create the new GitHub repo.
- Initialize monorepo tooling.
- Add:
  - `packages/core`
  - `packages/browser`
  - `packages/node`
  - `packages/rootfs`
  - GitHub Action folder
  - Docusaurus site
- Set up CI, linting, test runner, and release plumbing.

Deliverables:

- repo skeleton
- CI baseline
- docs site scaffold

### Phase 2: Extract Shared Deployment Core

- Start from the newer UC VM SDK as the functional baseline.
- Merge in reusable logic from the PWA where it improves:
  - browser-safe abstractions
  - tests
  - rootfs validation
  - deployment typing
- Introduce explicit interfaces for:
  - signer
  - logger
  - fetch/http
  - output sink

Deliverables:

- first shared `core`
- adapter interfaces
- migrated tests

### Phase 3: Extract Browser And Node Adapters

- Build `packages/browser` from PWA integration needs.
- Build `packages/node` from UC workflow integration needs.
- Keep CLIs and env parsing in `node`, not `core`.
- Keep wallet-provider concerns in `browser`, not `core`.

Deliverables:

- browser package
- node package
- sample usage in docs

### Phase 4: Extract Shared Rootfs Tooling

- Move generic rootfs build logic out of UC:
  - contract parsing
  - manifest generation
  - upload/pin/wait flow
  - reusable builder helpers
- Move the `uc-go-peer` rootfs guest scripts into the shared repo as the first
  reference/example implementation.
- Let the UC GitHub workflow consume those shared scripts if the integration
  stays clean.
- Keep profile-specific scripts pluggable.
- Define how a consuming repo contributes:
  - profile JSON
  - guest scripts
  - app binary or build hook

Deliverables:

- rootfs package
- shared `uc-go-peer` reference rootfs script set
- pluggable profile contract
- documented extension points

### Phase 5: Publish GitHub Action(s)

- Publish a stable deploy action from the new repo.
- Preserve the current UC action behavior as much as possible.
- Add test coverage for:
  - input parsing
  - output emission
  - failure handling
  - partial-result emission

Deliverables:

- shared `aleph-vm-deploy` GitHub Action
- versioned tags
- migration guide for UC

### Phase 6: Decide On Reusable Workflow Publication

- Publish the reusable workflow from the shared repo.
- Separate:
  - generic workflow logic
  - app/profile-specific environment inputs
- Keep consumer-repo wrappers thin where they help preserve compatibility with
  existing local workflow entrypoints.

Deliverables:

- shared reusable workflow
- compatibility wrapper guidance for consumer repos

### Phase 7: Integrate `universal-connectivity`

- Create a dedicated migration branch in `universal-connectivity` before wiring
  it to the shared repo.
- Replace local Aleph deployment internals with wrappers to the shared repo.
- Keep workflow interface stable where possible.
- Minimize upstream-facing diff by preserving:
  - filenames when useful
  - workflow inputs
  - expected outputs
- Leave only thin adapters in UC.

Deliverables:

- UC integration PR
- compatibility notes
- rollback plan

### Phase 8: Integrate `relay-deployer-pwa`

- Create a dedicated migration branch in `relay-deployer-pwa` before swapping
  over to the shared browser/core packages.
- Replace local deployment library internals with `browser` + `core`.
- Keep UI behavior unchanged initially.
- Do not migrate prepaid / AA flow into shared scope without explicit approval.

Deliverables:

- PWA integration PR
- browser adapter validation

### Phase 9: Documentation And Adoption

- Complete Docusaurus docs.
- Add examples for:
  - UC CI usage
  - headless CLI usage
  - browser wallet deployment
  - rootfs build and publish
- Add migration guides for both consumers.

Deliverables:

- published docs site
- examples
- onboarding guide

## Testing Strategy

We need tests at several levels.

### Unit tests

- manifest validation
- message creation
- CRN ranking
- aggregate publication payload generation
- deployment result normalization
- runtime and verification helpers

### Integration tests

- browser signer adapter
- Node/private-key signer adapter
- GitHub Action output behavior
- reusable workflow smoke path

### Fixture-based tests

- Aleph API responses
- CRN runtime payloads
- rootfs manifests
- deployment rejection scenarios

### Optional end-to-end tests

- test deployment against a disposable Aleph environment or recorded mock layer

## Compatibility Rules

### For `universal-connectivity`

- prefer wrapper replacement over structural rewrites
- preserve current workflow inputs and outputs where possible
- avoid moving `go-peer`, `js-peer`, or app logic out of UC unless needed

### For `relay-deployer-pwa`

- keep browser UX local
- keep prepaid/AA logic local unless approved
- move only the shared deployment machinery first

## Risks

- extracting too much app-specific logic into the shared core too early
- coupling browser and Node concerns together again
- breaking current UC workflow contracts
- turning guest scripts into a generic abstraction before the real common shape
  is understood
- docs lagging behind code during extraction

## Decisions Already Recommended

- use a monorepo
- treat the new repo as shared tooling, not app source
- publish both npm packages and GitHub automation artifacts
- add Docusaurus from the start, not later
- migrate shared deployment logic before rootfs profile generalization

## Decisions That Still Need Confirmation

### Decision 1: profile scope for the first shared release

Options:

- only `uc-go-peer`
- `uc-go-peer` plus selected legacy profiles
- all legacy profiles from the PWA repo

Recommendation:

- start with `uc-go-peer` only
- bring legacy profiles over only if there is an active consumer and a clear
  maintenance reason

Confirmed decision:

- first shared release supports only `uc-go-peer`
- the architecture should stay ready for future integration of one or more
  legacy profiles from `relay-deployer-pwa`

### Decision 2: prepaid / AA wallet logic

Recommendation:

- keep this PWA-only for now
- revisit only after the shared deployment core is stable

Confirmed decision:

- prepaid / AA-wallet functionality remains in `relay-deployer-pwa` for now
- it is out of scope for the first shared repo extraction
- shared packages should not depend on prepaid or AA-wallet-specific behavior

### Decision 3: guest scripts ownership

Recommendation:

- phase 1 shared repo should own generic tooling first
- app/profile guest scripts can remain in consumer repos until we know the
  stable extension model

Confirmed direction:

- the new shared repo should include the rootfs guest scripts as an example /
  reference implementation
- the `universal-connectivity` GitHub workflow should consume those shared
  scripts if that keeps the integration clean
- the shared design should still allow consumer-level overrides if some script
  behavior later proves to be UC-specific

### Decision 4: workflow publishing scope

Recommendation:

- definitely publish the deploy GitHub Action
- decide separately whether to publish the full reusable workflow in phase 6

Confirmed decision:

- the new shared repo should publish both:
  - the deploy GitHub Action
  - the full reusable workflow
- `universal-connectivity` and `relay-deployer-pwa` should consume those shared
  automation entrypoints from the shared repo once migration is ready

## Proposed First Milestone

Milestone 1 should produce:

- new shared repo created
- monorepo structure in place
- Docusaurus scaffold in place
- shared core package extracted
- Node adapter extracted
- GitHub deploy action published
- UC updated to use the shared deploy action with minimal wrapper changes

This gives immediate consolidation value without forcing rootfs and PWA
migration to happen at the same time.

## Repo Bootstrap Checklist

This checklist is intended to guide the first setup PRs for the new shared repo.

### 1. Create The New Repository

- Create the new GitHub repository for shared Aleph tooling.
- Add a short temporary repository description.
- Decide the canonical package scope name for npm publishing.
- Protect the default branch.
- Enable GitHub Actions.
- Enable GitHub Pages or the preferred Docusaurus hosting target.

Suggested placeholders to confirm during repo creation:

- repo name:
  - `shared-aleph-tooling`
  - `aleph-vm-tooling`
  - `aleph-relay-tooling`
- npm scope:
  - `@shared-aleph`
  - `@aleph-vm`
  - `@universal-connectivity`

### 2. Initialize Monorepo Tooling

- Create the root `package.json`.
- Add `pnpm-workspace.yaml`.
- Add root `tsconfig.base.json`.
- Add shared lint/format/test scripts.
- Add `.editorconfig`, `.gitignore`, and license file.
- Add CI bootstrap workflow for install, build, lint, and test.

Suggested root files:

- `package.json`
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `vitest.config.ts` or equivalent
- `eslint.config.js`
- `prettier.config.js` if used
- `.github/workflows/ci.yml`

### 3. Create Initial Package Layout

- `packages/core`
- `packages/browser`
- `packages/node`
- `packages/rootfs`
- `packages/shared-types` if needed
- `packages/github-action` if a JS action wrapper is preferred

Each package should include:

- `package.json`
- `tsconfig.json`
- `src/`
- `README.md`
- minimal smoke test

### 4. Create Automation Entrypoints

- Add GitHub Action folder for the deploy action.
- Add reusable workflow folder for the full build/publish/deploy workflow.
- Define a versioning and tagging strategy for both.

Suggested paths:

- `.github/actions/aleph-vm-deploy/`
- `.github/workflows/aleph-rootfs-build-publish-deploy.yml`

### 5. Scaffold Docusaurus Early

- Initialize Docusaurus in the shared repo.
- Set up docs navigation structure from the start.
- Add at least:
  - overview page
  - architecture page
  - migration page
  - action/workflow reference placeholder

Suggested docs bootstrap:

- `docs/overview/index.md`
- `docs/architecture/monorepo-layout.md`
- `docs/architecture/package-boundaries.md`
- `docs/migration/universal-connectivity.md`
- `docs/migration/relay-deployer-pwa.md`
- `docs/reference/github-action.md`
- `docs/reference/reusable-workflow.md`

### 6. Define Public API Contracts Before Copying Code

- Define stable exported types for deployment, manifests, runtime metadata, and
  verification results.
- Define signer interfaces for browser and Node.
- Define logger and progress callback interfaces.
- Define rootfs profile contract and extension interfaces.

This step should happen before large code moves to avoid copying repo-local
assumptions into the shared packages.

### 7. Import The First Shared Code

- Start with UC VM SDK logic as the deployment baseline.
- Import PWA reusable pieces where they improve tests, types, or browser
  portability.
- Add fixture-based tests immediately around imported logic.

Priority order:

1. shared types
2. manifest parsing and validation
3. Aleph API and message helpers
4. deployment orchestration
5. runtime inspection and verification
6. retention logic

### 8. Import The First Rootfs Reference Implementation

- Move the `uc-go-peer` rootfs guest scripts into the shared repo.
- Move or recreate the shared rootfs build helpers around them.
- Document how UC consumes them.
- Preserve an override path for consumer-specific script replacements.

### 9. Add Consumer Migration Wrappers

- In `universal-connectivity`, add thin wrappers that call into the shared
  action/workflow contracts.
- In `relay-deployer-pwa`, add thin browser adapters over the shared packages.
- Keep local filenames and top-level entrypoints where that reduces future diff.

### 10. Define Release Plumbing

- npm publish workflow
- GitHub Action tagging workflow
- reusable workflow versioning guidance
- changelog strategy
- semver policy

### 11. Create The First Migration PR Sequence

Suggested PR order:

1. New shared repo scaffold + Docusaurus + empty packages
2. Shared types + manifest schema + tests
3. Shared deployment core + Node adapter
4. Shared GitHub deploy action
5. Shared rootfs package + `uc-go-peer` reference scripts
6. Shared reusable workflow
7. UC integration PR on `feature/shared-aleph-tooling-migration`
8. PWA integration PR on `feat/shared-aleph-tooling-migration`

### 12. Track Branches For Migration Work

Current planned migration branches:

- `universal-connectivity`: `feature/shared-aleph-tooling-migration`
- `relay-deployer-pwa`: `feat/shared-aleph-tooling-migration`

The new shared repo should also use a dedicated bootstrap branch for the initial
setup work before the first merge to its default branch.

## Naming Options And Recommendation

We should choose a name that is:

- broader than `universal-connectivity`
- not tied only to the current PWA
- flexible enough to cover:
  - VM deployment
  - rootfs build/publish
  - GitHub Actions/workflows
  - browser and Node SDK usage

### Repo Name Options

Good candidates:

- `shared-aleph-tooling`
- `aleph-vm-tooling`
- `aleph-deploy-toolkit`
- `aleph-rootfs-and-vm-tooling`

Recommendation:

- prefer `shared-aleph-tooling` if we want the broadest and most future-proof
  name
- prefer `aleph-vm-tooling` if we want a shorter, more focused name centered on
  VM and deployment workflows

My recommendation:

- repo name: `shared-aleph-tooling`

Reason:

- it leaves room for deployment, manifests, rootfs helpers, actions, workflows,
  and docs without sounding too narrow

### npm Scope Options

Good candidates:

- `@shared-aleph`
- `@aleph-vm`
- `@aleph-tooling`

Recommendation:

- use `@shared-aleph` if available

Example package naming under that scope:

- `@shared-aleph/core`
- `@shared-aleph/browser`
- `@shared-aleph/node`
- `@shared-aleph/rootfs`

### GitHub Action Naming

Suggested action path and display name:

- path: `.github/actions/aleph-vm-deploy`
- display name: `Aleph VM Deploy`

Suggested reusable workflow filename:

- `.github/workflows/aleph-rootfs-build-publish-deploy.yml`

### Temporary Working Assumption

Until a final naming decision is confirmed, this plan assumes:

- repo: `shared-aleph-tooling`
- npm scope: `@shared-aleph`

## Proposed Monorepo Tree And Code Mapping

This section makes the target layout more concrete and maps likely source code
from the current repos into the new shared repo.

### Proposed Monorepo Tree

```text
shared-aleph-tooling/
  README.md
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .editorconfig
  .gitignore
  .github/
    actions/
      aleph-vm-deploy/
        action.yml
        README.md
    workflows/
      ci.yml
      publish-packages.yml
      release-action.yml
      aleph-rootfs-build-publish-deploy.yml
  packages/
    shared-types/
      package.json
      src/
        index.ts
        manifest.ts
        deployment.ts
        runtime.ts
    core/
      package.json
      src/
        index.ts
        aleph-api.ts
        messages.ts
        crn.ts
        manifests.ts
        port-forwarding.ts
        deploy.ts
        runtime.ts
        verify.ts
        retention.ts
        interfaces.ts
    browser/
      package.json
      src/
        index.ts
        signer.ts
        wallet-adapter.ts
        progress-events.ts
    node/
      package.json
      src/
        index.ts
        signer.ts
        cli.ts
        github-outputs.ts
        env.ts
    rootfs/
      package.json
      src/
        index.ts
        contract.ts
        manifest.ts
        build.ts
        upload.ts
        profiles.ts
      assets/
        uc-go-peer/
          root-profile.json
          build-rootfs.sh
          build-rootfs-image.sh
          Dockerfile.rootfs
          uc-go-peer-bootstrap.sh
          uc-go-peer-configure.sh
          uc-go-peer-setup-server.py
          uc-go-peer-autotls-refresh.py
          uc-go-peer-describe.py
          uc-go-peer.service
          uc-go-peer-bootstrap.service
          uc-go-peer-autotls-refresh.service
    fixtures/
      aleph/
      crn/
      manifests/
      runtime/
    examples/
      node-deploy/
      github-action-consumer/
      universal-connectivity-wrapper/
      relay-deployer-pwa-consumer/
  docs/
    docusaurus/
```

### Public Package Entry Points

Suggested initial exports:

#### `@shared-aleph/shared-types`

- manifest types
- deployment result types
- runtime metadata types
- verification result types
- port-forward types

#### `@shared-aleph/core`

- manifest parsing and validation
- CRN discovery and selection
- Aleph message creation and broadcasting helpers
- deployment orchestration
- runtime polling
- guest configuration flow
- verification helpers
- retention helpers

#### `@shared-aleph/browser`

- browser signer adapter
- wallet-facing deployment entrypoints
- progress callback/event helpers
- browser-safe convenience wrappers

#### `@shared-aleph/node`

- private-key signer adapter
- CLI entrypoint
- GitHub Action output helpers
- Node/headless deployment convenience wrappers

#### `@shared-aleph/rootfs`

- rootfs contract parsing
- manifest generation
- upload/pin/wait helpers
- build orchestration helpers
- profile asset lookup and reference implementation loading

### Likely Code Mapping From `universal-connectivity`

#### Into `@shared-aleph/core`

From `go-peer/aleph/vm-sdk/lib/aleph-vm-sdk.mjs`:

- Aleph API request helpers
- CRN geo/ranking/selection logic
- deployment message creation/signing flow
- runtime polling
- port-forward aggregate publication
- guest configuration orchestration
- verification logic
- retention logic

#### Into `@shared-aleph/node`

From `go-peer/aleph/vm-sdk/bin/cli.mjs`:

- CLI wiring
- env parsing
- GitHub output emission
- headless execution entrypoints

#### Into GitHub Action Wrapper

From `.github/actions/aleph-vm-deploy/action.yml`:

- stable GitHub Action interface
- setup-node and package install behavior
- action input/output contract

#### Into `@shared-aleph/rootfs`

From `go-peer/aleph/rootfs/`:

- `build-rootfs.sh`
- `build-rootfs-image.sh`
- `read-rootfs-contract.py`
- `wait-for-aleph-message.py`
- `publish-static-site.py` if it proves generic enough

#### Into shared rootfs assets/reference implementation

From `go-peer/aleph/rootfs/` and `go-peer/aleph/root-profiles/uc-go-peer.json`:

- `uc-go-peer` rootfs profile contract
- guest bootstrap/configure/setup/autotls/describe scripts
- service unit files
- rootfs Docker builder definition

#### Likely To Stay In UC As Thin Wrappers

- `.github/workflows/build-aleph-go-peer-rootfs.yml`
- `.github/workflows/uc-go-peer-rootfs-reusable.yml`

These would ideally become thin compatibility wrappers around shared workflow
and action entrypoints.

### Likely Code Mapping From `relay-deployer-pwa`

#### Into `@shared-aleph/shared-types`

From `src/lib/types.ts`:

- deployment form-independent Aleph types
- manifest-related types
- runtime and execution payload types
- payment-agnostic deployment result types

Only the types that are not prepaid/UI-specific should move.

#### Into `@shared-aleph/core`

From `src/lib/rootfsManifest.ts`:

- manifest validation
- rootfs STORE reference resolution
- gateway probing helpers

From `src/lib/portForwarding.ts`:

- required port-forward merge logic
- aggregate payload generation logic

From `src/lib/alephApi.ts`:

- browser-safe Aleph API normalization pieces
- execution/runtime payload normalization
- rejection-reason normalization that improves diagnostics

From `src/lib/deployment.ts`:

- SSH key normalization and validation
- deployment validation pieces that are not UI/payment-specific

#### Into `@shared-aleph/browser`

From `relay-deployer-pwa/src/lib/`:

- browser signer abstractions
- browser-safe fetch patterns
- optional progress/event hooks for the UI

#### Explicitly Out Of Shared Scope For Now

From `relay-deployer-pwa/src/lib/` and `src/App.svelte`:

- prepaid logic
- AA-wallet logic
- Svelte UI state and rendering
- local storage handling tied to the UI
- deployment history presentation
- wallet-specific UX flows

### Example Consumer Responsibilities After Extraction

#### `universal-connectivity`

Would keep:

- app source code
- `js-peer`
- `node-js-peer`
- app-specific workflow wrappers
- any narrowly UC-specific overrides

Would consume:

- shared deploy action
- shared reusable workflow
- shared Node/core packages
- shared rootfs reference scripts/assets

#### `relay-deployer-pwa`

Would keep:

- Svelte application
- prepaid / AA-wallet features
- UI-only deployment interactions

Would consume:

- shared browser/core packages
- shared types
- shared manifest logic
- shared deployment/runtime helpers

### First Extraction-Friendly PR Cuts

To reduce migration risk, the code should likely be moved in these cuts:

1. shared types + manifest schema
2. rootfs manifest validation and resolution helpers
3. port-forward aggregate helpers
4. shared Aleph API normalization helpers
5. deploy/runtime/verify core
6. Node CLI adapter
7. GitHub Action wrapper
8. `uc-go-peer` rootfs reference assets
9. reusable workflow

### Interfaces We Should Define Before Moving Code

To avoid leaking repo-local assumptions into the shared repo, define these
interfaces before large code extraction:

- `Signer`
  - browser wallet signer
  - Node private-key signer
- `Logger`
  - console
  - GitHub Actions annotations
  - UI progress sink
- `HttpClient`
  - browser fetch
  - Node fetch
- `OutputWriter`
  - plain return values
  - GitHub output writer
- `ProfileAssetProvider`
  - built-in reference assets
  - consumer override assets

### Mapping Risks To Watch

- moving GitHub-specific output logic into shared core by accident
- moving browser wallet concerns into shared core by accident
- over-generalizing rootfs profile behavior too early
- coupling UC-specific `js-peer` publish behavior to the shared rootfs package
- copying PWA payment assumptions into shared deployment types

## First PR Checklist

This section describes the recommended contents of the first PRs for the new
shared repo before any large code extraction starts.

### PR 1: Shared Repo Bootstrap

Goal:

- create the shared repo foundation
- avoid moving production logic yet
- make space for docs, packages, CI, and later extraction work

Files and folders to create:

- `README.md`
- `LICENSE`
- `.gitignore`
- `.editorconfig`
- `package.json`
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `.github/workflows/ci.yml`
- `.github/actions/aleph-vm-deploy/README.md`
- `.github/workflows/aleph-rootfs-build-publish-deploy.yml`
- `packages/core/package.json`
- `packages/core/src/index.ts`
- `packages/browser/package.json`
- `packages/browser/src/index.ts`
- `packages/node/package.json`
- `packages/node/src/index.ts`
- `packages/rootfs/package.json`
- `packages/rootfs/src/index.ts`
- `docs/docusaurus/`

Checklist:

1. Create monorepo root files.
2. Add empty package shells with placeholder exports.
3. Add CI that installs dependencies and runs a no-op build/test baseline.
4. Add Docusaurus scaffold.
5. Add placeholder READMEs for packages and automation entrypoints.
6. Add contribution notes for future extraction work.

Definition of done:

- repo installs cleanly
- CI passes
- docs site boots locally
- package boundaries are visible in the repo layout

### PR 2: Shared Types And Manifest Contract

Goal:

- define the first stable shared contract before moving orchestration logic

Files likely to create:

- `packages/shared-types/package.json`
- `packages/shared-types/src/index.ts`
- `packages/shared-types/src/manifest.ts`
- `packages/shared-types/src/deployment.ts`
- `packages/shared-types/src/runtime.ts`
- `packages/core/src/manifests.ts`
- `packages/core/test/manifests.test.ts`
- `packages/core/test/fixtures/`

Checklist:

1. Define manifest-related types.
2. Define deployment/runtime result types that are payment-agnostic.
3. Implement manifest validation.
4. Add tests using current UC and PWA manifest shapes.
5. Document the schema in Docusaurus.

Definition of done:

- both current repos can be modeled by the shared manifest types
- validation behavior is tested
- docs show the shared schema

### PR 3: Feature Matrix And Extraction Notes

Goal:

- capture exactly what moves, what stays, and what needs confirmation

Files likely to create:

- `docs/docusaurus/docs/architecture/feature-matrix.md`
- `docs/docusaurus/docs/migration/extraction-notes.md`

Checklist:

1. Record UC capabilities.
2. Record PWA capabilities.
3. Mark each capability as:
   - shared now
   - consumer-specific
   - deferred
4. Link each capability to likely target package(s).
5. Note any confirmation points still requiring review.

Definition of done:

- the team can use the matrix to decide extraction order without rereading both
  codebases from scratch

## Feature Matrix

This matrix is meant to guide extraction priority and prevent accidental scope
creep.

Legend:

- `Shared now`: should move into the new shared repo in the first waves
- `Consumer-specific`: should remain in UC or PWA for now
- `Deferred`: design for later, but do not block the first release on it

| Capability | universal-connectivity | relay-deployer-pwa | Target state | Likely target |
|---|---|---|---|---|
| Rootfs manifest schema | Yes | Yes | Shared now | `@shared-aleph/shared-types`, `@shared-aleph/core` |
| Rootfs manifest validation | Yes | Yes | Shared now | `@shared-aleph/core` |
| Rootfs STORE resolution and gateway probing | Partial | Yes | Shared now | `@shared-aleph/core` |
| Aleph API request helpers | Yes | Yes | Shared now | `@shared-aleph/core` |
| Aleph message creation/signing flow | Yes | Yes | Shared now | `@shared-aleph/core` with browser/Node adapters |
| CRN fetch and ranking | Yes | Yes | Shared now | `@shared-aleph/core` |
| CRN geo enrichment | Yes | Yes | Shared now | `@shared-aleph/core` |
| Preferred-country CRN selection | Yes | Partial | Shared now | `@shared-aleph/core` |
| Port-forward aggregate generation/publication | Yes | Yes | Shared now | `@shared-aleph/core` |
| Deployment wait/polling | Yes | Yes | Shared now | `@shared-aleph/core` |
| Runtime execution parsing | Yes | Yes | Shared now | `@shared-aleph/core` |
| Guest `/configure` orchestration | Yes | Partial | Shared now | `@shared-aleph/core`, `@shared-aleph/node` |
| Guest `/metadata` retrieval | Yes | Partial | Shared now | `@shared-aleph/core`, `@shared-aleph/node` |
| Reachability verification | Yes | Partial | Shared now | `@shared-aleph/core` |
| Successful deployment retention | Yes | No | Shared now | `@shared-aleph/core` |
| Headless private-key deployment | Yes | No | Shared now | `@shared-aleph/node` |
| Browser wallet deployment | No | Yes | Shared now | `@shared-aleph/browser` |
| GitHub Action deploy wrapper | Yes | No | Shared now | shared repo action |
| Reusable GitHub workflow | Yes | No | Shared now | shared repo workflow |
| Rootfs build orchestration | Yes | Yes, older version | Shared now | `@shared-aleph/rootfs` |
| `uc-go-peer` reference guest scripts | Yes | Partial/older copies | Shared now | `@shared-aleph/rootfs` assets |
| `js-peer` republish with deployed relay addrs | Yes | No | Consumer-specific | UC wrapper/workflow logic |
| Svelte PWA UI | No | Yes | Consumer-specific | stay in PWA |
| Wallet UX and local UI state | No | Yes | Consumer-specific | stay in PWA |
| Prepaid flow | No | Yes | Consumer-specific | stay in PWA |
| AA-wallet flow | No | Yes | Consumer-specific | stay in PWA |
| Deployment history UI and action feedback | No | Yes | Consumer-specific | stay in PWA |
| Legacy rootfs profiles | No | Yes | Deferred | later profile packages/templates |
| Alternate guest-script sets from PWA | No | Yes | Deferred | later profile packages/templates |
| Full guest-script override mechanism | Partial need | Partial need | Deferred | `@shared-aleph/rootfs` extension API |

### Feature Matrix Notes

- UC provides the strongest baseline for the headless deployment and workflow
  path.
- The PWA provides useful browser-safe logic, types, and tests, but also
  carries product-specific payment and UI concerns that should not move into the
  first shared extraction.
- Rootfs logic should use UC's current `uc-go-peer` flow as the initial
  reference implementation.
- Legacy profiles from the PWA should be treated as later profile-integration
  work, not as a blocker for the first release.

## Deferred Todo: Legacy Profile Integration

This is intentionally out of scope for the first shared release, but should
remain planned for later integration.

Later todo items:

1. Identify which legacy profiles from `relay-deployer-pwa` still have an
   active consumer.
2. Compare each legacy profile against the shared rootfs extension model.
3. Extract only the profile-specific assets that fit the shared contract cleanly:
   - profile manifest/contract
   - guest bootstrap/configure scripts
   - service definitions
   - app-specific build hooks
4. Decide per profile whether it belongs:
   - in the shared repo
   - in a consumer repo
   - in a separate profile package/template
5. Add migration guides and compatibility notes before enabling any legacy
   profile in the shared release train.

Non-goal for phase 1:

- do not block the shared repo extraction on legacy profile migration

## Suggested Near-Term Task Breakdown

1. Create the new repository and monorepo scaffold.
2. Create dedicated migration branches in `universal-connectivity` and
   `relay-deployer-pwa`.
3. Define package public APIs before copying code.
4. Extract shared deployment and manifest logic from UC and PWA.
5. Add tests around the extracted core.
6. Add the Node adapter and GitHub Action wrapper.
7. Scaffold Docusaurus and write architecture plus migration docs early.
8. Publish the reusable workflow from the shared repo and add thin consumer
   wrappers if needed.
9. Migrate UC deploy action and workflow usage.
10. Migrate PWA browser logic afterward.

## Tracking Notes

This file should be updated as decisions are confirmed, especially for:

- profile scope
- ownership of guest scripts
- which PWA-only features remain intentionally out of scope
