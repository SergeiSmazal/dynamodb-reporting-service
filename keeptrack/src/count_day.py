import sys
import boto3
from boto3.dynamodb.conditions import Key

table = boto3.resource("dynamodb", region_name="eu-central-1").Table("KeeptrackReports")

def count_day(day):
    total, kwargs = 0, {
        "IndexName": "DayIndex",
        "KeyConditionExpression": Key("event_date").eq(day),
        "Select": "COUNT",
    }
    while True:
        resp = table.query(**kwargs)
        total += resp["Count"]
        if "LastEvaluatedKey" not in resp:
            return total
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

print(count_day(sys.argv[1] if len(sys.argv) > 1 else "2026-06-08"))