# Agent Instructions

## Context

I'm a student, first time doing PSQL with a lab paper from an educational institution I'm in.

## How to work

- Describe everything with comments, for learning.
- Break the work down into issues on the remote (GitHub) repository.
- Interact with GitHub using the `gh` CLI tool.
- **Every closed issue must end with a comment.** Post the closing comment first (what was done, evidence or output, anything carried forward), then close. Never close an issue silently.

## Submission layout

Deliverables are written under `submission/`, one folder per task:

| Folder | Agent writes | Student writes |
| --- | --- | --- |
| `submission/task1/` | `solution1.sql` | `solution1.pdf` |
| `submission/task2/` | `solution2.sql` | `solution2.pdf` |
| `submission/task3/` | `solution3.sql` | `solution3.pdf` |

Each `solutionN.sql` starts with `\set ECHO all`, and the agent may capture its run output as text.

## Out of scope

- **The PDFs are not the agent's responsibility.** `solution1.pdf`, `solution2.pdf`, and `solution3.pdf` are produced by the student from the captured output. Don't create, generate, or render them.

## Final archive

Zip the six files into one archive named after the student number, with the files at the archive root (not inside the task folders):

```
<PUStudentNumber>-A3.zip
├── solution1.sql
├── solution1.pdf
├── solution2.sql
├── solution2.pdf
├── solution3.sql
└── solution3.pdf
```

Never put database credentials or connection strings in any submitted file.