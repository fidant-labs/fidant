# 0005: shadcn/ui and Radix on Preact via compat

- Status: Accepted
- Date: 2026-11-23
- Linear: FID-69

## Context

- `apps/web` is Preact 11 with Vite and Tailwind v4 (FID-67). Its buttons, inputs, cards, notices and menu are hand-made Tailwind elements.
- FID-69 asks for shadcn/ui components instead. shadcn/ui is written for React: its components import `react` and are built on Radix primitives (or Base UI), which also import `react` and `react-dom`.
- `preact/compat` implements the React API on top of Preact. With `react` and `react-dom` resolved to it, React libraries run on Preact without React itself.
- shadcn/ui is not a dependency in the usual sense. Its CLI copies component source into the repository, where we own and edit it. The libraries those components import (Radix, `class-variance-authority`, a `cn` helper) are real dependencies.

## Options considered

| Option                            | For                                                                                                                                                  | Against                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Keep hand-made Tailwind elements  | No new dependencies, smallest bundle                                                                                                                 | Every component, its states and its accessibility stay ours to build and test. FID-69 asks for shadcn.                 |
| shadcn/ui with Radix via compat   | Stock, widely used components with tested keyboard and screen-reader behavior. Radix is the base FID-69 names. Preact stays; no React in the bundle. | React-ecosystem dependencies on a Preact app. Relies on compat matching React closely enough for Radix. Larger bundle. |
| shadcn/ui with Base UI via compat | The CLI's newer default base                                                                                                                         | Same compat reliance as Radix, younger library, and FID-69 names Radix.                                                |
| Move `apps/web` to React          | shadcn and Radix run on the runtime they target                                                                                                      | Rewrites the client and its tests for no product gain, and a larger runtime.                                           |

## Decision

`apps/web` uses shadcn/ui with Radix primitives, running on Preact through `preact/compat`.

- **Resolution.** Vite aliases `react`, `react-dom` and `react/jsx-runtime` to `preact/compat` and `preact/jsx-runtime`, and `tsconfig.json` maps the same names with `paths`. `package.json` declares `react` and `react-dom` as npm aliases of `@preact/compat`, which re-exports `preact/compat`, so the React peer dependencies of Radix are met and pnpm never installs React.
- **Stock look.** We use shadcn's default theme and component styles as the CLI generates them. The only edit to its CSS: dark mode follows the OS through `prefers-color-scheme` instead of a `.dark` class.
- **Only what we use.** We add components with the CLI as pages need them, and commit the generated source in `apps/web/src/components/ui/`.

## Consequences

- **Compat is global.** Once anything imports `preact/compat`, its option hooks apply to the whole app, including our own Preact components. `onChange` on text inputs fires on every keystroke like React's (it is mapped to `onInput`), and both `class` and `className` work.
- **Pass `className`, not `class`, to shadcn components.** They read `className` and merge it with `cn`. A `class` prop is not merged and can drop the component's own classes.
- **No `asChild` or Radix `Slot`.** Compat's prop merging drops `class` when a child is cloned. To give a link a button's look, put `cn(buttonVariants(...))` in the link's `className`. Without the `cn` merge, a variant's border color loses to the base `border-transparent`.
- **Hand edits to generated code.** `button.tsx` has no `asChild` or `Slot`; `input.tsx` passes `type` through props; `label.tsx` is typed as `ComponentProps<"label">` (all for typecheck under `exactOptionalPropertyTypes` and the no-`asChild` rule). Components import `cn` from the `cn` package (there is no `lib/utils.ts`). `styles.css` does dark mode with `prefers-color-scheme`, and the CLI may re-add `@custom-variant dark` or `.dark`. `shadcn add`, a component that depends on an edited one, or `--overwrite` can silently regenerate these. Decline overwrites of edited files and review the `styles.css` diff after every `shadcn add`.
- **No components that inject `<style>` at runtime.** Dialog, Sheet, AlertDialog, Drawer, Select, DropdownMenu, ContextMenu, a modal Popover and ScrollArea add a `<style>` element when they open or mount. The server's Content Security Policy (`default-src 'self'`, no `style-src`, in `apps/server/src/server.ts`) blocks inline `<style>` elements, so these need a separate decision (a CSP nonce or `style-src` change) first.
- **Focus ring.** shadcn's stock ring is lighter than our previous 3px primary outline. We keep it to stay stock, and note it as a known gap against WCAG 2.2 focus appearance. Elements outside shadcn keep our `:focus-visible` outline.
- **Bundle.** Radix, `class-variance-authority` and the `cn` helper add to the client bundle. The increase is measured in the FID-69 pull request.
- **Dependency review.** New React-ecosystem dependencies get the same review as any other. A library that needs a React feature compat lacks is a reason to pick another component, not to add React.
