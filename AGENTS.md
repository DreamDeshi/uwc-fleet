\# UWC Fleet Agent Instructions



\## Required context



Before analysing or changing this project, read the private references from

the directory specified by the `UWC\_REFS\_DIR` environment variable.



Read in this order:



1\. `UWC\_MASTER\_PROJECT\_DOCUMENT.md`

2\. `CLIENT\_ANSWERS\_R1\_2026-07-24.docx`

3\. `CLIENT\_ANSWERS.md`

4\. `OPEN\_ITEMS.md`

5\. `QUESTIONS\_FOR\_TEH\_R3.md`

6\. `uwc-spec.private.json`

7\. `TRUCK BOOKING SYSTEM (YS).xlsx`

8\. `TRUCK BOOKING SYSTEM (YS) - 2026-07-16.xlsx`

&#x20;  and `TRUCK BOOKING SYSTEM (YS) - 2026-07-28.xlsx` (the revised fleet /

&#x20;  interplant workbook — every dated copy is authoritative for its era;

&#x20;  the newest dated copy wins where they differ)

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

\- Items still listed in `QUESTIONS\_FOR\_TEH\_R3.md` (the successor to the

&#x20; retired R2 doc).

\\- ✅ UNFROZEN 29 Jul 2026 — the 28 Jul fleet / interplant workbook changes.

Mr. Teh answered all twenty R3 questions that day (CLIENT_ANSWERS.md), which

was the stated condition. The fleet update shipped in PR #37; interplant pay is

built behind `FEATURE_INTERPLANT`.

\- ⚠ STILL FROZEN, and it is NOT the whole feature: whether an interplant round

trip is ONE booking with two legs or TWO bookings paid once between them.

Nothing in the code detects a round trip, so a one-way leg pays a full point

and the two-booking shape pays twice. `FEATURE_INTERPLANT` must stay OFF until

Mr. Teh answers. What a SWAPPED-IN lorry earns on a plant run is also

unpublished — only PLX 2406 and PPE 2406 have interplant rates.

\- Prisma schema changes and database migrations.



`api/prisma/schema.prisma` must not be changed, migrated or committed without

explicit user approval.



\### Merging a migration to `main` applies it to production immediately



There is NO gate between the merge and production DDL. `api/railway.json` sets

`preDeployCommand: npm run migrate:deploy` and Railway auto-deploys `main`, so a

migration runs against the production database as soon as the pull request is

merged. Nobody approves it, nobody runs it by hand, and there is no staging

database in between. `main` requires zero approving reviews, so in practice the

author of a migration is its only reader.



Consequences to treat as rules:



\- A migration on a pull request is a production change that is already

&#x20; half-committed. Read the generated SQL line by line before merging — not

&#x20; after. Confirm that any data loss is intended and say so in the pull request.

\- `prisma migrate diff` output is a DRAFT, never a final artefact. It has

&#x20; repeatedly tried to drop `ExceptionEvidence_action_same_exception_fkey`, a raw

&#x20; composite FK that is invisible to Prisma. Always re-read generated SQL for

&#x20; that line and remove it.

\- Destructive statements have shipped this way before — for example

&#x20; `20260718000000_remove_jh_sl_zones` runs `DELETE FROM "DestinationRate"`, a

&#x20; money table. Care was taken, but nothing enforced it.

\- Do NOT "fix" this by moving `migrate:deploy` out of `preDeployCommand`. That

&#x20; hook is what guarantees the schema is migrated BEFORE the new code serves

&#x20; traffic; removing it trades a rare risk for a routine one (live code querying

&#x20; a table that does not exist yet).



\#### The destructive-SQL guard



CI job "Migration safety (destructive SQL guard)" — a required check — reads

every committed `migration.sql` as text and FAILS on a destructive statement

that carries no written reason. Run it yourself with

`npm run check:migrations --workspace api`.



Covered: `DROP TABLE / COLUMN / CONSTRAINT / INDEX`, `DROP` of a type, schema,

view, sequence, trigger or function, bare `ALTER TABLE … DROP`, `TRUNCATE`,

`DELETE FROM`, and `UPDATE … SET`. DML is included deliberately: most of this

repo's genuinely destructive statements are `DELETE`/`UPDATE`, and one of them

deletes from `DestinationRate`, a money table.



To allow an intended loss, put the override immediately ABOVE the statement —

not blanket at the top of the file, which is rejected:



&#x20;   -- DESTRUCTIVE-OK: why this data may be destroyed

&#x20;   DELETE FROM "Zone" WHERE "code" IN ('JH', 'SL');



KNOWN UNCOVERED — the guard does not see these, so they remain your judgement:



\- Statements that are destructive by LOCKING rather than by dropping: adding a

&#x20; NOT NULL column with a default, `SET NOT NULL`, or a `CREATE INDEX` without

&#x20; `CONCURRENTLY` on a large table. Any of these can stall production with no

&#x20; destructive keyword present.

\- Type-narrowing `ALTER COLUMN … TYPE` casts, which can silently truncate.

\- Whether a migration is REVERSIBLE. Nothing here writes a down-migration.



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
\- RUNTIME CONFIG MUST COME FROM `expo.extra`, NEVER FROM A NATIVE CONFIG
&#x20; BLOCK. EAS Update strips `android.config` and `ios.config` out of the OTA
&#x20; manifest — native config cannot change over the air, so it is not served.
&#x20; In a build with `expo-updates`, `Constants.expoConfig` is read from the
&#x20; APPLIED UPDATE, not from the config compiled into the binary, so
&#x20; `Constants.expoConfig.android.config.*` reads back `undefined` on any APK
&#x20; that has taken an OTA — even though the value IS in the built manifest and
&#x20; the native feature works.
&#x20; This fails SILENTLY and looks like a broken feature, not a broken config:
&#x20; it disabled every driver and requestor map for days (29 Jul 2026) while the
&#x20; admin fleet map, which never consulted the flag, kept rendering.
&#x20; Survives the manifest: `extra.*`, `version`, `runtimeVersion`, `slug`,
&#x20; `scheme`, `ios.bundleIdentifier`, `android.package`. Stripped:
&#x20; `android.config`, `ios.config`.
&#x20; If a running app needs to know about native config, MIRROR it into
&#x20; `expo.extra` and pin the mirror with a test — see
&#x20; `mobile/src/lib/appConfig.test.ts`, which fails the build if the mirror and
&#x20; the real value drift apart.

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
&#x20; `BrandLogo mark`), placed LEFT of the title. No avatar/name blocks in
&#x20; headers.
\- The LOGIN screen carries the full WHITE logo (`BrandLogo white`) on its blue
&#x20; panel — owner ruling 29 Jul 2026, adopting the driver design pack's
&#x20; frame 01. This REPLACES the earlier rule that login kept the full-colour
&#x20; logo; the colour logo no longer appears on that screen at all.
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

