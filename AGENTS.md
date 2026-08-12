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



Before writing or trusting ANY test, read "A BEHAVIOUR TEST IS NOT ENOUGH —

ASSERT THAT THE GUARD IS REACHED" below. A green suite proving a guard that

nothing calls has shipped here THREE TIMES IN ONE DAY under three different

names: a vacuous scan, a tautological pin, and an unreached branch.



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

\- Interplant SCORING — R5 A2's "a round trip is TWO bookings", i.e. 1 point per

&#x20; completed round trip (legs ÷ 2). NOT built. Interplant is bookable in

&#x20; production today, so a completed round trip currently scores per LEG.

&#x20; (The 28 Jul fleet / interplant workbook changes are NOT frozen — see below.)

\- Prisma schema changes and database migrations.



\#### NOT frozen: the 28 Jul 2026 fleet / interplant workbook changes



This list carried that hold until 11 Aug 2026, long after it had lifted, and it

sent a review hunting for a fleet migration that had already run. It is recorded

here so it is not re-added:



\- The hold lifted when Mr. Teh answered the R3 §A questions (29 Jul 2026).

\- The fleet data SHIPPED the same day — PR #37, `f616f85`, prod migration

&#x20; applied. Production's nine plates and rates match `docs/uwc-spec.json`

&#x20; exactly, PSA 5292 and the PPE 2406 5t-17.5ft reclassification included.

\- The interplant RATES shipped 11 Aug 2026 (PR #142) and the values were

&#x20; written to production (PR #143): PLX 2406 = 6/8, PPE 2406 = 5/7, the other

&#x20; seven NULL by design so a cross-assigned backup takes the fallback.



What remains unbuilt is interplant SCORING only, listed above.



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



\#### CI runs the browser suite with the FEATURE FLAGS ON — green is not "what prod does"



The `E2E (Playwright, real browser — FEATURE FLAGS ON)` job sets

`FEATURE_EXCEPTIONS` and `FEATURE_CHANGE_REQUESTS` (and their `EXPO_PUBLIC_`

twins) to `true`. **Production has them unset**, so those surfaces are dark for

real users today. A green tick on that job tells you the FLAG-ON world works; it

tells you nothing about what a requestor or driver sees right now.



This is deliberate, not an oversight. Flags-off behaviour is already covered

where it belongs — the API's own gating tests assert every gated route 404s

while its flag is off. The exception workflow's driver sheet, admin lane and

requestor banner have no other cover at all, and they are the next thing due to

be switched on; running them dark would mean flipping a flag in production with

five specs that had never once executed.



If you are using CI to decide whether a change is safe to deploy, read the

flag-gating tests in the fast job for prod behaviour, and this job for what

happens after the switch.



Two other things that job does on purpose, so nobody "fixes" them:



\- It widens the FIXTURE TRUCK's operating window to 24h for the run

&#x20; (restored in teardown) rather than freezing the clock. Assignment 409s on a

&#x20; pickup outside the truck's hours, the seeded window is 07:00–02:00 MYT, and

&#x20; runners are UTC — so a fifth of the day a today-scheduled seed would fail.

&#x20; The window RULE keeps its own cover in `operatingWindow.spec.ts`, which

&#x20; narrows a truck deliberately. Never reach for a fake clock here: the server

&#x20; derives the window, the rate tier, the daily reset and every arrival stamp

&#x20; from its clock while the driver Home decides "today" from the browser's, so

&#x20; freezing one invents a skew production never has, and freezing both hides the

&#x20; off-peak and midnight defects the suite exists to catch.

\- It builds a STATIC web export rather than running `expo start --web`. The dev

&#x20; server rebuilds lazily — on a cold runner the first navigation can outlive

&#x20; the test timeout — and it has served a stale bundle before.



\#### Prove every guard by breaking the thing it guards



A guard that has never gone red is not a guard, it is a decoration. Before you

rely on one — a CI check, a lint rule, an assertion, a schema constraint —

REINTRODUCE THE BUG IT EXISTS FOR and confirm it fails. Then undo that.



This is not hypothetical. The e2e selector-drift guard was written after the

driver suite sat red for a week because a redesign renamed every label it

clicked. The first version checked that each selector matched a string in

`en.json` — and it PASSED the broken selectors, because `driver.todaysAssignments`

("Assignments") and `driver.viewNavigation` ("View Navigation") were still sitting

in all three locale files after the code that rendered them was deleted. It would

have shipped green and guarded nothing. Putting the two old selectors back was

what exposed it; the fix was to match only copy whose key is REFERENCED in

`mobile/src`.



The same rule caught tests that could not fail: a `not.toBeVisible()` assertion

against `"Trip Completed!"`, a dead key that can never render, so it passed no

matter what the app did. Ask of any test or guard: WOULD THIS GO RED IF THE

THING IT PROTECTS WERE REVERTED? If you cannot say yes from having watched it,

you do not know.



\#### A BEHAVIOUR TEST IS NOT ENOUGH — ASSERT THAT THE GUARD IS REACHED



A correct function on an unreachable path passes everything. This happened

THREE TIMES ON 11 AUG 2026 alone, each time with a fully green suite:



\- the interplant FALLBACK pin — the suite could not tell "reads the truck's own

&#x20; rate" from "always uses the fallback", because every fixture expected the

&#x20; same number by three separate routes. 1254/1254 green with the truck's own

&#x20; rate ignored entirely.

\- the stale-spec GATE — a targeted run of a money pin passed 22/22 against

&#x20; generated data that `gen:spec` had never rewritten, because the sync test

&#x20; lived in a file that run did not include.

\- the quarantine BRANCH in `scopedStorage` — unit-tested and correct, but every

&#x20; call site ran AFTER a user was set, so it was dead code. The next driver to

&#x20; sign in would have adopted the previous driver's queued PODs.



In all three the unit tests called the function DIRECTLY, and nothing asserted

that anything else did.



So, for any guard, fallback or safety branch:



1\. Test the behaviour, as always.

2\. ALSO assert the guard is REACHED — that a real call site invokes it, on the

&#x20; path where it matters.

3\. Prove that assertion by REMOVING THE CALL SITE, not by breaking the logic.



Step 3 is the whole point. **Breaking the logic proves the test can SEE the

function. Removing the call proves the function is IN THE PROGRAM.** Only the

second catches dead code, and dead code is what all three of these were.



This is one failure wearing different names — a VACUOUS SCAN (a source scan

whose pattern matches nothing, so it passes on an empty set), a TAUTOLOGICAL PIN

(an expected value that arrives by more than one route, so it holds either way),

and an UNREACHED BRANCH (correct code nothing calls). Recognise it by the

symptom: the suite is green and you cannot name the line that would turn it red.



\#### A PROD PROBE ASSERTS IDENTITY FIRST — AN EMPTY ANSWER IS NOT A FINDING



Same family, different door. On 12 Aug 2026 an authorised read-only probe of

production was run with the Railway CLI still linked to `uwc-fleet-demo`. It

connected, authenticated, and answered:



&#x20;   The table `public.User` does not exist in the current database.



A clean, confident answer — from the wrong database. Read as a finding it would

have meant "production has no users". A later attempt against a different proxy

authenticated fine and returned a real number, and NOTHING in either result said

"you are not where you think you are". What caught it was adding an identity

check and re-running, not anything the CLI reported.



So, for ANY probe, dump, count or manual query against production:



1\. ASSERT IDENTITY BEFORE REPORTING ANYTHING — the nine fleet plates AND the

&#x20;  four-figure consignee count (1564 at the last read). The demo instance is

&#x20;  deliberately re-plated `UWC 1001`–`1009`, so the plate list separates the two

&#x20;  unambiguously. Make the probe EXIT on a mismatch; do not leave it to the

&#x20;  reader to notice.

2\. TREAT AN EMPTY ANSWER AS UNVERIFIED until identity has passed. No rows, a

&#x20;  missing table, a zero count — "there is nothing there" and "I am not there"

&#x20;  are the same observation until you have proved which one it is. This is the

&#x20;  rule: a query that returns nothing has measured nothing.

3\. SAY WHICH INSTANCE YOU READ in the same breath as the number, every time.

4\. Never print a connection string, a password or a token. Mask the password if

&#x20;  you must show the target at all.



Recognise the shape: a well-formed, confident answer that is about the wrong

thing — the stale build, the vacuous scan, and this.



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



\#### Two Git commands that lose or smuggle work SILENTLY



Both fail without an error, and both were caught only because someone happened

to look. Neither is detectable by reading the diff you intended to make.



\- **ALWAYS NAME THE BASE: `git checkout -b <new> main`.** A bare

&#x20; `git checkout -b <new>` branches off wherever HEAD happens to be. On 4 Aug

&#x20; 2026 that put an auth-policy commit — lowering `PASSWORD\_MIN\_LENGTH` and

&#x20; removing `password123` from the weak list — inside **PR #108**, which was

&#x20; titled and merged as UI clipping fixes. CI was green and the end state was

&#x20; wanted, so nothing broke; it was a TRANSPARENCY failure, which is the kind

&#x20; that is easy to shrug off and should not be. Before pushing, check what is

&#x20; actually on the branch: `git log --oneline origin/main..HEAD`. If it lists a

&#x20; commit the PR description does not mention, split it or rewrite the

&#x20; description.



\- **NEVER MOVE AN UNCOMMITTED EDIT WITH `git checkout <branch> -- <file>`.**

&#x20; That command silently DISCARDS your uncommitted changes to that file and

&#x20; replaces it with that branch's version — which is usually OLDER. On 12 Aug

&#x20; 2026, moving a docs edit onto its own branch this way destroyed the edit AND

&#x20; restored an AGENTS.md predating PR #144, which would have reinstated the

&#x20; stale "fleet update ON HOLD" entry that #144 had just removed — reintroducing

&#x20; a retired hold as a side effect of tidying a branch. It was caught only by

&#x20; grepping for the stale phrase before committing, which is a check that works

&#x20; only when someone thinks to run it.

&#x20; Use `git stash` (then `git stash pop` on the target branch) or

&#x20; `git diff > /tmp/x.patch` + `git apply`. Both PRESERVE the edit; the checkout

&#x20; form has no undo, because the content was never in Git.



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
&#x20; EXCEPTION — the three GREETING HOME screens (driver, requestor, admin)
&#x20; carry NO logo at all (owner, 9 Aug 2026: "i told u the header should look
&#x20; similar to driver and requestor. they dont have logo anymore"). Driver and
&#x20; requestor had already dropped theirs; the admin home was the last one
&#x20; holding a mark and was brought into line. The rule above still governs the
&#x20; STACK headers (`AdminMobileHeader` and friends) — do not strip those.
\- The LOGIN screen, ON A PHONE, is a LIGHT screen carrying the full COLOUR logo
&#x20; (`BrandLogo` default, height 84) centred over two pale decorative discs —
&#x20; owner ruling 9 Aug 2026, adopting the admin design pack's frame 17.
&#x20; This SUPERSEDES the 29 Jul 2026 ruling (white logo on a blue panel), which
&#x20; had itself replaced an earlier colour-logo rule. Both were the owner's; the
&#x20; later one governs. The blue brand panel SURVIVES on DESKTOP (≥1024px),
&#x20; where it is a column beside the form rather than a header above it, and it
&#x20; still carries `BrandLogo white`.
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

