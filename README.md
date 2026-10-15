# Replacing PostgreSQL with AWS DynamoDB for Keeptrack Reports

This project replaces Amazon RDS PostgreSQL with Amazon DynamoDB (On-Demand) as the main store for IVR bot calls. The system has two circuits: **raw record storage** (DynamoDB) and **analytics for the chart** (a small table of hourly counters and a chart page). After the cutover, RDS is shut down and stops being billed.

The step-by-step implementation plan (with checkboxes, AWS console instructions, code and checks after every step) is in a separate document: [IMPLEMENTATION_PLAN.en.md](IMPLEMENTATION_PLAN.en.md).

Document status: design description. Values marked as **assumption** must be confirmed before work starts (see [Open questions](#open-questions)).

## Table of contents

- [Goals and scope](#goals-and-scope)
- [Architecture](#architecture)
- [Data model](#data-model)
- [Data transformation on load](#data-transformation-on-load)
- [Analytics and chart](#analytics-and-chart)
- [Cost](#cost)
- [Cutover plan and rollback](#cutover-plan-and-rollback)
- [Exporting data for a period](#exporting-data-for-a-period)
- [Queries and export](#queries-and-export)
- [Security and personal data](#security-and-personal-data)
- [Limitations](#limitations)
- [Alternatives considered](#alternatives-considered)
- [Verification and monitoring](#verification-and-monitoring)
- [Open questions](#open-questions)

## Goals and scope

**Goal.** Eliminate the fixed cost of RDS (the instance is billed 24/7) and the cost of Grafana by moving to a pay-per-request model at minimal cost.

**What the system does:**

- accepts call records from AWS Lambda and stores them as separate attributes (all report columns);
- returns a single record by `call_id`;
- exports slices for a period (day, week, month);
- every 15 minutes computes hourly counters (calls, short calls, successful, errors, hangups, escalations);
- shows the `Dialogerfolgsrate` chart (bars and rate lines) on a lightweight page of its own.

**What the system does not do (out of scope):**

- arbitrary analytics (`GROUP BY` on any field, `JOIN`, on-the-fly conditional counts). Only the metrics defined in the counters table are available;
- Grafana, Athena and other BI tools (the reasons are in [Alternatives considered](#alternatives-considered)).

**Volume (assumption).** The test file `keeptrack-report-masked.csv` contains 17,017 calls for a single day (2026-06-08). The bars on the current Grafana chart add up to roughly 270,000 calls over ~30 days (~9,000 per day, 400–1,600 on weekends, a peak of ~21,000), that is ~3.3 million per year. This is a rough estimate read off the chart. The cost calculation uses the upper estimate of 6.2 million per year.

## Architecture

Before the migration:

- Amazon RDS PostgreSQL;
- AWS Lambda (reads and writes PostgreSQL, possibly inside a VPC);
- Grafana with SQL queries against PostgreSQL.

After the migration, **circuit 1: storage** (DynamoDB On-Demand, region `eu-central-1`):

- the `KeeptrackReports` table stores all raw records keyed by `call_id`; the `DayIndex` index makes it fast to read the calls of a day;
- the `keeptrack-writer` Lambda accepts a call and writes it;
- the `keeptrack-export` Lambda and scripts export slices for a period;
- Export to S3 from PITR for full exports.

**Circuit 2: analytics for the chart:**

- the `keeptrack-aggregator` Lambda, on a schedule (Amazon EventBridge Scheduler), reads the calls of a day from `DayIndex`, computes hourly counters and overwrites them in the `KeeptrackHourly` table;
- the `keeptrack-dashboard` Lambda with a Function URL serves the chart page and its data (it reads only `KeeptrackHourly`); access is protected by a login and password.

Both circuits use serverless services only: Lambda, DynamoDB, S3, EventBridge Scheduler, CloudWatch. Lambda runs without a VPC (DynamoDB is reachable through its public endpoint; if Lambda stays in a VPC, add the free Gateway VPC Endpoint for DynamoDB, otherwise traffic goes through a paid NAT gateway).

Why it is built this way: DynamoDB has no `GROUP BY` and no aggregates, so Lambda does the counting and the chart reads ready-made numbers. The PartiQL language (in the DynamoDB console and in plugins) does not replace this: its DynamoDB dialect has no aggregates, no `GROUP BY`, no `JOIN` and no date functions.

## Data model

### The KeeptrackReports table

| Item | Value |
| --- | --- |
| Partition Key | `call_id` (String), unique in the test data (17,017 of 17,017) |
| Sort Key | none |
| Mode | On-Demand (`PAY_PER_REQUEST`) |
| Protection | `DeletionProtection`, PITR |

A Sort Key is not needed: with a unique `call_id` it would only complicate `GetItem`, which would then have to be given the time as well.

The **`DayIndex`** index (GSI) for reading by day:

| Item | Value |
| --- | --- |
| Partition Key | `event_date` (String, `YYYY-MM-DD`, local date of the call) |
| Sort Key | `starttime` (String, ISO 8601 UTC, `2026-06-08T14:30:00Z`) |
| Projection | `ALL` |

Why a day, not a month, in the index key:

- one day is ~17,000 records (~7 MB, a few pages of 1 MB);
- a monthly query becomes ~30 independent queries that run in parallel;
- a month as the key would put ~500,000 records under one key value and force a single sequential stream of hundreds of pages.

Why the `date` column cannot be relied on:

- it is empty for 33% of calls (5,581 of 17,017), primarily abandoned ones (`reason = hangup`);
- it contains a date and time, not just a date.

That is why `event_date` is computed from `starttime`, which is always present. For the counters, `event_hour` is also stored: the local hour of the call (`00`–`23`), derived from the same source value.

### The KeeptrackHourly table (counters)

| Item | Value |
| --- | --- |
| Partition Key | `month_key` (String, `YYYY-MM`) |
| Sort Key | `hour_key` (String, local hour, `2026-06-08T14`) |
| Mode | On-Demand, `DeletionProtection` |
| Size | ~720 rows per month, a month is read with a single query |

Each row holds numbers; the rates are computed at display time:

| Counter | Rule (reproduces the previous SQL queries) |
| --- | --- |
| `calls_total` | all calls |
| `calls_short` | `short_call = 1` (shown as `Anzahl Frühaufleger` on the chart) |
| `calls_nonshort` | `short_call != 1` (shown as `Anzahl Anrufe`; also the denominator of all rates) |
| `success` | `success = 1` and (`escalation` empty or `escalation != 1`) |
| `error` | not short and `reason = 'error'` |
| `hangup` | not short, `reason = 'hangup'`, and `exit_module` present and not equal to `'Exit'` |
| `escalation` | `escalation = 1` over all calls |
| `escalation_nonshort` | `escalation = 1` among non-short calls only |

As in SQL, an empty field does not satisfy a condition of the form `!= 1`: a call without `short_call` is counted neither as short nor as non-short. There are no such calls in the test data.

**Rates on the chart** (assumption): `Dialogerfolgsrate = success / calls_nonshort`, `Fehlerrate = error / calls_nonshort`, `Auflegerate = hangup / calls_nonshort`, `Eskalationsrate = escalation / calls_nonshort`.

Values for the test day (2026-06-08):

| Counter | Value | Share of calls without short calls |
| --- | --- | --- |
| `calls_total` | 17,017 | |
| `calls_short` | 2,118 | |
| `calls_nonshort` | 14,899 | 100% |
| `success` | 8,882 | 59.61% |
| `error` | 0 | 0% |
| `hangup` | 3,906 | 26.22% |
| `escalation` (all calls) | 2,569 | 17.24% |
| `escalation_nonshort` | 2,125 | 14.26% |

`success`, `hangup` and `escalation_nonshort` add up to 100.09% (three mutually exclusive outcomes), while with `escalation` over all calls the sum is 103.07%. This suggests that on the previous chart the escalation rate is most likely computed over calls without short calls. It must be confirmed against the old dashboard (see [Open questions](#open-questions)). Of the 2,569 calls with `escalation = 1`, 444 are short. The `escalation_module` field is not suitable for identifying escalations: it is filled for 2,621 calls, that is for 52 calls with `escalation = 0`.

## Data transformation on load

All columns are stored as separate top-level attributes, not as a JSON string. Otherwise they could not be filtered on.

| What | Rule |
| --- | --- |
| `starttime`, `endtime` | Source format is `YYYY-MM-DD HH:MM:SS` with no time zone. Assumed to be `Europe/Berlin` time (**assumption**, parameter `SOURCE_TZ`). Stored as ISO 8601 UTC |
| `event_date` | First 10 characters of the source (local) `starttime` |
| `event_hour` | Characters 12–13 of the source (local) `starttime`: the hour `00`–`23` |
| `duration` | A JSON string like `{"minutes":1,"seconds":43,"milliseconds":364.874}` is replaced by the number `duration_seconds` (seconds, 3 decimals) |
| `0/1` flags and counters | Stored as Number |
| All other values | Stored as String |
| Empty values | Not written (the attribute is simply absent) |
| Personal data fields | Not loaded by default, see [Security and personal data](#security-and-personal-data) |
| `date` | Stored as is. It is a DynamoDB reserved word, so in queries it must be wrapped in `ExpressionAttributeNames` or quotes in PartiQL |

The column description (which fields are numeric, which are personal data, and the full column list) lives in a single file, `src/columns.json`, read by both the load script and the Lambdas, so the rules cannot drift apart. The file contents are in [Step 2 of the implementation plan](IMPLEMENTATION_PLAN.en.md#step-2-column-configuration).

The `specification_utterancel` column looks like a typo in the source (an extra `l`). The name is kept as is to avoid breaking compatibility; decide whether to fix it at the source.

## Analytics and chart

The chart reproduces the current Grafana dashboard: stacked bars `Anzahl Anrufe` (calls without short calls) and `Anzahl Frühaufleger` (short calls), and four rate lines `Dialogerfolgsrate`, `Fehlerrate`, `Auflegerate`, `Eskalationsrate` on a second axis (0–100%).

**How it works:**

1. **Counter recomputation.** The `keeptrack-aggregator` Lambda runs on a schedule: every 15 minutes it recomputes today, and at night at 02:30 (`Europe/Berlin` time) it recomputes yesterday and today. For each day it reads the calls from `DayIndex`, counts them by hour and **overwrites** the rows in `KeeptrackHourly`. Overwriting instead of adding means that running it again does not double-count.
2. **History.** Counters for past periods are computed by a one-off run of the same function with a date range (up to 62 days per call).
3. **The page.** The `keeptrack-dashboard` Lambda serves, at its Function URL, a Chart.js page and the data as JSON. The user picks a period and an interval (hour, day, week); the rates are computed in the browser, and days and weeks are obtained by summing hours. Empty intervals are shown as zeros, as `GENERATE_SERIES` did in the previous queries.
4. **Access.** A login and password (HTTP Basic) are checked inside the function, over HTTPS only. Details and limitations are in [Security and personal data](#security-and-personal-data).

Implementation and tests: steps [5](IMPLEMENTATION_PLAN.en.md#step-5-counters-table-keeptrackhourly), [6](IMPLEMENTATION_PLAN.en.md#step-6-aggregator-lambda-keeptrack-aggregator), [7](IMPLEMENTATION_PLAN.en.md#step-7-eventbridge-scheduler-schedule) and [8](IMPLEMENTATION_PLAN.en.md#step-8-chart-page-keeptrack-dashboard) of the implementation plan.

**What is not possible without further development:**

- views for which there is no counter (for example by `category` or `concern`). Each new view means new counters in the aggregator and a new chart in the page;
- granularity finer than an hour;
- working with the chart as flexibly as in Grafana (new panels are added in code, not with the mouse).

## Cost

The estimate assumes ~6.2 million records per year (the upper estimate). A write to the table and a write to `DayIndex` are billed separately, that is 2 WRU per record for records up to 1 KB (~0.4 KB in the test data).

| Item | Estimate per year |
| --- | --- |
| Writes to `KeeptrackReports` (~12.4 million WRU) | ~$8 at $0.625 per 1 million WRU, ~$16 at $1.25 per 1 million WRU |
| Reads (exports, `GetItem`) | under $1 |
| Storage (~2.5 GB per year in the table plus the same in the index) | $0 in the first year (25 GB free), then ~$0.25 per GB-month above the limit |
| PITR (~$0.20 per GB-month) | ~$3–12 depending on table size |
| Aggregator: reading today's calls every 15 minutes (~8 million RRU) and writing counters | ~$1–3 |
| The `KeeptrackHourly` table (storage, page reads) | under $1 |
| Lambda (writes, aggregator, page, export), Function URL, EventBridge Scheduler | $0 within the free limits (check the price list) |
| S3 for exports (deleted after 1 day), CloudWatch Logs | cents |
| KMS CMK (if a custom key is used) | ~$12 ($1 per month) |
| **Total** | **roughly $12–35 per year** |

For comparison: Amazon Managed Grafana costs $9 (Editor) or $5 (Viewer) per user per month, and the DynamoDB plugin is an Enterprise plugin, that is another +$45 per month for each active user (~$650 per year for one user). The original README estimated an RDS `db.t3.micro` at $180–240 per year.

Caveats:

- Sources disagree on the write price: some state $0.625, others $1.25 per 1 million WRU (AWS cut On-Demand prices in November 2024). `eu-central-1` prices differ from `us-east-1`. Check the current price list at [aws.amazon.com/dynamodb/pricing](https://aws.amazon.com/dynamodb/pricing/) before agreeing a budget.
- If the real volume is closer to 3.3 million per year, writes cost roughly half as much.
- The free 25 WCU and 25 RCU apply only to Provisioned mode, not to On-Demand.
- Real records are larger than the test ones: transcripts (`*_utterance`) are not masked in production data. Records larger than 1 KB cost more than 1 WRU.
- The aggregator figures are estimates: it reads today's calls (on average about half of the daily volume) every 15 minutes, and a field projection does not reduce the read cost.
- Check the $180–240 RDS figure against your actual bill.

## Cutover plan and rollback

PostgreSQL stays in service until DynamoDB passes verification. Until the end of phase 4, rolling back to PostgreSQL requires no data restore.

| Phase | What happens | Criterion to proceed |
| --- | --- | --- |
| 1. Preparation | Tables, IAM, PITR, Lambdas, schedule, page; tests of steps 0–11 of the implementation plan | All checks on the test data pass |
| 2. History | Load all historical data (`migrate.py`), recompute counters for the whole history | Per-day call counts match PostgreSQL |
| 3. Parallel write | Lambda writes to PostgreSQL (primary) and DynamoDB (secondary). A DynamoDB write failure is logged but does not break the main flow. Duration: 2 weeks or more | Daily reconciliation shows no discrepancies; the numbers on the new chart match Grafana for 3 different days; no errors in CloudWatch |
| 4. Cutover | DynamoDB becomes the primary store, writes to PostgreSQL continue as a shadow copy | 2 weeks without incidents |
| 5. Stop PostgreSQL | Stop writing to PostgreSQL, take a final `pg_dump` to S3 | Dump verified and stored |
| 6. Remove RDS and Grafana | Final RDS snapshot kept for 30 days, then the instance is deleted. Lambda is moved out of the VPC if it was in one. The old Grafana dashboard is switched off | Confirmation from the system owner |

Rollback in phases 3 and 4: switch the primary store back to PostgreSQL (it stays current thanks to parallel writes). After phase 5, a rollback means restoring from the dump.

Daily reconciliation: compare per-day call counts in PostgreSQL and DynamoDB (see [Verification and monitoring](#verification-and-monitoring)), and spot-check the values of a few records. A detailed checklist is in [step 12 of the implementation plan](IMPLEMENTATION_PLAN.en.md#step-12-cutover).

## Exporting data for a period

The script `src/export_month.py` exports a month with parallel per-day queries through `DayIndex`, one CSV per day. The code and the run command are in [Step 10 of the implementation plan](IMPLEMENTATION_PLAN.en.md#step-10-local-export-and-ad-hoc-queries).

Notes:

- Queries against a GSI are eventually consistent by default: records written in the last few seconds may not be visible. For exports of completed days this is not a problem.
- For a full export of the whole table, **Export to S3** from PITR is better. It consumes no RCU and puts no load on the table.
- Sorting within a day is already provided by the Sort Key `starttime`.

## Queries and export

No separate query plugin is needed. The tasks are covered like this:

| Task | Tool |
| --- | --- |
| Find a single call by `call_id` | DynamoDB console, "Explore items", or `aws dynamodb get-item` |
| View records for a day (ad-hoc query) | DynamoDB console PartiQL editor, or the free AWS NoSQL Workbench app |
| Export a day, a week or a month | The `keeptrack-export` Lambda (below), or the local script `export_month.py` |
| View the chart and rates | The `keeptrack-dashboard` page, see [Analytics and chart](#analytics-and-chart) |
| Full table snapshot | Export to S3 from PITR |

Example queries for the PartiQL editor are in [Step 10 of the implementation plan](IMPLEMENTATION_PLAN.en.md#step-10-local-export-and-ad-hoc-queries). The console and the PartiQL editor do not support aggregates (`GROUP BY`, conditional `COUNT`), see [Limitations](#limitations). Each query reads records and costs RCU, but for ad-hoc queries this is pennies.

### The keeptrack-export Lambda

Why a separate function instead of simply returning the data from Lambda: the response limit of a synchronous Lambda invocation is 6 MB, while one day is ~7 MB of JSON. So the function writes slices to S3 (one file per day, gzip-compressed CSV) and returns the file keys and, where available, temporary download links.

How it works:

1. You invoke the function with a date range (at most 31 days).
2. For each day the function reads `DayIndex` with pagination and writes `exports/<id>/<day>.csv.gz` to a private S3 bucket.
3. The function returns JSON with a list of days, record counts, file keys and links (valid for 15 minutes).
4. The bucket deletes exports automatically after 1 day (important because of personal data, see [Security and personal data](#security-and-personal-data)).

Creating the bucket, the IAM policy, the function settings, the code and the checks are in [Step 9 of the implementation plan](IMPLEMENTATION_PLAN.en.md#step-9-export-lambda-keeptrack-export-and-s3-bucket). If you later need to call the function from a browser or another system, add a Lambda Function URL with `AuthType = AWS_IAM` or an API Gateway with authorization, but do not expose it publicly until the personal data questions are resolved.

### Export range

The function exports whole local days (by `event_date`). A single call accepts up to 31 days. For a longer period, call the function several times or use Export to S3 from PITR.

For a range within a single day (for example, 10:00 to 12:00), use the PartiQL editor in the console with a condition on `starttime` (example in [Step 10 of the implementation plan](IMPLEMENTATION_PLAN.en.md#step-10-local-export-and-ad-hoc-queries)). Remember that `starttime` is stored in UTC, while `event_date` is the local date.

## Security and personal data

Besides the masked fields in the test file, production data will contain personal data of bank customers:

- caller phone number (`gc_ani`);
- customer number (`legitimation_customernumber`);
- transcripts of customer speech (`central_utterance`, `disambiguation_utterance`, `diy_utterance`, `resolution_utterance`, `specification_utterance`, `specification_utterancel`).

In addition, the RVNR validation process handles sensitive data. Approval from the data protection officer (GDPR) is required.

Default behavior: fields from the `pii` list in `columns.json` are **not loaded** (`INCLUDE_PII=0`). The counters table and the chart contain no personal data: only numbers by hour. If the business needs the personal fields, set `INCLUDE_PII=1` and be sure to:

- enable encryption with your own KMS key (CMK) and restrict access to the key;
- set a retention period (TTL, attribute `expires_at`) in line with the data deletion policy;
- grant read access through a separate role, without write and delete permissions;
- enable CloudTrail for the table;
- do not log record contents to CloudWatch.

If you decide not to store the personal fields, also remove them from the source export so that they do not end up in CSV files and dumps.

**Access to the chart page.** The page is protected by a login and password (HTTP Basic) and works over HTTPS only, but the Function URL is reachable from the internet and the number of login attempts is not limited. Therefore:

- use a long random password (20 characters or more) and do not publish the address;
- limit the number of concurrent executions of the function (reserved concurrency) to protect yourself from unwanted costs;
- the login and password are stored in the function's environment variables (encrypted at rest, but visible to AWS administrators);
- if the bank's security policy requires single sign-on (SSO), access from the corporate network only, or role separation, replace the Function URL with Amazon API Gateway with authorization (Cognito or corporate SSO). At your load the cost would be a few dollars per month (check the price list).

The chart does not need access to the raw data: by its IAM policy, the `keeptrack-dashboard` function can only read the `KeeptrackHourly` table.

## Limitations

- **Analytics only for the defined metrics.** There are 8 counters and the rates derived from them, with a granularity of no less than an hour. DynamoDB does not support `JOIN`, `GROUP BY` or aggregates over arbitrary conditions, and PartiQL in DynamoDB does not add them. New views require changes in the aggregator and the page.
- **Counters are recomputed, not accumulated.** A record added after a day has been recomputed will reach the counters at the next recomputation: for today that is up to 15 minutes, and for calls written after midnight into the previous day, until the nightly recomputation (02:30). Records deleted from `KeeptrackReports` do not decrease the counters of hours that are now empty: an hour row is not deleted until it is recomputed with data.
- **Switch to winter time.** In autumn the local hour 02:00 occurs twice and is merged into one bucket (this is how `DATE_TRUNC` on local time behaved in the previous queries).
- **Limited queries on raw data.** Only lookup by `call_id` and by `event_date` with a `starttime` range work efficiently. Any other filter (by `category`, `success`) is a Scan or post-fetch filtering, meaning all records of the day are read (and paid for).
- **The GSI doubles the write cost** and the storage size with `Projection = ALL`. The aggregator and the export read through `DayIndex`, so the index is needed.
- **Record size.** The DynamoDB limit is 400 KB per record, and in practice records are much smaller. But records over 1 KB cost more than 1 WRU, and transcripts in production data are larger than in the test data.
- **The GSI is eventually consistent.**
- **The page.** Protection by login and password without SSO; the Chart.js library is loaded by the browser from a CDN (`cdn.jsdelivr.net`), so if internet access is restricted it must be hosted yourself.

## Alternatives considered

| Option | When it fits | Why it was not chosen |
| --- | --- | --- |
| Keep PostgreSQL, downsize the instance (including Lightsail) | SQL aggregates and existing dashboards are needed without rework | Contradicts the decision to replace PostgreSQL |
| S3 (Parquet, daily partitions) + Athena + Grafana | Arbitrary SQL queries and Grafana are needed. Athena queries cost cents at your volumes, and the previous SQL ports with small edits | Requires an export to S3, an Athena table and a paid Grafana (Amazon Managed Grafana from $9 per user per month) or your own Grafana server. Excessive for four fixed metrics |
| Grafana with the DynamoDB plugin | Grafana on top of DynamoDB is needed | The plugin is an Enterprise plugin (+$45 per month per active user in Amazon Managed Grafana), without time macros and without aggregates |
| CloudWatch (custom metrics and dashboard) | A dashboard without development is needed | To my knowledge, no backfilling of history, an hour cannot be recomputed (re-sending adds up), and bars and lines on two axes in one widget are not supported |
| S3 only (files per day) for archive and export | Lookup by `call_id` is not needed | Fast access to a single call is needed |

## Verification and monitoring

**Integrity.** `ItemCount` in `describe-table` is updated roughly every 6 hours and is not suitable for verification right after a load. Count records per day through `DayIndex` instead and compare with the per-day counts in PostgreSQL, taking the local date into account. The script and the SQL query are in [Step 3](IMPLEMENTATION_PLAN.en.md#step-3-loading-the-history) and [Step 12](IMPLEMENTATION_PLAN.en.md#step-12-cutover) of the implementation plan.

For the whole table, `aws dynamodb scan --select COUNT` is acceptable (at this volume it costs pennies), as is Export to S3.

**Counter reconciliation.** The control numbers for 2026-06-08 are in [Data model](#data-model). For production data, compare the daily sums of `KeeptrackHourly` with the SQL query against PostgreSQL (the query is in [Step 6](IMPLEMENTATION_PLAN.en.md#step-6-aggregator-lambda-keeptrack-aggregator)), and the numbers on the new chart with the old Grafana dashboard for 3 different days.

**Latency.** Measure the "under 10 ms" criterion with the CloudWatch metric `SuccessfulRequestLatency` for `PutItem` and `GetItem`. Lambda response time, including cold start, is not part of it.

**Alerts** (set up in [Step 11](IMPLEMENTATION_PLAN.en.md#step-11-error-alerts)):

- a CloudWatch Alarm on the errors of the `keeptrack-writer`, `keeptrack-aggregator` and `keeptrack-dashboard` functions;
- a CloudWatch Alarm on `SystemErrors` and `ThrottledRequests` for the tables;
- an AWS Budget of $5 per month with notification (set up in [Step 0](IMPLEMENTATION_PLAN.en.md#step-0-preparation));
- during the parallel write phase: a metric for DynamoDB write errors.

## Open questions

1. **Real volume.** Confirm that 17,000 calls per day is the typical load (6.2 million per year) and not a peak day. The 30-day chart points to ~9,000 per day (~3.3 million per year).
2. **Time zone** of the source `starttime` values (this document assumes `Europe/Berlin`). `event_date` and `event_hour`, that is the boundaries of days and hours on the chart, depend on it.
3. **Escalations.** The definition `escalation = 1` is adopted (the `escalation_module` field is not used, it gives 52 more calls). To be confirmed: is the rate computed over all calls (17.24% on the test day) or only among calls without short calls (14.26%)? The second is more likely (the sum of the three outcomes is 100.09% versus 103.07%). The decision must be recorded after the reconciliation with Grafana (step 8 and step 12 of the implementation plan).
4. **Denominator of the rates.** Confirm that all four rates are computed over calls without short calls.
5. **Personal data:** whether the fields in the `pii` list are needed and what their retention period is.
6. **Access to the chart:** whether a login and password are sufficient or SSO, or access from the corporate network only, is required.
7. **Lookup by `call_id`:** whether fast access to a single call is needed. If not, the main store can be simplified to S3 by day.
8. **Current RDS and Grafana cost.** Check the $180–240 per year figure against the actual bill.
9. **Pricing.** Verify the current On-Demand prices for `eu-central-1`.
10. **Whether other intervals or views** are needed on the chart (by `category`, `concern`, etc.). Currently out of scope.
