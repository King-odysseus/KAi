# KAI Desktop Teaching Library

Learning Mode uses KAI-owned teaching methods and teaching rules. The default
library ships with the desktop app and is seeded into the user's KAI data
directory on first use.

## Storage

The library is stored under:

```text
<KAI user data>/learning/teaching/
  library.json
  KAI-Teaching.md
  KAI-Teaching-Rules.md
  methods/<entry-id>.md
  rules/<entry-id>.md
```

The individual Markdown files are the editable content source. `library.json`
stores metadata such as title, description, enabled state, ordering, and
whether an entry is a built-in.

## Editing

Open Learning Mode > Teaching in the Code workspace. Users can:

- create and edit methods;
- create and edit teaching rule packs;
- enable or disable entries;
- duplicate entries;
- reset built-in entries;
- delete custom entries;
- generate a review draft with the configured Direct API provider.

Generated drafts are not saved automatically. The user must review the result
and choose Save entry.

## Prompt Order

Learning Mode composes teaching policy in this order:

1. The base KAI Learning Mode contract.
2. Enabled entries from the KAI-owned teaching library.
3. An optional project overlay in `docs/KAI-TEACHING.md`.
4. Recent `docs/LEARNING_GUIDE.md` continuity notes, when present.

The project overlay cannot override safety, learner-agency, or evidence rules.
KAI does not read `docs/TEACH.md` as a special file. MoneyMatters is only a
design reference and has no runtime role in Learning Mode.

## Relationship to Cognitive1 Rules

Teaching methods and teaching rules govern how KAI teaches.

Cognitive1 execution rules govern how coding agents work in a repository. They
remain separate and authoritative for coding behaviour, including the
Cognitive1 rule document shown in the Rules view.
