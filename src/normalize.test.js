/**
 * Text normalizer tests.
 * Run: node src/normalize.test.js
 */
import { normalize, splitSentences, numberToWords, ordinalToWords, yearToWords } from './normalize.js';

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  if (actual === expected) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

function has(input, expected, label, opts) {
  const out = normalize(input, opts);
  if (out.includes(expected)) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
    console.log(`    expected to contain: ${JSON.stringify(expected)}`);
    console.log(`    actual: ${JSON.stringify(out)}`);
  }
}

// --- numberToWords -------------------------------------------------------
eq(numberToWords(0), 'zero', 'zero');
eq(numberToWords(7), 'seven', 'seven');
eq(numberToWords(13), 'thirteen', 'thirteen');
eq(numberToWords(20), 'twenty', 'twenty');
eq(numberToWords(42), 'forty-two', 'forty-two');
eq(numberToWords(100), 'one hundred', 'one hundred');
eq(numberToWords(101), 'one hundred and one', 'one hundred and one');
eq(numberToWords(912), 'nine hundred and twelve', '912');
eq(numberToWords(1000), 'one thousand', 'one thousand');
eq(numberToWords(1234), 'one thousand two hundred and thirty-four', '1234');
eq(numberToWords(1000000), 'one million', 'one million');
eq(numberToWords(2500000), 'two million five hundred thousand', '2.5M');
eq(numberToWords(1000000000), 'one billion', 'one billion');

// --- ordinals ------------------------------------------------------------
eq(ordinalToWords(1), 'first', '1st');
eq(ordinalToWords(2), 'second', '2nd');
eq(ordinalToWords(3), 'third', '3rd');
eq(ordinalToWords(4), 'fourth', '4th');
eq(ordinalToWords(5), 'fifth', '5th');
eq(ordinalToWords(8), 'eighth', '8th');
eq(ordinalToWords(9), 'ninth', '9th');
eq(ordinalToWords(12), 'twelfth', '12th');
eq(ordinalToWords(21), 'twenty-first', '21st');
eq(ordinalToWords(30), 'thirtieth', '30th');
eq(ordinalToWords(102), 'one hundred and second', '102nd');

// --- years ---------------------------------------------------------------
eq(yearToWords(1999), 'nineteen ninety-nine', '1999');
eq(yearToWords(2026), 'two thousand twenty-six', '2026');
eq(yearToWords(2005), 'two thousand five', '2005');
eq(yearToWords(1900), 'one thousand nine hundred', '1900');

// --- pipeline ------------------------------------------------------------
has('We closed 912 accounts.', 'nine hundred and twelve', 'bare cardinal');
has('The rate dropped to 2.4%.', 'two point four percent', 'decimal percent');
has('Q3 revenue', 'Third quarter', 'quarter abbreviation');
has('Dr. Chen flagged it', 'Doctor Chen', 'honorific');
has('It\'s done', 'It is done', 'contraction preserves sentence case');
has('A & B', 'and', 'ampersand');
has('$1,234.56 total', 'one thousand two hundred and thirty-four dollars and fifty-six cents', 'currency');
has('$1,234.56 per account', 'fifty-six cents per account', 'currency keeps following space');
has('$99', 'ninety-nine dollars', 'currency no cents');
has('$2.5M raised', 'two and a half million dollars raised', 'currency with M suffix');
has('20% of users', 'twenty percent of users', 'integer percent');
has('In 2026 we shipped', 'two thousand twenty-six', 'year');
has('Model H1 is fast', 'Model H1 is fast', 'alphanumeric untouched');
has('See https://example.com/x', 'https', 'url left alone');
has('from 5-10 units', 'five to ten units', 'range');
has('meet at 3pm', 'three p m', 'meridiem');
has('at 09:30', 'nine thirty', 'clock time');
has('at 11:59pm', 'eleven fifty-nine p m', 'clock time with meridiem');
has('call 555-123-4567', '555 123 4567', 'phone keeps digits');
has('call +1 555-123-4567.', 'one 555 123 4567', 'phone with country code and trailing period');
has('SKU-9921 ships', 'SKU-9921 ships', 'product code untouched');
has('A1-B2', 'A1-B2', 'hyphenated code untouched');
has('2.5M users', 'two and a half million users', 'magnitude suffix');
has('1.2B records', 'one point two billion records', 'decimal magnitude');
has('₹1,50,000', 'one lakh fifty thousand rupees', 'indian currency grouping');
has('Rs. 1,50,000', 'Rupees one lakh fifty thousand', 'indian grouping without symbol');
has('2026-10-21', 'October twenty-first', 'iso date');
has('Ms. Jones', 'Miss Jones', 'honorific Ms');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
