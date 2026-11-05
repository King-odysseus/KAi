---
name: license-attribution-checker
description: This skill should be used when the user asks KAI to "check licences", "check attribution", "are we allowed to use this", "find copied code", or "avoid a licence lawsuit". Checks that every dependency, bundled asset, font, image, model and pasted snippet has a licence that allows the way the app uses and ships it, and that the required notices are present. Read-only.
version: 0.1.0
---

# License and Attribution Checker

Unlicensed or wrongly licensed material is the most common way a small app ends up in a legal dispute. Code, fonts, icons, images, sounds, datasets and AI models all carry terms.

## Boundary

- Read-only. Do not edit files, remove anything, or contact a licensor.
- Report what the files and registries say. Whether a use is lawful is a decision for the owner and, for anything doubtful, a lawyer. Say so; do not give a legal verdict.
- Never copy a licence text or a third-party file into a finding. Name it and cite where it lives.

## What to check

1. **Declared dependencies** - read the lockfile and each package's licence field (`npm ls`, `pip show`, `cargo metadata`, `go-licenses`, or the registry page when offline tools are missing). List every licence found and group them.
2. **Fit with the product** - compare each licence with how the app is shipped (closed source, open source, SaaS, installed app). Flag strong copyleft (GPL, AGPL, SSPL, EUPL) in a closed product, non-commercial or no-derivatives terms (CC-BY-NC, CC-BY-ND), and packages with no licence at all, which means all rights are reserved.
3. **Bundled assets** - fonts, icons, images, audio, video, templates and sample data in the repo. For each, find where it came from and its terms. An asset with no recorded source is a finding.
4. **Models and datasets** - model weights and training data often carry their own terms (research-only, no commercial use, output restrictions). Check the model card or licence file.
5. **Copied code** - look for pasted snippets with another project's header, a Stack Overflow link, a vendored folder, or a minified file with a licence banner. Check the original's terms and whether the required notice was kept.
6. **Notices** - confirm the notices the licences require are actually shipped: a third-party notices file, a licence file for the app itself, copyright lines, and an about screen where one is expected. Check the packaged build, not only the repo.
7. **Own licence** - confirm the project states its own licence and that it does not contradict what it depends on.

## Grounding rules

- Cite `file:line` or the package name and version for every finding.
- Separate "no licence found" from "licence found and incompatible"; they need different fixes.
- Say what you could not check (private packages, no network, binary blobs) instead of reporting it as clean.

## Report

Finish with `write_report` (`kind: audit`): a table of licence, packages and assets using it, then findings ranked by risk with the smallest fix (replace, attribute, relicense, or get permission), and a list of what was not verified.
