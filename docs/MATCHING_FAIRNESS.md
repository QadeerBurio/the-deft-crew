# Candidate matching: fairness review

Covers employer candidate matching (`FLAG_CAREER_MATCHING`, `services/career/matchingService.js`, model version
`skill-evidence-1`). The proof is `tests/career-matching/run.js`: the test fails if any figure below differs. Rerun it
with `FAIRNESS_REPORT=<file>` to regenerate the figures.

## What the matcher reads, and what it never reads
**Reads** (`profileOf`):
- the skills list, plus the resume's AI-extracted skill list (`skillGapService.flattenCandidateSkills`);
- the headline and the summary;
- job titles, descriptions and achievements;
- project names, descriptions and technologies;
- certification names.

For the mandatory criteria only, it also reads:
- work dates (no company, no place);
- degree and field (no institution).

**Never reads**, because these fields are removed before matching and so can't change a result:
- name (and with it a likely gender), photo, age or date of birth;
- university or institution name;
- city or any location, including job locations;
- e-mail, phone and links;
- employer (company) names.

No embeddings are used: they would read the whole resume text, including these fields.

## How a match is built
- **Mandatory criteria**, shown separately as met / not met / unknown:
  - the job's minimum experience;
  - its education level;
  - requirement lines that say must / required / mandatory / at least.

  A requirement line can only be "met" (with evidence) or "unknown". It is never "not met" from free text.
- **Relevance:** for each skill the job lists, the result is:
  - **matched**, with the resume text that shows it;
  - **missing**, when the resume has content but no sign of the skill;
  - **unknown**, when the resume has too little to tell.

  The estimate is `100 × matched ÷ listed skills`. With no listed skills, or an empty resume, it says "insufficient
  information" and gives no number.
- **Experience isn't part of the estimate.** It is a mandatory criterion only. A skill shown in a student project
  counts exactly like the same skill shown in a job. This is a deliberate departure from the master plan's
  illustrative `0.60 skills + 0.25 experience + 0.15 preferences`, which would rank freshers lower for the same skills.
- **Decision support only:**
  - the default order stays newest first;
  - "sort by relevance" is optional, puts "insufficient information" last and never hides anyone;
  - nothing rejects, hides or changes an application;
  - there is no "probability of hire".

## Synthetic test set and results
The reference candidate has JavaScript, React and MongoDB. The job lists JavaScript, React, Node.js, MongoDB,
TypeScript and Git. In each case below, only the named thing changes.

| Case | Estimate | Reference | Same estimate, evidence and criteria |
|---|---|---|---|
| different name (and so likely gender): Ahmed Raza | 50 | 50 | yes |
| different name: Zainab Bibi | 50 | 50 | yes |
| different city: Quetta | 50 | 50 | yes |
| different city: Gilgit | 50 | 50 | yes |
| different university: Virtual University | 50 | 50 | yes |
| different university: LUMS | 50 | 50 | yes |
| different age (graduated 2010) | 50 | 50 | yes |
| different photo | 50 | 50 | yes |
| a university named after skills ("Git React Institute of TypeScript") | 50 | 50 | yes |
| a city named like a skill ("Java") | 50 | 50 | yes |
| fresher (skills shown in projects) vs experienced (5 years' work), same skills | 50 | 50 | yes |
| sparse (skills list only) vs full profile, same skills | 50 | 50 | yes |

**Cohort.** 60 random skill sets (seeded, so the set is the same on every run). Each one is written 16 ways:

| Dimension | Variants |
|---|---|
| career stage | fresher, experienced |
| profile depth | sparse, full |
| city and university | Karachi / NED, Lahore / UET, Quetta / BUITEMS, Gilgit / KIU |

Names also alternate between candidates. Every one of the 16 versions of a skill set got the same estimate, and the
mean estimate is identical for every group:

| Group | Mean estimate |
|---|---|
| fresher | 44.4 |
| experienced | 44.4 |
| sparse profile | 44.4 |
| full profile | 44.4 |
| Karachi / NED University | 44.4 |
| Lahore / UET Lahore | 44.4 |
| Quetta / BUITEMS | 44.4 |
| Gilgit / Karakoram International University | 44.4 |

**Freshers aren't systematically pushed down:** with the same skills they get the same estimate.

**The test catches leaks.** In a mutation check, I made the matcher also read the institution name. The test then
failed: "Git React Institute of TypeScript" raised a candidate from 50 to 83.

## Limits and what to watch in the pilot
- **Unequal skills give unequal estimates.** A candidate who lists fewer of the job's skills scores lower. That is the
  purpose, but it means a resume that under-describes real skills is under-rated. Employers see the evidence, not
  just the number. Candidates can add skills to their resume, and the match updates.
- **Skill names are matched by spelling and a small alias list** (`js` → JavaScript, `node` → Node.js and so on), not
  by meaning. An unusual spelling can show as "missing": check the evidence.
- **The experience criterion uses resume dates.** Unpaid work or freelance work without dates shows as "unknown".
- **Pilot monitoring.** Look at estimates by cohort (fresher / experienced, institution, city) only when a group has
  at least 5 candidates. Compare shortlisting rates against the estimates, to catch employers leaning on the number
  more than on the evidence.
