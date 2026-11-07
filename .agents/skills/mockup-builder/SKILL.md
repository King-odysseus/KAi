---
name: mockup-builder
description: This skill should be used when the user asks KAI to "build this screen from the mockup", "turn this design into code", "implement this page from the design", or points at a design frame or screenshot. Builds the screen with the project's own components and tokens, then checks it against the design in a real browser. Changes product code.
version: 0.1.0
---

# Mockup Builder

The design is the target. Match it, using the project's own parts.

## Boundary

- Use the project's existing components, tokens and icon set. Do not add a new UI library or hard-code colours that a token already covers.
- Build the screen the design shows. Do not redesign it. List anything in the design that cannot be built as drawn.
- Do not change unrelated screens.

## Workflow

1. Read the design (the design tool's frame if it is connected, else the screenshot the user gave). List the parts on the screen: layout, components, states, text, spacing, colours, radii.
2. Read the project for the components and tokens that already cover those parts. Reuse them.
3. Build the screen, including the states the design shows (empty, loading, error, hover, selected) where it shows them.
4. Start the app locally and open the screen in a real browser. Compare it to the design at the same width and list every visible difference.
5. Fix the differences, and repeat until none that matter remain. Check a narrow width too.
6. Run the project's check command.

## Grounding rules

- Compare with screenshots, not memory. Cite which one you compared.
- Report differences you chose not to fix, and why.
- Say which states or widths you did not check.

## Report

Finish with `write_report` (`kind: build`, a specific title): the screen built, the components reused, remaining differences from the design, and the check result.
