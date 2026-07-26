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



\## UI and design work

These constraints bind ANY agent editing the mobile app's UI (including
external design tools with repository access). They are invisible in a plain
read of the diff and violating them breaks the deployed app.

Platform:

\- The app is React Native (Expo SDK 54) rendered with react-native-web.
&#x20; Use RN primitives only — no raw HTML elements, no CSS files, no
&#x20; DOM-only libraries. Styling goes through `StyleSheet` / the shared
&#x20; theme tokens in `mobile/src/theme`.
\- Do NOT add `react-native-svg` (repeatedly rejected; crashes our build).
&#x20; Icons come from `@expo/vector-icons` (Ionicons).
\- Do NOT touch native dependency pins (`expo-font` is deliberately pinned;
&#x20; changing it reintroduces a known APK launch-crash).
\- Code runs on Hermes — no dynamic `import()` tricks, no `Intl` beyond what
&#x20; Hermes provides.

Text and layout:

\- EVERY user-visible string goes through i18n. A new string must be added to
&#x20; ALL THREE files: `mobile/src/i18n/en.json`, `ms.json`, `zh.json`.
&#x20; Hard-coded literals in JSX are a defect.
\- The app has TWO layouts: the phone layout (primary, bottom tabs) and the
&#x20; desktop shell at ≥1024px (`useWide`, sidebar). A UI change must be checked
&#x20; in both; do not break one to restyle the other.
\- Small utilities are embedded as widgets on existing screens, never given
&#x20; their own navigation tab or screen.

Standing owner design rulings (do not revert):

\- Headers use the WHITE mark-only logo crop (`uwc-mark-white.png` via
&#x20; `BrandLogo mark`), placed LEFT of the title; the login screen keeps the
&#x20; full colour logo. No avatar/name blocks in headers.
\- No yellow underline accents on mobile headers.
\- Requestor home keeps the navy/dashed card style.
\- Orange is reserved for offline/queued states only — never as a general
&#x20; accent colour.
\- One design language app-wide: flat blue headers; tables collapse to cards
&#x20; on narrow widths.

Process for design changes:

\- Branch + pull request only. `main` is branch-protected (required PR + green
&#x20; CI, admins included); merging deploys to the live trial.
\- Run `npm run typecheck` and `npm test` in `mobile/` before proposing.
\- Do not modify money, dispatch, or API code as part of a visual pass.

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

