import assert from "node:assert/strict";
import test from "node:test";
import { formatShekelMinor, parseShekelInput } from "../lib/money";

test("parses shekel amounts without corrupting grouped values", () => {
  assert.equal(parseShekelInput("1000"), 100_000);
  assert.equal(parseShekelInput("12.50"), 1_250);
  assert.equal(parseShekelInput("12,50"), 1_250);
  assert.equal(parseShekelInput("0"), 0);
  assert.equal(parseShekelInput("1,000"), null);
  assert.equal(parseShekelInput("1.234"), null);
  assert.equal(parseShekelInput("-2"), null);
});

test("formats exact agorot instead of rounding the displayed amount", () => {
  assert.equal(formatShekelMinor(100_000), "1,000");
  assert.match(formatShekelMinor(150), /^1[,.]50$/);
  assert.match(formatShekelMinor(50), /^0[,.]50$/);
});
