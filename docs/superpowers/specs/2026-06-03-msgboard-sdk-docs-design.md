# MsgBoard SDK and Documentation Portal — Design

Date: 2026-06-03
Status: Approved (brainstorming complete; ready for implementation planning)

## Summary

Build a developer documentation surface for MsgBoard around two artifacts that
each have a single source of truth, so the documentation cannot drift:

1. A machine-readable **OpenRPC** specification (`openrpc.json`) describing the
   JSON-RPC methods the `msgboard_` module exposes. This is the single source of
   truth for the **API surface** and is published with the package for third
   parties to consume.
2. A **documentation portal** whose prose lives once in the package README and
   whose API reference is generated from `openrpc.json`. The same prose and
   reference are surfaced both on npm and on the website, with the existing live
   "try-it" widget reused as an interactive playground.

The software development kit (`@pulsechain/msgboard`, version 0.0.28) already
exists and is published; this effort documents it, it does not rewrite it.

## Goals and success criteria

- A developer who finds `@pulsechain/msgboard` on npm can install it, connect to
  a node that runs the module, post a message, and read messages — using only
  the README, with no broken or stale examples.
- A visitor on the website can open a documentation page, read the same guides,
  see a complete API reference, and try calls live in the browser.
- A third party can download `openrpc.json` and drive their own tooling
  (OpenRPC Playground, code generation, an external documentation page) from it.
- The API reference shown in the README and on the website is generated from
  `openrpc.json`, so there is exactly one place to change a method signature.
- The conceptual prose exists in exactly one file (`README.md`) and is shown in
  both places.

## Audience

Both audiences are first-class:

- Software development kit developers who arrive via npm or the repository and
  read the README and their editor's type hints.
- Website visitors who arrive via the landing page and click "Explore the API."

The README is the canonical prose. The website renders that same README rather
than maintaining a second copy.

## Scope

### In scope

- Author and validate `openrpc.json`.
- Fix and restructure `packages/client/README.md` into the canonical prose plus a
  generated API-reference region.
- A generation script that turns `openrpc.json` into (a) the README reference
  region and (b) a data file the website imports.
- An on-site documentation portal that renders the README prose, the generated
  reference, and the existing live playground, reached via a hash route.
- Rewire the landing page "Explore the API" card to point at the on-site portal.

### Out of scope (deferred, tracked separately)

- **Zod validation upgrade.** Adding runtime validation of RPC responses is a
  separate hardening effort. It was considered and explicitly deferred to avoid
  coupling validation, types, the spec, and the docs into one pipeline and to
  keep the published software development kit dependency-light.
- **The chain 943 and chain 1 default RPC fallbacks.** `rpc.svelte.ts` defaults
  for those chains point at nodes that do not serve the `msgboard_` module, the
  same latent issue already fixed for chain 369. Production overrides them with
  build-time environment variables, so they are left as-is for now.
- Rewriting the software development kit's parsing or proof-of-work code.

## Strand 1 — OpenRPC specification

### Why OpenRPC, not OpenAPI

MsgBoard is JSON-RPC, not REST. OpenAPI describes path-and-verb REST APIs;
modelling JSON-RPC in it would collapse every method into a single opaque
`POST /`, which defeats the purpose. OpenRPC (openrpc.org) is the JSON-RPC analog
of OpenAPI: a machine-readable document of methods, parameters, results, and
type schemas. It is consumed by the OpenRPC Playground and Inspector and by code
generators, exactly the way OpenAPI tooling consumes an OpenAPI document.

### Location and publishing

- File: `packages/client/openrpc.json`, beside the software development kit it
  describes.
- Added to the package `files` array so it ships to npm and can be imported by
  the website.

### Contents

The five wire methods the module exposes:

- `msgboard_status`
- `msgboard_categories`
- `msgboard_content`
- `msgboard_addMessage`
- `msgboard_getMessage`

Each method documents its parameters, its result, and at least one example pair.
Shared `components/schemas` describe `Status`, `MessageSeed`, `Message`,
`RPCMessage`, and `Content`, matching the TypeScript types in
`packages/client/src/types.ts`.

`doPoW` and `getDifficulty` are deliberately **excluded** from the OpenRPC
document: they are client-side software development kit methods, not JSON-RPC
calls. They are documented in the guides and the generated reference's
"client methods" section instead.

### Validation

A test validates `openrpc.json` against the OpenRPC meta-schema using
`@open-rpc/schema-utils-js` so the published specification cannot silently rot.

## Strand 2 — Documentation portal

### Two sources of truth

- **The API reference is generated from `openrpc.json`.** A generation script
  renders the method and type tables into (a) a clearly delimited region of the
  README and (b) a small JSON data file the website imports to render the
  on-site reference (Vite imports JSON natively).
- **The conceptual prose lives once in `packages/client/README.md`** — the
  canonical document, which is also what npm displays. The website renders that
  same README by importing it as raw text (Vite `?raw`) and converting markdown
  to HTML at build time with `markdown-it`. The prose therefore exists once and
  appears in both places with no copy to keep in sync.

### Content

- **Quickstart.** Install; choose a node that runs the module (valve.city, or run
  your own); connect with viem and with ethers; post a message
  (`doPoW` then `addMessage`); read messages (`content`). This also fixes the
  existing README bug where the ethers example calls `addMessage(work)` instead
  of `addMessage(work.message)`.
- **Guides.**
  - Finding and choosing a node (the `msgboard_` module requirement; valve.city;
    running your own).
  - Proof of work and difficulty (the difficulty formula, the per-byte data
    cost, the "stamp" framing used on the landing page).
  - Categories (`categoryHash`, the `gasmoneyplease` example).
  - Ephemerality (the 120-block expiry / `BLOCK_RANGE_LIMIT`).
  - Keeping proof-of-work off the user-interface thread (web worker; the existing
    "blocking" note).
  - Error handling (method-not-found means the node lacks the module; rate
    limits).
- **API reference (generated).** The five JSON-RPC methods, the client methods
  (`doPoW`, `getDifficulty`), and the utility functions (`categoryHash`,
  `checkWork`, `difficulty`, `encodeData`, `toRLP`).
- **Playground.** The existing live `Docs.svelte` widget, reused as the
  interactive section.

### On-site rendering and routing

- There is no client-side router dependency in the website; it is a single
  mounted `App.svelte`. The portal is reached via a **hash route** (`#/docs`):
  `App.svelte` conditionally renders a new `DocsPortal` component versus the
  existing `Home`, based on `location.hash`, with a `hashchange` listener. This
  adds no dependency.
- `DocsPortal` composes: the rendered README prose, the generated reference, and
  the existing `Docs.svelte` playground.

### Integration points

- The landing page `NextSteps` "Explore the API" card links to `#/docs` instead
  of the GitLab repository; the repository link is retained as a smaller
  "source" link.
- Because npm renders `packages/client/README.md`, fixing and restructuring the
  README automatically serves the npm audience.

## Build order

This becomes the implementation plan:

1. Author `openrpc.json` and add the meta-schema validation test.
2. Restructure `README.md` (canonical prose with corrected examples; a delimited,
   generated reference region) and write the generation script that fills the
   reference region and emits the website's reference data file.
3. Build the on-site `DocsPortal` (markdown rendering of the README; the
   generated reference; the reused playground; the hash route) and rewire the
   `NextSteps` card.

## Risks and mitigations

- **Reference drift.** Mitigated by generating the reference from `openrpc.json`
  in both targets and validating the specification in a test.
- **Prose drift.** Mitigated by rendering the single README in both places rather
  than maintaining a second copy.
- **Markdown rendering weight on the website.** `markdown-it` is small and runs at
  build time against a single file; no runtime markdown pipeline is introduced.
- **Hash route is a lightweight choice.** If the site later needs real routing,
  the conditional render is a small, contained piece to replace.
