import csv
import json
import os
import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import boto3

REGION = os.environ.get("AWS_REGION", "eu-central-1")
TABLE = os.environ.get("TABLE_NAME", "KeeptrackReports")
SOURCE_TZ = ZoneInfo(os.environ.get("SOURCE_TZ", "Europe/Berlin"))
INCLUDE_PII = os.environ.get("INCLUDE_PII", "0") == "1"

COLUMNS = json.loads((Path(__file__).parent / "columns.json").read_text(encoding="utf-8"))
NUMERIC = set(COLUMNS["numeric"])
PII = set(COLUMNS["pii"])
TIME_FMT = "%Y-%m-%d %H:%M:%S"


def to_utc_iso(value):
    local = datetime.strptime(value, TIME_FMT).replace(tzinfo=SOURCE_TZ)
    return local.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")


def duration_seconds(raw):
    d = json.loads(raw)
    total = (
        d.get("hours", 0) * 3600
        + d.get("minutes", 0) * 60
        + d.get("seconds", 0)
        + d.get("milliseconds", 0) / 1000
    )
    return Decimal(str(round(total, 3)))


def transform(row):
    """Возвращает item для DynamoDB. Бросает ValueError, если строка некорректна."""
    if not row.get("call_id") or not row.get("starttime"):
        raise ValueError("нет call_id или starttime")

    item = {}
    for key, value in row.items():
        if value is None or value == "":
            continue
        if not INCLUDE_PII and key in PII:
            continue
        if key in ("starttime", "endtime"):
            item[key] = to_utc_iso(value)
        elif key == "duration":
            item["duration_seconds"] = duration_seconds(value)
        elif key in NUMERIC:
            item[key] = Decimal(value)
        else:
            item[key] = value

    item["event_date"] = row["starttime"][:10]  # локальная дата
    item["event_hour"] = row["starttime"][11:13]  # локальный час
    return item


def migrate(path):
    table = boto3.resource("dynamodb", region_name=REGION).Table(TABLE)
    loaded = 0
    rejects = []

    with open(path, newline="", encoding="utf-8") as f, \
         table.batch_writer(overwrite_by_pkeys=["call_id"]) as batch:
        for line_no, row in enumerate(csv.DictReader(f), start=2):
            try:
                batch.put_item(Item=transform(row))
                loaded += 1
            except (ValueError, ArithmeticError) as exc:
                rejects.append((line_no, row.get("call_id", ""), str(exc)))
            if loaded and loaded % 1000 == 0:
                print(f"Загружено {loaded}...")

    print(f"Готово: загружено {loaded}, отклонено {len(rejects)}")
    if rejects:
        with open("rejects.csv", "w", newline="", encoding="utf-8") as out:
            csv.writer(out).writerows([("line", "call_id", "error"), *rejects])
        print("Список отклонённых строк: rejects.csv")


if __name__ == "__main__":
    migrate(sys.argv[1])