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

&#x20; (Interplant SCORING used to be listed here. It is BUILT — see below.)

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



\- Interplant SCORING shipped 12 Aug 2026 — PR #147, `7603a0e`.

&#x20; `tripFinalize.ts` passes `roundTripHalving: pool === "interplant"` into

&#x20; `calculateDeliveryIncentive`, which floors the day's interplant points at

&#x20; legs ÷ 2. It is LIVE in production.



Nothing on that workbook change is unbuilt now.



\#### RULED BUT UNIMPLEMENTED — THE THIRD FAILURE MODE, AND THE UNWATCHED ONE

Two ways the record and the code disagree are already written down here: a
STALE record trusted too long (interplant scoring, below) and a CORRECT record
trusted too little (the trips date range, under UI). **B6 is the third: a
ruling that was recorded and never built.** Nobody was looking for it, because
both other failures announce themselves — one blocks work that is already done,
the other turns CI red. This one is silent. The app simply keeps doing the old
thing while the answer file says otherwise.

**B6, as it stands on 17 Aug 2026.** Mr. Teh asked US a question on 11 Aug:
*"what is your suggestion if 2am is not convenience? Can we set to 12am?
Because we have one driver working shift is 2pm to 12am"*. The OWNER answered
the same day: **12am, and 12am is when the lorry must be BACK** — the operating
window becomes 07:00–00:00. `CLIENT_ANSWERS.md` records the answer and notes
the fleet is "(seeded 07:00–02:00)".

It still is, in every place that states it:

```
mobile/src/lib/bookingEdit.ts        PICKUP_WINDOW_END_HOUR = 2
api/src/services/operatingWindow.ts  DEFAULT_WINDOW_END = "02:00"
the Truck rows themselves            07:00–02:00
```

**Six days live with a ruling that was recorded and never built**, and it was
found only because a copy pass went looking at whether one hint string was
stale. It was not: `booking.fleetHoursHint` ("Fleet hours 7 AM – 2 AM")
correctly describes what the app DOES. The app is what is wrong.

⚠ **DO NOT "CORRECT" THE COPY TO MIDNIGHT.** That would make a true sentence
false while the picker still offers 23:00, 00:00, 01:00 and 02:00 underneath
it. Fix the window, and the copy follows.

**When it is built** (it is a DISPATCH change — the window decides which
pickups can be assigned at all — so it needs explicit approval and boundary
tests):

- move both constants together, client and server, or the picker and the
  assignment check disagree about the same booking;
- **MOVE THE SEEDED TRUCK ROWS WITH IT.** The per-truck window is data, not a
  constant; changing the default alone leaves nine trucks still open to 02:00;
- 02:00–00:00 shortens the day, so a pickup that was legal yesterday is refused
  today. Check nothing in flight sits in the removed two hours before applying;
- the window WRAPS midnight today (07:00 → 02:00). At 07:00 → 00:00 it stops
  wrapping, and any code that assumes a wrap becomes reachable-dead. Read
  `operatingWindow.ts` for the wrap arithmetic before changing the bound.

**The rule this leaves behind:** when a written answer changes a NUMBER the code
holds, grep for that number the same day and either change it or record why not.
An answer file is not an implementation, and nothing in CI compares the two.

\#### THIS LIST WAS WRONG ABOUT INTERPLANT SCORING FOR FIVE DAYS



Until 17 Aug 2026 the frozen list above said interplant scoring was "NOT built"

and that "a completed round trip currently scores per LEG" — five days after

`7603a0e` made it live. That is the SECOND time in one week this file described

a shipped thing as frozen, after the fleet-migration entry recorded directly

above, and the failure mode is the same both times: a hold that outlives its

reason reads exactly like a live one, so the next agent either re-derives a rule

that already exists or refuses to touch something it should.

It surfaced only because a screen was being made to explain the pay rules and

the engine disagreed with this file — nothing checks it.

So: when you finish work that a frozen entry covers, DELETE THE ENTRY IN THE

SAME PULL REQUEST. A frozen list is only as trustworthy as its most stale line,

and this one now has two corrections in its history where it should have none.



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



A fourth name for the same thing, added 12 Aug 2026 — a HAZARD TEST THAT

AVOIDS THE HAZARD. B7's booking cut-off must not answer for a pickup that is

already in the past, because the route has its own `PICKUP_IN_PAST` and two

differently-worded rejections for one mistake is a defect. That risk was

understood, and a test was written for it — using YESTERDAY as the past pickup.

The bug lived in TODAY: a pickup two hours ago was still "today", so the

cut-off answered first. The test passed, the comment above it described the

hazard correctly, and the hazard was live. It was caught by an unrelated

existing spec (`tripEdit.test.ts`) that had already pinned the right answer.



A test that names a hazard and then picks the input where the hazard cannot

occur passes for exactly the same reason a guard on an unreachable path does —

it never reaches the thing it claims to protect. So when writing one, say out

loud WHICH INPUT triggers the hazard, and check that the input you actually

used is that one. If the case cannot fail while the bug exists, it is not a

test of the bug; it is a note about it.



\#### A GUARD BUILT FROM THE THING IT CHECKS CAN DEGRADE TO ACCEPTING EVERYTHING

The fourth name for the family above, found 17 Aug 2026, and the worst of them:
the previous three were tests that could not SEE a defect. This one was
reachable, ran on every pull request, and actively said the defect was absent.

The e2e SELECTOR-DRIFT GUARD exists to catch a spec locating by copy the app no
longer renders. It compares each literal against en.json, and — so that an
interpolated string can still vouch for a selector — compiles every
`{{placeholder}}` to `.+`. One key is nothing but placeholders:

```
admin.sustainability.heroMonth = "{{month}} {{year}}"   →   ^.+ .+$
```

**Any two words.** From the day that key landed, essentially every multi-word
selector in the suite was "live copy" whatever the app rendered. It approved
`getByText("Booking Submitted!")` minutes before the browser suite failed on
that exact selector, in the same CI run.

**THE MECHANISM IS NOT THE KEY — IT IS DERIVING A MATCHER FROM DATA.** A
literal assertion fails when the code changes. A matcher built from the data it
is checking can be *widened by that data* until it accepts everything, and it
reports that as success. Whenever a guard builds a regex, a set, an allowlist or
a loop out of a corpus, ask the second question: **what does this do if the
corpus is empty, degenerate, or too permissive?** If the answer is "passes", it
is not a guard yet.

Two more instances were found in the same sweep and fixed with POSITIVE
CONTROLS rather than more assertions:

- `i18n/localeParity.test.ts` — all five tests iterate en's key list, so an
  en.json that failed to load would pass every one of them. It now asserts each
  locale carries > 1,000 keys BEFORE comparing them.
- `lib/scopedStorage.test.ts` — the AsyncStorage scan asserts an empty
  offender list, which is also exactly what a walk that visited nothing
  produces. It now records what it visited and asserts it reached every
  allowlisted file.

Both proven by DEGRADING THE DATA, not the logic: empty the corpus, point the
walk at a directory with no source. If your break does not turn the guard red,
check the break applied at all before concluding the guard works.

\#### WHEN A JOB FAILS ON YOUR BRANCH, PROVE IT AGAINST MAIN BEFORE TOUCHING THE TEST

An empty commit on a branch cut from unmodified `main`, pushed as a draft pull
request, runs the same CI on a clean tree. It costs one push and it answers the
only question that matters when a suite goes red on your work: **is this mine?**

On 17 Aug 2026 the browser suite failed on a feature branch. The theory was an
overlay intercepting taps; the artifact refuted it. The next theory was flake,
and a green re-run would have "confirmed" it. The empty-commit control settled
it in one step instead — main PASSED, the branch FAILED TWICE — so the failure
was a regression, the test was left alone, and the branch stayed unmerged.

Use it whenever you are about to say "CI is flaky" or "that is the environment":

```
git checkout -b ci/probe main && git commit --allow-empty -m "ci: probe" && git push
gh pr create --draft --base main --title "ci: probe"      # then close it after
```

⚠ A GREEN RE-RUN SETTLES NOTHING. It is consistent with flake AND with a
regression that failed to reproduce. "Add setup until the test goes green" and
"adjust the test until it stops complaining" are indistinguishable from the
outside — only evidence separates them, and this is the cheapest evidence there
is.

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



\#### A BARE CLI NOUN MAY CREATE — ALWAYS TYPE THE `list` SUBCOMMAND



Same hazard class as the checkout above: a verb that WRITES when you expected it

to READ. On 17 Aug 2026, `railway domain` — reached for to find a database's

proxy host — did not list domains. It GENERATED a public domain on the demo

Postgres service, and reported it like a lookup result:



&#x20;   Service domain created:

&#x20;     URL: https://postgres-production-5d185.up.railway.app



Nothing was exposed (Postgres does not speak HTTP) and it was deleted

immediately with `railway domain delete <host>`, but the safe outcome was luck:

the same verb aimed at a web service would have published it.



The rule, for ANY CLI: when the intent is to INSPECT, type the explicit

subcommand — `railway domain list`, not `railway domain`; `railway variables

list`, not a bare noun you are guessing at. A bare noun is an invitation for the

tool to pick a default action, and defaults on infrastructure tools skew toward

CREATE. Read `--help` before the first use of a verb on a service you did not

create.

&#x20; (Railway specifics: a Postgres service's public host is on the service

&#x20; itself as `RAILWAY_TCP_PROXY_DOMAIN` / `RAILWAY_TCP_PROXY_PORT` — read the

&#x20; variables, never the domain command.)



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
\- ⚠ **`fullPage: true` SILENTLY RETURNS THE VIEWPORT, NOT THE PAGE.** RN-Web
&#x20; scrolls an INNER container, not the document, so Playwright's full-page
&#x20; screenshot has nothing to extend into: it succeeds, writes a normal-looking
&#x20; PNG, and gives you exactly what a plain `screenshot()` would. Nothing warns
&#x20; you, and the file looks correct on its own — you only notice if you already
&#x20; knew what was below the fold. This is the same family as the stale build and
&#x20; the wrong-database probe: **a confident, well-formed answer about less than
&#x20; you asked for.** To capture below the fold, scroll the container
&#x20; (`page.mouse.wheel`) and take successive shots. Found 15 Aug 2026 capturing
&#x20; the admin Performance screen at 1440.
\- ⚠ **A JSX TEXT NODE ACCEPTS ANY STRING, SO A PLACEHOLDER TYPE-CHECKS AND
&#x20; THEN RENDERS.** On 17 Aug 2026 a scripted restructure of the admin Settings
&#x20; screen left four marker tokens behind in the tree — lines that read
&#x20; `ACCOUNT_BLOCK              </View>`. `tsc --noEmit` passed, 680 tests
&#x20; passed, and the build succeeded, because to TypeScript and to React that is
&#x20; simply text and text is what JSX is for. The page then rendered the words
&#x20; ACCOUNT_BLOCK, LANG_BLOCK and UPDATES_BLOCK where three cards should have
&#x20; been. **Only the screenshot caught it.**
&#x20; Same family as `fullPage: true` above, and the same tell: every automated
&#x20; check answered confidently about something OTHER than what was on screen. A
&#x20; type check proves a tree is well-formed, never that it is the tree you meant.
&#x20; Two rules follow:
&#x20; 1. LOOK AT THE RENDERED SCREEN before proposing any layout change — not the
&#x20;    diff, not the test count, the image. This is now the second UI defect here
&#x20;    that was invisible to every check and obvious in a PNG.
&#x20; 2. If you generate or splice JSX with a script, GREP FOR YOUR OWN MARKERS
&#x20;    before building (`grep -c "_BLOCK"`) — nothing downstream will. A marker
&#x20;    that is a bare word is indistinguishable from copy; make it something no
&#x20;    real template could contain.

\- ⚠ **A COMMENT THAT STATES A REASON IS A CLAIM TO DISPROVE, NOT CONTEXT TO
&#x20; WEIGH.** On 17 Aug 2026 the trips toolbar's date range was collapsed behind
&#x20; a pill as part of a design pack. The comment being replaced said, in as many
&#x20; words: the range stays OUT of the disclosure, it defaults to today so it is
&#x20; the one filter that is ALWAYS active, widening it is the common move, and
&#x20; **two e2e specs drive it directly**. That was read, reasoned past ("the board
&#x20; defaults to today, so editing is rare"), and the opposite claim written into
&#x20; the new comment. Those exact two specs went red in CI.
&#x20; The rule: when you are about to contradict a comment that gives a REASON,
&#x20; treat the reason as a claim you must disprove. Check whatever it names FIRST
&#x20; — here one `grep -rn "input\[value" e2e/` would have ended it — and if you
&#x20; still disagree, say so in the commit so the next reader sees a decision
&#x20; rather than a silent reversal.
&#x20; ⚠ This is the FROZEN-LIST failure in reverse, and the pair is the lesson.
&#x20; There (see "THIS LIST WAS WRONG ABOUT INTERPLANT SCORING") the record was
&#x20; STALE and was trusted too long; here it was CORRECT and was trusted too
&#x20; little. Both are the same omission: nobody checked the record against the
&#x20; code before acting. A record is evidence, not an authority and not noise —
&#x20; verify it, then act on what you find.

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
\- **THE VOICE RULE — WRITE LIKE A COLLEAGUE, NOT LIKE A SYSTEM.** Adapted from
&#x20; `github.com/blader/humanizer` (Wikipedia's "Signs of AI writing"), which is
&#x20; written for PROSE. Product copy is not prose: it is read mid-task, one-handed,
&#x20; in a lorry cab in sunlight. Take the judgement, not the substitutions.
&#x20; **What transfers, and what it means here:**
&#x20; 1. ONE IDEA PER STRING. If it needs a semicolon or a second clause, it is
&#x20;    two strings or one shorter thought.
&#x20; 2. EM DASHES ARE TWO SENTENCES PRETENDING TO BE ONE. 107 strings currently
&#x20;    carry one. In prose it is a style choice; in a 13px banner it is a place
&#x20;    the eye trips. Default to a full stop.
&#x20; 3. AN ERROR NAMES WHAT HAPPENED AND WHAT TO DO. "Something went wrong" is
&#x20;    half an error. If there is nothing to do, say who to tell.
&#x20; 4. NO APOLOGIES, NO "OOPS", NO EXCLAMATION MARKS. The app is not sorry; it
&#x20;    is a tool. Say the fact.
&#x20; 5. THE ACTOR IS NAMED. "A document failed to upload" hides who failed at
&#x20;    what. "The document did not upload."
&#x20; 6. NO HEDGING. "May", "might", "could potentially" — either state the
&#x20;    condition or state the fact.
&#x20; 7. NO WORDS NOBODY AT BATU KAWAN WOULD SAY: seamless, robust, leverage,
&#x20;    utilise, streamline, ensure, kindly.
&#x20; 8. DO NOT ANNOUNCE. "Note that", "Please be aware", "In order to".
&#x20; 9. A BUTTON SAYS WHAT HAPPENS, and the confirmation says it happened in the
&#x20;    same words. Book → "Booked", not "Success".
&#x20; **What does NOT transfer, and why — check before applying a rule from it:**
&#x20; - CURLY QUOTES. Humanizer bans them as an AI tell in plain text. In UI they
&#x20;   are correct typography; keep “ ” and ’ in copy, and keep the locale's own
&#x20;   marks in zh. This is a rule about prose files, not about rendered type.
&#x20; - EMOJI. Banned there, but the greeting wave on the three Home screens and
&#x20;   the 🇲🇾 flag on the phone field are approved design. Do not add new ones;
&#x20;   do not strip those.
&#x20; - "PLEASE". Dropping it sharpens ENGLISH. It does not transfer: Malay "Sila
&#x20;   masukkan…" and Chinese "请输入…" are ordinary politeness, and removing them
&#x20;   reads as rude rather than direct. **Decide per language, never by mirroring
&#x20;   the English edit** — see the register rule below.
&#x20; **⚠ WHAT THIS PASS MUST NOT TOUCH** (owner constraint, 17 Aug 2026): any
&#x20; string that states a MONEY RULE or a legal-ish fact — incentives, rates,
&#x20; deductions, zone points, the POD/K2 gate, incentive approval, the B7
&#x20; cut-offs, holiday entitlement, GPS consent, audit wording. Those are precise
&#x20; on purpose, they are the ones read back to the client, and the plain-language
&#x20; pass on the pay panel is already done and DERIVED FROM THE ENGINE. Shortening
&#x20; a rule changes what it promises. When a money string reads badly, raise it;
&#x20; do not rewrite it in a style pass.
&#x20; ⚠ Work in BATCHES BY SURFACE with the before/after shown, never a 1,500-string
&#x20; sweep: this repo has 1,593 English strings and a copy regression is invisible
&#x20; to every test in it.

\- **THE REGISTER RULE — WORKPLACE MALAY, NOT TEXTBOOK MALAY** (owner ruling,
&#x20; 15 Aug 2026). UWC's office and drivers speak Malay with English loanwords
&#x20; for role and system terms. "Pentadbir Armada" is a dictionary translation
&#x20; nobody would say out loud; Admin is "Admin". The test is what someone at
&#x20; Batu Kawan would actually say — NOT consistency for its own sake.
&#x20; **If a UWC clerk or driver would say the English word inside a Malay
&#x20; sentence, keep the English word. If there is a natural everyday Malay word,
&#x20; use that.**
&#x20; ENGLISH: Admin, POD, Dashboard, Requestor, Fleet (in labels), Trip (see
&#x20; below), Password, Sustainability, and the role labels.
&#x20; MALAY: pemandu, tempahan, hantar, lori, muatan, zon, penerima, dokumen,
&#x20; laporan, insentif, prestasi, status. "Log masuk" STAYS — it is already
&#x20; half-English and it is said out loud.
&#x20; **ENTITY-OR-LABEL vs PROSE is the dividing line.** A label, or the name of a
&#x20; thing, takes the English term (Trip Management, the trip list, trip status).
&#x20; A sentence about a driver's journey does not.
&#x20; ⚠ **WATCH FOR IDIOMS WEARING THE ENTITY'S NAME.** Ten `Perjalanan` strings
&#x20; looked like trip labels and were not: their English source is "In Transit",
&#x20; "En Route" or "In Progress" — the idiom for being on the way, not the noun.
&#x20; "Dalam Perjalanan" is right; "Dalam Trip" is not something anyone says.
&#x20; Read the ENGLISH SOURCE before converting, never the Malay alone.
&#x20; **WHEN AMBIGUOUS, LEAVE IT MALAY** — the failure mode of over-anglicising is
&#x20; worse than a few inconsistent labels.
&#x20; The same rule governs `zh.json` (仪表板 and 申请人 went the same way), with
&#x20; ONE difference: Chinese does not absorb a latin word mid-sentence as easily
&#x20; as Malay does, so there the English term is used for LABELS ONLY and prose
&#x20; keeps the Chinese. 罗里 STAYS — that is the Malaysian-Chinese loanword for
&#x20; lorry, and whoever wrote it got Penang right.
\- **ONE CONCEPT, ONE WORD, PER LOCALE.** `admin.pod.title` was 送达凭证 while
&#x20; `bookingDetail.podTitle` was 签收证明 — two different words for Proof of
&#x20; Delivery, in a file that already used "POD" as a loanword in five other
&#x20; strings. That is a BUG, not a matter of taste, and it is the same shape as
&#x20; the zh 预订 collision (`tabs.bookings` and `requestor.book` sharing one word
&#x20; for two destinations). A locale can be internally inconsistent while every
&#x20; parity and selector guard passes, because those check KEYS, not WORDING.
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

