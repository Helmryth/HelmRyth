---
name: Helmryth
description: A light-first editorial instrument panel for persistent, accountable digital operators.
colors:
  canvas: "oklch(0.974 0.012 83)"
  canvas-muted: "oklch(0.948 0.016 83)"
  surface: "oklch(0.988 0.008 83)"
  surface-raised: "oklch(0.997 0.004 83)"
  surface-sunken: "oklch(0.925 0.018 83)"
  ink: "oklch(0.245 0.025 255)"
  ink-soft: "oklch(0.425 0.024 255)"
  ink-faint: "oklch(0.585 0.020 255)"
  rule: "oklch(0.835 0.020 83)"
  rule-strong: "oklch(0.690 0.025 83)"
  command: "oklch(0.565 0.185 32)"
  command-hover: "oklch(0.505 0.178 32)"
  command-soft: "oklch(0.925 0.045 32)"
  signal: "oklch(0.500 0.105 195)"
  signal-soft: "oklch(0.915 0.040 195)"
  success: "oklch(0.535 0.120 150)"
  success-soft: "oklch(0.930 0.040 150)"
  warning: "oklch(0.49 0.115 75)"
  warning-soft: "oklch(0.940 0.050 78)"
  danger: "oklch(0.545 0.190 24)"
  danger-soft: "oklch(0.925 0.050 24)"
  focus: "oklch(0.500 0.105 195)"
typography:
  display:
    fontFamily: Geologica
    fontSize: 2rem
    fontWeight: "620"
    lineHeight: 2.25rem
    letterSpacing: -0.035em
  title:
    fontFamily: Geologica
    fontSize: 1.25rem
    fontWeight: "590"
    lineHeight: 1.55rem
    letterSpacing: -0.02em
  heading:
    fontFamily: Geologica
    fontSize: 1rem
    fontWeight: "580"
    lineHeight: 1.3rem
    letterSpacing: -0.012em
  body:
    fontFamily: Atkinson Hyperlegible Next
    fontSize: 0.9375rem
    fontWeight: "400"
    lineHeight: 1.4rem
  body-sm:
    fontFamily: Atkinson Hyperlegible Next
    fontSize: 0.8125rem
    fontWeight: "400"
    lineHeight: 1.15rem
  label:
    fontFamily: Atkinson Hyperlegible Next
    fontSize: 0.6875rem
    fontWeight: "650"
    lineHeight: 0.9rem
    letterSpacing: 0.075em
rounded:
  xs: 0.1875rem
  sm: 0.375rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
  4xl: 64px
components:
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    borderColor: "{colors.rule}"
    rounded: "{rounded.md}"
    padding: "{spacing.xl}"
  button-primary:
    backgroundColor: "{colors.command}"
    textColor: "{colors.surface-raised}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    height: 36px
    padding: 0 16px
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    borderColor: "{colors.rule-strong}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    height: 36px
    padding: 0 16px
  field:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    borderColor: "{colors.rule}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: 38px
    padding: 0 12px
  operator-sigil:
    backgroundColor: "{colors.signal-soft}"
    textColor: "{colors.signal}"
    borderColor: "{colors.rule}"
    rounded: "{rounded.sm}"
  gate:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.ink}"
    borderColor: "{colors.warning}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
---

## Brand & Style

Helmryth is a light-first operating surface for autonomous work. Its identity combines the precision of an instrument panel with the humanity of an annotated field notebook. The interface is dense enough for serious work but never visually anxious. The memorable element is the **score line**: a fine, living signal connecting operators, gates, tools, and outcomes.

The master tagline is **“The work moves. You hold the helm.”** Supporting copy is factual and active: persistent operators, real tools, visible decisions.

## Colors

Warm mineral neutrals dominate. Vermilion is command: selected actions, consequential buttons, and the Helmryth mark. Petrol is signal: connected, live, streaming, or focused. Neither accent may become a page background. Semantic fills are pale and bordered; status must also include iconography or text.

Dark mode is not part of the initial Helmryth identity. Do not preserve the inherited Midnight skin or the pixel-sampled Grok palette. Never use pure black, pure white, purple-blue gradients, neon, or glow.

## Typography

Geologica gives headings a shaped, engineered voice; Atkinson Hyperlegible Next keeps long workstreams readable and accessible. Product UI uses a five-step hierarchy, not a cloud of near-identical text sizes. Labels may use uppercase only when shorter than three words.

Do not use Inter, system UI, Space Grotesk, Instrument Sans, monospace-as-technology, gradient text, or oversized marketing typography inside the application.

## Layout & Spacing

The application uses an asymmetric three-zone shell: a narrow score rail, a flexible roster/workstream column, and an optional trace/workbench surface. Separation comes from fine rules and rhythm, not nested cards. Use the 4px spacing system and favor `gap` over margins.

On narrow screens, the score rail becomes a compact bottom score and secondary surfaces become full-screen sheets. No critical action disappears.

## Elevation & Depth

Depth is quiet and physical. Use a 1px warm rule, a subtle tonal surface shift, and at most one low-opacity shadow for floating menus. Modals are reserved for destructive confirmation, authentication, or truly blocking gates. No glassmorphism or decorative blur.

## Shapes

Corners are tailored rather than pillowy: 6px controls, 8–12px work surfaces, pills only for compact state chips. The Helmryth mark and operator sigils use square geometry, clipped corners, and braided diagonals. Avatars are abstract instruments, never faces, animals, blobs, or placeholder initials in circles.

## Components

### Score Rail

The score rail is the primary global navigation. Each destination pairs a line icon with a direct Helmryth term: Roster, Crews, Cadences, Capabilities, Operations map, and System. Active state uses ink weight, a small vermilion notch, and an accessible label—not a glowing background.

### Operator Sigils

Every operator receives a deterministic sigil composed from a frame, weave, and pulse. Activity changes the pulse pattern and accessible status label, not the identity. User-supplied portraits remain supported but are cropped into the same tailored frame.

### Workstreams

Messages sit directly on the canvas with alternating alignment, measured line length, and sparse tonal plates. Tool activity, files, decisions, and gates use distinct document-like structures. Avoid generic rounded chat bubbles for every event.

### Gates

Gates state the requested action, resource, consequence, and requesting operator before controls. “Allow once” is the emphasized action; persistent grants are progressively disclosed.

### Empty States

Every empty state teaches one concrete next action and shows an example grounded in the current surface. Never use “Nothing here yet,” generic sparkle art, or fake sample metrics.

## Do's and Don'ts

- Do make running work, waiting work, and blocked work distinguishable without color.
- Do use precise, accountable language and visible consequences.
- Do preserve keyboard operation, focus visibility, reduced motion, and 4.5:1 text contrast.
- Do keep legal attribution and third-party notices accurate.
- Don't use “bot,” “assistant,” “copilot,” “AI-powered,” “supercharge,” “unlock,” or “magic” in product copy.
- Don't use sigil faces, emoji icons, card grids, glass, glow, dark command-center styling, or purple-blue gradients.
- Don't hide complexity behind vague labels; use progressive disclosure with exact wording.
