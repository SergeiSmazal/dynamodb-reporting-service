# Replacing PostgreSQL with AWS DynamoDB for Keeptrack Reports

This project replaces Amazon RDS PostgreSQL with Amazon DynamoDB (On-Demand) as the only data store for IVR bot calls. Once the cutover is done, RDS is shut down and stops being billed.

The step-by-step implementation, with all commands, queries and code, is in a separate document: [IMPLEMENTATION_PLAN.en.md](IMPLEMENTATION_PLAN.en.md).

Document status: design description. Values marked as **assumption** must be confirmed before work starts (see [Open questions](#open-questions)).

## Table of contents

- [Goals and scope](#goals-and-scope)
- [Architecture](#architecture)
- [Data model](#data-model)
- [Data transformation on load](#data-transformation-on-load)
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

**Goal.** Eliminate the fixed cost of RDS (the instance is billed 24/7) and move to a pay-per-request model.

**What the system does:**

- accepts call records from AWS Lambda;
- stores them as separate attributes (all report columns);
- returns slices by day or month for copying and export;
- returns a single record by `call_id`.

**What the system does not do (out of scope):**

- analytics and reports with aggregates (`GROUP BY`, conditional `COUNT`, `JOIN`);
- dashboards and visualization (Grafana and other BI tools). If the need arises, it is a separate stage, see [Limitations](#limitations).

**Volume (assumption).** The test file `keeptrack-report-masked.csv` contains 17,017 calls for a single day (2026-06-08). If that day is typical, it means ~500,000 records per month and ~6.2 million per year, not 1 million as previously stated. All calculations below use 6.2 million.

## Architecture

Before the migration:

- Amazon RDS PostgreSQL;
- AWS Lambda (reads and writes PostgreSQL, possibly inside a VPC);
- reports and exports via SQL.

After the migration:

- Amazon DynamoDB, On-Demand mode, region `eu-central-1`;
- AWS Lambda with AWS SDK v3, without a VPC (DynamoDB is reachable through its public endpoint; if Lambda stays in a VPC, add the free Gateway VPC Endpoint for DynamoDB, otherwise traffic goes through a paid NAT gateway);
- export scripts using `boto3`, or a scheduled Lambda;
- Export to S3 from PITR for full exports.

Queries and export: the DynamoDB console for ad-hoc queries and a dedicated `export` Lambda that puts slices for a period into S3 and returns temporary links, see [Queries and export](#queries-and-export). Analytics, dashboards and Grafana are out of scope.

## Data model

Table **`KeeptrackReports`**:

| Item | Value |
| --- | --- |
| Partition Key | `call_id` (String), unique in the test data (17,017 of 17,017) |
| Sort Key | none |
| Mode | On-Demand (`PAY_PER_REQUEST`) |
| Protection | `DeletionProtection`, PITR |

A Sort Key is not needed: with a unique `call_id` it would only complicate `GetItem`, which would then have to be given the time as well.

GSI **`DayIndex`** for exporting slices:

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

That is why `event_date` is computed from `starttime`, which is always present.

## Data transformation on load

All columns are stored as separate top-level attributes, not as a JSON string. Otherwise they could not be filtered on.

| What | Rule |
| --- | --- |
| `starttime`, `endtime` | Source format is `YYYY-MM-DD HH:MM:SS` with no time zone. Assumed to be `Europe/Berlin` time (**assumption**, parameter `SOURCE_TZ`). Stored as ISO 8601 UTC |
| `event_date` | First 10 characters of the source (local) `starttime` |
| `duration` | A JSON string like `{"minutes":1,"seconds":43,"milliseconds":364.874}` is replaced by the number `duration_seconds` |
| `0/1` flags and counters | Stored as Number |
| All other values | Stored as String |
| Empty values | Not written (the attribute is simply absent) |
| Personal data fields | Not loaded by default, see [Security and personal data](#security-and-personal-data) |
| `date` | Stored as is. It is a DynamoDB reserved word, so in queries it must be wrapped in `ExpressionAttributeNames` or quotes in PartiQL |

The column description (which fields are numeric, which are personal data, and the full column list) lives in a single file, `src/columns.json`, read by both the migration script and the Lambda, so the rules cannot drift apart. The file contents are in [Step 3 of the implementation plan](IMPLEMENTATION_PLAN.en.md#step-3-column-configuration).

The `specification_utterancel` column looks like a typo in the source (an extra `l`). The name is kept as is to avoid breaking compatibility; decide whether to fix it at the source.

## Cost

The estimate assumes ~6.2 million records per year. A write to the table and a write to `DayIndex` are billed separately, that is 2 WRU per record for records up to 1 KB (~0.4 KB in the test data).

| Item | Estimate per year |
| --- | --- |
| Writes (~12.4 million WRU) | ~$8 at $0.625 per 1 million WRU, ~$16 at $1.25 per 1 million WRU |
| Reads (exports, `GetItem`) | under $1 |
| Storage (~2.5 GB per year in the table plus the same in the index) | $0 in the first year (25 GB free), then ~$0.25 per GB-month above the limit |
| PITR (~$0.20 per GB-month) | ~$3–12 depending on table size |
| AWS Lambda | $0 within the Free Tier |
| KMS CMK (if a custom key is used) | ~$12 ($1 per month) |
| **Total** | **roughly $10–30 per year** |

Caveats:

- Sources disagree on the write price: some state $0.625, others $1.25 per 1 million WRU (AWS cut On-Demand prices in November 2024). `eu-central-1` prices differ from `us-east-1`. Check the current price list at [aws.amazon.com/dynamodb/pricing](https://aws.amazon.com/dynamodb/pricing/) before agreeing a budget.
- The free 25 WCU and 25 RCU apply only to Provisioned mode, not to On-Demand.
- Real records are larger than the test ones: transcripts (`*_utterance`) are not masked in production data. Records larger than 1 KB cost more than 1 WRU.
- The `export` Lambda, the S3 bucket for exports (with deletion after 1 day) and CloudWatch Logs add cents per month. Analytics and Grafana are out of scope and not included in the estimate.
- For comparison: the original README estimated an RDS `db.t3.micro` at $180–240 per year. Check that figure against your actual bill.

## Cutover plan and rollback

PostgreSQL stays in service until DynamoDB passes verification. Until the end of phase 3, rolling back to PostgreSQL requires no data restore.

| Phase | What happens | Criterion to proceed |
| --- | --- | --- |
| 1. Preparation | Table, IAM, PITR, schema test on 1 day of data | One day of data loaded, values match |
| 2. History | Load all historical data (`migrate.py`) | Per-day record counts match PostgreSQL |
| 3. Parallel write | Lambda writes to PostgreSQL (primary) and DynamoDB (secondary). A DynamoDB write failure is logged but does not break the main flow. Duration: 2 weeks or more | Daily reconciliation shows no discrepancies, no errors in CloudWatch |
| 4. Cutover | DynamoDB becomes the primary store, writes to PostgreSQL continue as a shadow copy | 2 weeks without incidents |
| 5. Stop PostgreSQL | Stop writing to PostgreSQL, take a final `pg_dump` to S3 | Dump verified and stored |
| 6. Remove RDS | Final RDS snapshot kept for 30 days, then the instance is deleted. Lambda is moved out of the VPC if it was in one | Confirmation from the system owner |

Rollback in phases 3 and 4: switch the primary store back to PostgreSQL (it stays current thanks to parallel writes). After phase 5, a rollback means restoring from the dump.

Daily reconciliation: compare per-day record counts in PostgreSQL and DynamoDB (see [Verification and monitoring](#verification-and-monitoring)), and spot-check the values of a few records.

## Exporting data for a period

The script `src/export_month.py` exports a month with parallel per-day queries through `DayIndex`, one CSV per day. The code and the run command are in [Step 7 of the implementation plan](IMPLEMENTATION_PLAN.en.md#step-7-local-export-script).

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
| Export a day, a week or a month | The `export` Lambda (below), or the local script `export_month.py` |
| Full table snapshot | Export to S3 from PITR |

Example queries for the console PartiQL editor are in [Step 8 of the implementation plan](IMPLEMENTATION_PLAN.en.md#step-8-ad-hoc-queries-and-verification).

The console and the PartiQL editor do not support aggregates (`GROUP BY`, conditional `COUNT`), see [Limitations](#limitations). Each query reads records and costs RCU, but for ad-hoc queries this is pennies.

### Export Lambda

Why a separate function instead of simply returning the data from Lambda: the response limit of a synchronous Lambda invocation is 6 MB, while one day is ~7 MB of JSON. So the function writes slices to S3 (one file per day, gzip-compressed CSV) and returns temporary download links.

How it works:

1. You invoke the function with a date range (at most 31 days).
2. For each day the function reads `DayIndex` with pagination and writes `exports/<id>/<day>.csv.gz` to a private S3 bucket.
3. The function returns JSON with a list of days, record counts and links (valid for 15 minutes).
4. The bucket deletes exports automatically after 1 day (important because of personal data, see [Security and personal data](#security-and-personal-data)).

The bucket commands, the IAM policy, the function settings, the code and the invocation command are in [Step 6 of the implementation plan](IMPLEMENTATION_PLAN.en.md#step-6-export-lambda-and-s3-bucket).

The returned links download the files, one per day. If you later need to call the function from a browser or another system, add a Lambda Function URL with `AuthType = AWS_IAM` or an API Gateway with authorization, but do not expose it publicly until the personal data questions are resolved.

### Export range

The function exports whole local days (by `event_date`). A single call accepts up to 31 days. For a longer period, call the function several times or use Export to S3 from PITR.

For a range within a single day (for example, 10:00 to 12:00), use the PartiQL editor in the console with a condition on `starttime` (example in [Step 8 of the implementation plan](IMPLEMENTATION_PLAN.en.md#step-8-ad-hoc-queries-and-verification)). Remember that `starttime` is stored in UTC, while `event_date` is the local date.

## Security and personal data

Besides the masked fields in the test file, production data will contain personal data of bank customers:

- caller phone number (`gc_ani`);
- customer number (`legitimation_customernumber`);
- transcripts of customer speech (`central_utterance`, `disambiguation_utterance`, `diy_utterance`, `resolution_utterance`, `specification_utterance`, `specification_utterancel`).

In addition, the RVNR validation process handles sensitive data. Approval from the data protection officer (GDPR) is required.

Default behavior: fields from the `pii` list in `columns.json` are **not loaded** (`INCLUDE_PII=0`). If the business needs these fields, set `INCLUDE_PII=1` and be sure to:

- enable encryption with your own KMS key (CMK) and restrict access to the key;
- set a retention period (TTL, attribute `expires_at`) in line with the data deletion policy;
- grant read access through a separate role, without write and delete permissions;
- enable CloudTrail for the table;
- do not log record contents to CloudWatch.

If you decide not to store the personal fields, also remove them from the source export so that they do not end up in CSV files and dumps.

## Limitations

- **Analytics is out of scope.** DynamoDB does not support `JOIN`, `GROUP BY` or aggregates over arbitrary conditions. If you later need reports such as "share of successful calls by category per month", a separate stage will be required: pre-aggregation or an export to another store.
- **Limited queries.** Only lookup by `call_id` and by `event_date` with a `starttime` range work efficiently. Any other filter (by `category`, `success`) is a Scan or post-fetch filtering, meaning all records of the day are read (and paid for).
- **The GSI doubles the write cost** and the storage size with `Projection = ALL`. If exports are rare, you can replace the index with Export to S3 and drop `DayIndex`.
- **Record size.** The DynamoDB limit is 400 KB per record, and in practice records are much smaller. But records over 1 KB cost more than 1 WRU, and transcripts in production data are larger than in the test data.
- **The GSI is eventually consistent.**
- **Grafana and BI are out of scope.** Connecting Grafana to DynamoDB is paid (the DynamoDB plugin is an Enterprise plugin), so the decision is deferred until there is a real need.

## Alternatives considered

| Option | When it fits | Why it was not chosen |
| --- | --- | --- |
| Keep PostgreSQL, downsize the instance (including Lightsail) | SQL aggregates and existing reports are needed | Contradicts the decision to replace PostgreSQL |
| S3 (Parquet, daily partitions) + Athena | Analytics with aggregates will be needed at low cost | Analytics is out of scope, DynamoDB was chosen |
| S3 only (files per day) for archive and export | Lookup by `call_id` is not needed | Fast access to a single call is needed |

## Verification and monitoring

**Integrity.** `ItemCount` in `describe-table` is updated roughly every 6 hours and is not suitable for verification right after a load. Instead, count records per day through `DayIndex` and compare them with the per-day counts in PostgreSQL, taking the local date into account. The script and the SQL query are in [Step 8 of the implementation plan](IMPLEMENTATION_PLAN.en.md#step-8-ad-hoc-queries-and-verification).

For the whole table, `aws dynamodb scan --select COUNT` is acceptable (at this volume it costs pennies), as is Export to S3.

**Latency.** Measure the "under 10 ms" criterion with the CloudWatch metric `SuccessfulRequestLatency` for `PutItem` and `GetItem`. Lambda response time, including cold start, is not part of it.

**Alerts:**

- CloudWatch alarms on `SystemErrors` and `ThrottledRequests` for the table;
- an AWS Budget of $5 per month with notification;
- a Lambda write error metric (including DynamoDB write errors during the parallel write phase).

## Open questions

1. **Real volume.** Confirm that 17,000 calls per day is the typical load (6.2 million per year) and not a peak day.
2. **Time zone** of the source `starttime` values (this document assumes `Europe/Berlin`).
3. **Personal data:** whether the fields in the `pii` list are needed and what their retention period is.
4. **Analytics and dashboards:** revisit if the need arises. Currently out of scope.
5. **Lookup by `call_id`:** whether fast access to a single call is needed. If not, S3 by day is sufficient.
6. **Current RDS cost.** Check the $180–240 per year figure against the actual bill.
7. **Pricing.** Verify the current On-Demand prices for `eu-central-1`.
