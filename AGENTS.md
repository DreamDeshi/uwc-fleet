\# UWC Fleet Agent Instructions



\## Required context



Before analysing or changing this project, read the private references from

the directory specified by the `UWC\_REFS\_DIR` environment variable.



Read in this order:



1\. `UWC\_MASTER\_PROJECT\_DOCUMENT.md`

2\. `CLIENT\_ANSWERS\_R1\_2026-07-24.docx`

3\. `CLIENT\_ANSWERS.md`

4\. `UWC\_OPEN\_QUESTIONS.md`

5\. `QUESTIONS\_FOR\_TEH\_R2.md`

6\. `uwc-spec.private.json`

7\. `TRUCK BOOKING SYSTEM (YS).xlsx`

8\. `TRUCK BOOKING SYSTEM (YS) - 2026-07-16.xlsx`

9\. Repository file: `docs/uwc-spec.json`



If `UWC\_REFS\_DIR` or a required reference is unavailable, stop and tell the

user. Do not guess the missing rule.



Some files may overlap historically. Prefer the latest explicit client answer

over an older summary.



\## Requirement authority



Use this authority order:



1\. Mr. Teh's written answers and emails.

2\. These client-authored workbook sheets:

&#x20;  - `TEST QUERY`

&#x20;  - `TEST TO REQUESTOR`

&#x20;  - `INTERNAL LORRY RATE`

3\. `UWC\_MASTER\_PROJECT\_DOCUMENT.md`, client-answer records and open-question

&#x20;  files as internal summaries.

4\. `uwc-spec.private.json` and `docs/uwc-spec.json` as implementation records.



The following are not authoritative client requirements:



\- `AUTO DISPATCH LOGIC` — AI-generated design advice

\- `Admin accept` — AI-generated design advice

\- `Sheet1` — dispatcher scratchpad



Never elevate those three sources into requirements unless Mr. Teh independently

confirms the same behaviour in writing.



If two authoritative sources conflict, identify the conflict and stop before

implementing the affected behaviour.



\## Confidentiality



This repository is public.



Never:



\- Copy or commit files from `UWC\_REFS\_DIR`.

\- Commit customer lists, production database dumps, private specifications,

&#x20; employee identities, telephone numbers, client emails or NDA-adjacent data.

\- Create another project-context file inside the repository.

\- Use real private customer or employee data in tests.

\- Paste unnecessary private quotations into source-code comments.

\- Expose secrets, environment files, credentials or production data.



Use anonymised or synthetic fixtures in public code and tests.



\## Frozen work



Do not implement an unresolved item merely because there is a plausible

technical answer.



Unless a latest written client answer explicitly resolves it, keep these frozen:



\- Rate-tier calculation for a trip with stops on both sides of 18:00:

&#x20; per-stop rate versus a single rate for the entire trip, and the timestamp

&#x20; that selects a whole-trip rate.

\- Partial-delivery incentive when an admin cancels an in-progress trip.

\- Failed-delivery payment behaviour not explicitly confirmed in writing.

\- Driver and lorry swapping where the incentive-rate source is unresolved.

\- Multiple-pickup sequencing where pickups and deliveries may be mixed.

\- Items still listed in `QUESTIONS\_FOR\_TEH\_R2.md`.

\- Prisma schema changes and database migrations.



`api/prisma/schema.prisma` must not be changed, migrated or committed without

explicit user approval.



When a task touches frozen work, explain the missing decision and stop.



\## Git safety



Before making changes:



1\. Run `git status`.

2\. Confirm the current branch.

3\. Identify existing user or other-agent changes.

4\. Read the relevant authoritative requirement.



Rules:



\- Work only on the current feature branch.

\- Never commit or push directly to `main`.

\- Never deploy unless explicitly requested.

\- Never discard, overwrite or reformat unrelated changes.

\- Never use destructive Git commands without explicit permission.

\- Keep commits limited to one coherent task.

\- Review the staged diff before every commit.

\- Do not commit automatically when the user asks only for a review.



\## Money and dispatch safety



Changes involving incentives, rates, deductions, destination points, trip

completion, POD approval, capacity or dispatch require:



1\. An authoritative source.

2\. A written explanation of the proposed behaviour.

3\. Boundary and regression tests.

4\. Relevant test-suite verification.

5\. User confirmation before committing if behaviour changes or remains

&#x20;  ambiguous.



Do not implement behaviour derived solely from AI-generated workbook advice.



\## Two-agent collaboration



Claude Code and Codex use separate worktrees.



They cannot see each other's uncommitted files. A handoff must identify a Git

commit hash.



When reviewing another agent's implementation:



1\. Identify the commit and its parent.

2\. Review the exact diff.

3\. Check it against authoritative sources.

4\. Separate bugs from optional improvements.

5\. Run relevant existing tests.

6\. Add missing tests only when authorised.

7\. Do not silently rewrite the other agent's implementation.



Avoid having both agents modify the same feature simultaneously.



\## Testing



Install dependencies with the existing lockfile:



`npm ci`



Run the relevant unit tests, builds and type checks before reporting completion.



Do not run integration tests from both worktrees simultaneously. Both use the

same Docker PostgreSQL service on port `55432` and may collide.



Do not run `npm audit fix --force` without explicit approval.

