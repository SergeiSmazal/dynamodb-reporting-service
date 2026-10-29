import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import columns from "./columns.json" with { type: "json" };

const TABLE = process.env.TABLE_NAME ?? "KeeptrackReports";
const SOURCE_TZ = process.env.SOURCE_TZ ?? "Europe/Berlin";
const INCLUDE_PII = process.env.INCLUDE_PII === "1";
const NUMERIC = new Set(columns.numeric);
const PII = new Set(columns.pii);
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function tzOffsetMs(utcMs, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

function localToUtcIso(s) {
  const [d, t] = s.split(" ");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m, sec] = t.split(":").map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m, sec);
  
  // Zwei Kandidaten: Offset einen Tag vor und nach dem Datum. Der passende liefert die ursprüngliche Ortszeit.
  // Bei mehrdeutiger Zeit (Zeitumstellung im Herbst) wird das erste Vorkommen verwendet, analog zu migrate.py.
  const before = guess - tzOffsetMs(guess - 86400000, SOURCE_TZ);
  const after = guess - tzOffsetMs(guess + 86400000, SOURCE_TZ);
  const valid = [before, after].filter((u) => u + tzOffsetMs(u, SOURCE_TZ) === guess);
  const utc = valid.length ? Math.min(...valid) : before;
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function durationSeconds(raw) {
  const d = typeof raw === "string" ? JSON.parse(raw) : raw;
  const total = (d.hours ?? 0) * 3600 + (d.minutes ?? 0) * 60 + (d.seconds ?? 0) + (d.milliseconds ?? 0) / 1000;
  return Math.round(total * 1000) / 1000;
}

function buildItem(input) {
  if (!input.call_id || typeof input.call_id !== "string") throw new Error("call_id ist erforderlich");
  if (!TIME_RE.test(input.starttime ?? "")) throw new Error("starttime: Format YYYY-MM-DD HH:MM:SS erwartet");

  const item = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || value === "") continue;
    if (!INCLUDE_PII && PII.has(key)) continue;
    if (key === "starttime" || key === "endtime") item[key] = localToUtcIso(value);
    else if (key === "duration") item.duration_seconds = durationSeconds(value);
    else if (NUMERIC.has(key)) item[key] = Number(value);
    else item[key] = value;
  }
  item.event_date = input.starttime.slice(0, 10); // lokales Datum
  item.event_hour = input.starttime.slice(11, 13); // lokale Stunde
  return item;
}

export const handler = async (event) => {
  let item;
  try {
    const input = typeof event.body === "string" ? JSON.parse(event.body) : (event.body ?? event);
    item = buildItem(input);
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: err.message }) };
  }

  try {
    // Idempotentes Schreiben: Das erneute Senden derselben call_id überschreibt den Datensatz.
    // Falls Duplikate nicht erlaubt sind, ConditionExpression hinzufügen: "attribute_not_exists(call_id)".
    await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
    return { statusCode: 200, body: JSON.stringify({ call_id: item.call_id }) };
  } catch (err) {
    console.error("Fehler beim Schreiben in DynamoDB", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Daten konnten nicht gespeichert werden" }) };
  }
};

export const getCall = async (callId) => {
  const { Item } = await doc.send(new GetCommand({ TableName: TABLE, Key: { call_id: callId } }));
  return Item ?? null;
};
