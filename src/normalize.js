/**
 * Text normalization for TTS.
 *
 * This is the single highest-leverage fix for "robotic" speech. Neural TTS
 * models read the literal characters you give them, so "912" comes out as
 * "nine hundred twelve" (or worse, "nine zero one two"), "$1,234.56" becomes
 * a stream of gibberish, and "Q3" is read letter-by-letter. Expanding these
 * into spoken form before synthesis is what separates "reads like a robot"
 * from "reads like a person".
 *
 * Pure functions, no dependencies, no I/O.
 */

const SMALL = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const SCALES = [
  { value: 1e12, word: 'trillion' },
  { value: 1e9, word: 'billion' },
  { value: 1e6, word: 'million' },
  { value: 1e3, word: 'thousand' },
];

const ORDINAL_WORDS = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth',
  nine: 'ninth', twelve: 'twelfth',
};

const IRREGULAR_ORDINALS = {
  'one hundredth': 'one hundredth',
};

/** Convert a number 0-999 into words. */
function chunkToWords(n) {
  if (n < 20) return SMALL[n];
  if (n < 100) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    return o ? `${TENS[t]}-${SMALL[o]}` : TENS[t];
  }
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const head = `${SMALL[h]} hundred`;
  return rest ? `${head} and ${chunkToWords(rest)}` : head;
}

/** Convert an integer (safe up to 2^53) into words. */
export function numberToWords(input) {
  const n = Math.trunc(Math.abs(input));
  if (n === 0) return 'zero';
  if (n < 1000) return chunkToWords(n);

  for (const { value, word } of SCALES) {
    if (n >= value) {
      const head = Math.floor(n / value);
      const rest = n % value;
      const headWords = `${numberToWords(head)} ${word}`;
      return rest ? `${headWords} ${numberToWords(rest)}` : headWords;
    }
  }
  return String(n);
}

/**
 * Years read differently from other cardinals: 1999 is "nineteen ninety-nine",
 * not "one thousand nine hundred and ninety-nine".
 */
export function yearToWords(year) {
  const y = Math.trunc(year);
  if (y >= 1100 && y < 2000 && !(y % 100 === 0)) {
    const hi = Math.floor(y / 100);
    const lo = y % 100;
    if (lo === 0) return `${numberToWords(hi)} hundred`;
    if (lo < 10) return `${numberToWords(hi)} oh ${SMALL[lo]}`;
    return `${numberToWords(hi)} ${chunkToWords(lo)}`;
  }
  if (y >= 2000 && y < 2100) {
    const lo = y % 100;
    const base = 'two thousand';
    if (lo === 0) return base;
    if (lo < 10) return `${base} ${SMALL[lo]}`;
    return `${base} ${numberToWords(lo)}`;
  }
  return numberToWords(y);
}

/** 21 -> "twenty-first" */
export function ordinalToWords(n) {
  const word = numberToWords(n);
  // Operate on the final segment only. numberToWords can produce compound
  // forms like "one hundred and twenty-one", so we cannot split on spaces
  // and take the last piece — we need the last space- or hyphen-delimited
  // token while preserving the rest of the phrase verbatim.
  const cut = Math.max(word.lastIndexOf(' '), word.lastIndexOf('-'));
  const head = word.slice(0, cut + 1);
  const last = word.slice(cut + 1);

  if (ORDINAL_WORDS[last]) return head + ORDINAL_WORDS[last];
  if (last === 'hundred') return head + 'hundredth';
  if (last.endsWith('y')) {
    // twenty -> twentieth, thirty -> thirtieth, ninety -> ninetieth
    return head + last.slice(0, -1) + 'ieth';
  }
  return head + last + 'th';
}

/** "2.4" -> "two point four" */
export function decimalToWords(intPart, fracPart) {
  const intWords = numberToWords(Number(intPart) || 0);
  const fracWords = fracPart.split('').map((d) => SMALL[Number(d)]).join(' ');
  return `${intWords} point ${fracWords}`;
}

/**
 * Money. Handles "$1,234.56", "£99", "€2.5M" and bare "1,234 dollars".
 */
function normalizeCurrency(text) {
  const CURRENCY = { $: 'dollars', '£': 'pounds', '€': 'euros', '¥': 'yen', '₹': 'rupees', '₽': 'rubles', '₩': 'won' };
  const UNIT_MULT = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9, t: 1e12 };

  return text.replace(
    /([$£€¥₹₽₩])\s*([\d,]+(?:\.\d+)?)(?:\s*([kKmMbB]|bn|[tT]))?(?![A-Za-z0-9])/g,
    (match, sym, numRaw, suffix) => {
      const unit = CURRENCY[sym];
      if (!unit) return match;

      // Split off the fractional part textually so the whole part keeps its
      // original digit grouping (Indian lakh/crore or Western thousands).
      const dotIdx = numRaw.indexOf('.');
      const intPart = dotIdx === -1 ? numRaw : numRaw.slice(0, dotIdx);
      const fracPart = dotIdx === -1 ? '' : numRaw.slice(dotIdx + 1);
      if (!Number.isFinite(Number(intPart.replace(/,/g, '')))) return match;
      const numWhole = Number(intPart.replace(/,/g, ''));
      const numFrac = fracPart ? Number(`0.${fracPart}`) : 0;

      // Pluralize the currency unit correctly ("dollar" -> "dollars", but
      // "dollars" must not become "dollarss").
      const plural = numWhole === 1 ? unit : (unit.endsWith('s') ? unit : `${unit}s`);

      // Scaled fractions read best as "two and a half million", not "two
      // million five hundred thousand". Half-steps land on clean words.
      if (suffix) {
        const mult = UNIT_MULT[suffix.toLowerCase()];
        const scaleWord = { k: 'thousand', m: 'million', b: 'billion', bn: 'billion', t: 'trillion' }[suffix.toLowerCase()];

        if (Math.abs(numFrac - 0.5) < 1e-9) {
          return `${numberToWords(numWhole)} and a half ${scaleWord} ${plural}`;
        }
        if (numFrac > 0) {
          const fracWords = fracPart.split('').map((d) => SMALL[Number(d)]).join(' ');
          return `${numberToWords(numWhole)} point ${fracWords} ${scaleWord} ${plural}`;
        }
        if (mult) {
          const scaled = numWhole * mult;
          const pluralScaled = scaled === 1 ? unit : (unit.endsWith('s') ? unit : `${unit}s`);
          return `${numberToWords(scaled)} ${pluralScaled}`;
        }
      }

      const wholeWords = speakNumericString(intPart);

      if (!fracPart || Number(fracPart) === 0) return `${wholeWords} ${plural}`;

      const cents = Math.round(Number(`0.${fracPart}`) * 100);
      const centPart = cents === 1 ? 'cent' : 'cents';
      const centWords = cents < 100
        ? numberToWords(cents)
        : `${numberToWords(Math.floor(cents / 100))} hundred ${numberToWords(cents % 100)}`;
      return `${wholeWords} ${plural} and ${centWords} ${centPart}`;
    },
  );
}

/**
 * Percentages: "2.4%" -> "two point four percent", "45%" -> "forty five percent".
 * Also handles "bps" (basis points) and "per cent" spellings.
 */
function normalizePercent(text) {
  return text.replace(
    /(-?[\d,]+(?:\.\d+)?)\s*(%|percent|per cent|bps|basis points?)\b/gi,
    (match, numRaw, unit) => {
      const u = unit.toLowerCase();
      const num = Number(numRaw.replace(/,/g, ''));
      if (!Number.isFinite(num)) return match;

      if (u === 'bps' || u === 'basis point' || u === 'basis points') {
        const bps = num / 100;
        const whole = Math.floor(bps);
        const frac = Math.round((bps - whole) * 100);
        if (frac === 0) return `${numberToWords(whole)} basis points`;
        return `${decimalToWords(String(whole), String(frac).padStart(2, '0'))} percent`;
      }
      const hasDecimal = numRaw.includes('.');
      const [i, f] = numRaw.replace(/,/g, '').split('.');
      const spoken = hasDecimal ? decimalToWords(i, f) : numberToWords(num);
      return `${spoken} percent`;
    },
  );
}

/**
 * Ordinals: "21st" -> "twenty first". Runs before cardinal number expansion
 * so the suffix isn't mangled.
 */
function normalizeOrdinals(text) {
  return text.replace(
    /(\d+)(st|nd|rd|th)\b/gi,
    (match, numRaw, suffix) => {
      const n = Number(numRaw);
      if (!Number.isFinite(n)) return match;
      // Validate the suffix actually matches the number, but be lenient:
      // sloppy source text uses "21th" and reading it as "twenty first" is
      // almost always what the author meant.
      return ordinalToWords(n);
    },
  );
}

/**
 * Years in context. Only 4-digit numbers in a plausible year range, and only
 * when they look like a standalone year (not part of a longer number).
 */
function normalizeYears(text) {
  return text.replace(
    /\b(1[89]\d{2}|20\d{2}|21\d{2})\b/g,
    (match, y) => {
      const n = Number(y);
      if (n < 1900 || n > 2100) return match;
      return yearToWords(n);
    },
  );
}

/**
 * Numbers with unit suffixes: "5km" -> "five kilometers", "10kg" -> "ten kilograms".
 * The unit is spoken in singular/plural based on the count.
 */
const UNIT_MAP = {
  km: 'kilometer', m: 'meter', cm: 'centimeter', mm: 'millimeter',
  kg: 'kilogram', g: 'gram', mg: 'milligram', lb: 'pound', oz: 'ounce',
  l: 'liter', ml: 'milliliter', h: 'hour', hr: 'hour', hrs: 'hours',
  min: 'minute', mins: 'minutes', sec: 'second', secs: 'seconds',
  mb: 'megabyte', gb: 'gigabyte', tb: 'terabyte', kb: 'kilobyte',
  px: 'pixel', v: 'volt', w: 'watt', kw: 'kilowatt', mw: 'megawatt',
};

/**
 * Time ranges: "3-5pm" -> "three to five p m", "09:30" -> "nine thirty".
 */
function normalizeTimes(text) {
  // Combined form first: "11:59pm", "9:05 a.m." — the meridiem is attached
  // to the minutes, so this has to match before the two forms are split.
  text = text.replace(/\b(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/gi, (match, hRaw, mRaw, ap) => {
    const h = Number(hRaw);
    const m = Number(mRaw);
    if (h > 23 || m > 59) return match;
    const hourWords = numberToWords(h);
    const minutes = m === 0 ? 'o clock' : (m < 10 ? `oh ${numberToWords(m)}` : numberToWords(m));
    const suffix = ap.toLowerCase() === 'a' ? 'a m' : 'p m';
    return `${hourWords} ${minutes} ${suffix}`;
  });

  // 9:30 / 09:30 -> nine thirty / nine oh thirty
  text = text.replace(/\b(\d{1,2}):(\d{2})\b/g, (match, hRaw, mRaw) => {
    const h = Number(hRaw);
    const m = Number(mRaw);
    if (h > 23 || m > 59) return match;
    const hourWords = numberToWords(h);
    if (m === 0) return `${hourWords} hundred hours`;
    if (m < 10) return `${hourWords} oh ${numberToWords(m)}`;
    return `${hourWords} ${numberToWords(m)}`;
  });

  // 3pm / 3 PM / 11a.m.
  text = text.replace(/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/gi, (match, hRaw, meridiem) => {
    const h = Number(hRaw);
    if (h > 12) return match;
    const suffix = meridiem.toLowerCase().replace(/\./g, '').startsWith('a') ? 'a m' : 'p m';
    return `${numberToWords(h)} ${suffix}`;
  });

  return text;
}

/**
 * Ranges: "5-10", "20–30" -> "five to ten", "twenty to thirty".
 */
function normalizeRanges(text) {
  return text.replace(
    /(?<![\w.$])(\d+)\s*[-–—]\s*(\d+)(?![\w.])/g,
    (match, a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (!Number.isFinite(na) || !Number.isFinite(nb)) return match;
      if (na > 9999 || nb > 9999) return match;
      return `${numberToWords(na)} to ${numberToWords(nb)}`;
    },
  );
}

/**
 * Months, for date expansion.
 */
const MONTHS = {
  january: 'January', february: 'February', march: 'March', april: 'April',
  may: 'May', june: 'June', july: 'July', august: 'August',
  september: 'September', october: 'October', november: 'November',
  december: 'December',
};

/**
 * ISO dates: 2026-10-21 -> "October twenty-first, two thousand twenty-six".
 *
 * Must run before the range pass, otherwise "2026-10" gets read as a range.
 */
function normalizeDates(text) {
  return text.replace(
    /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    (match, yRaw, mRaw, dRaw) => {
      const y = Number(yRaw);
      const m = Number(mRaw);
      const d = Number(dRaw);
      if (m < 1 || m > 12 || d < 1 || d > 31) return match;
      const monthName = Object.values(MONTHS)[m - 1];
      return `${monthName} ${ordinalToWords(d)}, ${yearToWords(y)}`;
    },
  );
}

/**
 * Magnitude suffixes on bare numbers: 2.5M -> "two and a half million",
 * 400k -> "four hundred thousand". Runs before the cardinal pass, because
 * the trailing letter would otherwise block the number from matching.
 */
function normalizeMagnitudes(text) {
  const SCALE_WORDS = {
    k: 'thousand', m: 'million', b: 'billion', bn: 'billion', t: 'trillion',
  };
  return text.replace(
    /(?<![\w.$])(\d+(?:\.\d+)?)\s*([kKmMbB]|bn)\b/g,
    (match, numRaw, suffix) => {
      const key = suffix.toLowerCase();
      const scale = SCALE_WORDS[key];
      const num = Number(numRaw);
      if (!Number.isFinite(num) || !scale) return match;

      const dotIdx = numRaw.indexOf('.');
      const wholeRaw = dotIdx === -1 ? numRaw : numRaw.slice(0, dotIdx);
      const fracRaw = dotIdx === -1 ? '' : numRaw.slice(dotIdx + 1);
      const whole = Number(wholeRaw);

      // "2.5M" -> "two and a half million"
      if (fracRaw && Math.abs(num - (whole + 0.5)) < 1e-9) {
        return `${numberToWords(whole)} and a half ${scale}`;
      }
      // "1.2B" -> "one point two billion" (read the actual digits, so a
      // trailing zero like "1.20B" doesn't become "one point two zero").
      if (fracRaw) {
        const trimmed = fracRaw.replace(/0+$/, '');
        if (trimmed) {
          const fracWords = trimmed.split('').map((d) => SMALL[Number(d)]).join(' ');
          return `${numberToWords(whole)} point ${fracWords} ${scale}`;
        }
      }
      return `${numberToWords(whole)} ${scale}`;
    },
  );
}

/**
 * Unit suffixes: 0.04s -> "zero point zero four seconds", 10ms -> "ten
 * milliseconds". The unit is pluralized by the count.
 */
function normalizeUnits(text) {
  const UNITS = {
    ms: 'millisecond', s: 'second', sec: 'second', secs: 'second',
    min: 'minute', mins: 'minute', h: 'hour', hr: 'hour', hrs: 'hour',
    day: 'day', days: 'day', wk: 'week', wks: 'week', mo: 'month', mos: 'month',
    yr: 'year', yrs: 'year', kb: 'kilobyte', mb: 'megabyte', gb: 'gigabyte',
    tb: 'terabyte', km: 'kilometer', cm: 'centimeter', mm: 'millimeter',
    kg: ' kilogram', g: 'gram', mg: 'milligram', ml: 'milliliter', l: 'liter',
    px: 'pixel', ghz: 'gigahertz', mhz: 'megahertz', hz: 'hertz',
    kbps: 'kilobit per second', mbps: 'megabit per second',
  };
  return text.replace(
    /(?<![\w.$])(\d+(?:\.\d+)?)\s*([A-Za-z]{1,5})\b/g,
    (match, numRaw, unitRaw) => {
      const key = unitRaw.toLowerCase();
      const unit = UNITS[key];
      if (!unit) return match;
      const num = Number(numRaw);
      if (!Number.isFinite(num)) return match;

      const spoken = numRaw.includes('.')
        ? decimalToWords(numRaw.split('.')[0], numRaw.split('.')[1])
        : numberToWords(num);
      // Pluralize when the count isn't exactly one.
      const plural = num === 1 ? unit : `${unit}s`;
      return `${spoken} ${plural}`;
    },
  );
}

/**
 * Product / ticket codes: SKU-9921, A1-B2, RFC-2616.
 *
 * These must be read as identifiers, not as numbers. Shield them before the
 * numeric passes so "SKU-9921" doesn't become "SKU nine thousand nine
 * hundred and twenty-one".
 *
 * The pattern is deliberately narrow — it requires a hyphen, or a
 * letter-prefixed run of 3+ digits. Anything looser starts eating ordinary
 * tokens like "Q3" or "3pm" that other passes handle better.
 */
const CODE_RE = /\b(?:[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*|[A-Za-z]{2,}[0-9]{3,})\b/g;

/**
 * Indian numbering: 1,50,000 -> "one lakh fifty thousand".
 * The lakh/crore grouping is 2,2,3 — not 3,3,3 — so it needs its own pass
 * before the Western thousands-separator pass sees it.
 */
const INDIAN_GROUP_RE = /^(\d{1,2}(?:,\d{2}){1,3},\d{3})$/;
const INDIAN_GROUP_SCAN_RE = /\b\d{1,2}(?:,\d{2}){1,3},\d{3}\b/g;

/**
 * Expand Indian-grouped numbers found anywhere in the text.
 */
function normalizeIndianGrouping(text) {
  return text.replace(INDIAN_GROUP_SCAN_RE, (match) => speakNumericString(match));
}

/**
 * Speak a raw numeric string, honouring Indian lakh/crore grouping when
 * present.
 *
 * Indian place values, right to left: the last three digits are plain
 * units, then each two-digit group steps up — thousand, lakh, crore.
 *   1,50,000   -> one lakh fifty thousand
 *   12,34,567  -> twelve lakh thirty-four thousand five hundred and sixty-seven
 *   1,234      -> one thousand two hundred and thirty-four  (Western grouping)
 */
export function speakNumericString(numRaw) {
  const m = String(numRaw).match(INDIAN_GROUP_RE);
  if (!m) return numberToWords(Number(String(numRaw).replace(/,/g, '')));

  const groups = m[1].split(',');
  const units = groups.pop(); // last three digits
  const pairs = groups.reverse(); // two-digit groups, highest first

  const parts = [];
  const unitsVal = Number(units);
  if (unitsVal) parts.push(numberToWords(unitsVal));

  const scaleNames = ['thousand', 'lakh', 'crore'];
  pairs.forEach((pair, i) => {
    const val = Number(pair);
    if (!val) return;
    const scale = scaleNames[Math.min(i, scaleNames.length - 1)];
    parts.unshift(`${numberToWords(val)} ${scale}`);
  });

  return parts.join(' ');
}

/**
 * Phone numbers. Digits stay digits — spelling "five five five" is worse
 * than saying "555". Only the country code gets spoken.
 *
 * Handles: +1 555-123-4567, (555) 123-4567, 555.123.4567, +15551234567.
 *
 * The trailing guard deliberately allows a sentence-ending period while
 * still refusing to match the first part of a longer digit run.
 */
const PHONE_RE = /(?<![\w.])(?:\+(\d{1,3})[\s.-]?)?\(?(\d{3})\)?[\s.-](\d{3})[\s.-](\d{4})(?!\d)(?!\d[.,]\d)/g;

function normalizePhone(text) {
  return text.replace(PHONE_RE, (match, cc, area, mid, last) => {
    const prefix = cc ? `${numberToWords(Number(cc))} ` : '';
    return `${prefix}${area} ${mid} ${last}`;
  });
}

/**
 * URLs and emails are not prose. Pull them out before any numeric pass so
 * "example.com/2026" doesn't become "example dot com two thousand
 * twenty-six".
 */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

/**
 * Swap matched spans for opaque placeholders so later passes can't rewrite
 * them, then restore them at the end.
 *
 * This is what keeps phone numbers intact: the phone pass rewrites
 * "555-123-4567" into "555 123 4567", and without protection the final
 * cardinal pass would turn those digits back into words.
 *
 * `tag` keeps each store's placeholders distinct so their indexes can never
 * collide.
 */
function protect(text, regex, transform, store, tag) {
  return text.replace(regex, (match, ...args) => {
    const idx = store.length;
    store.push(transform ? transform(match, ...args) : match);
    return `\u0000${tag}${idx}\u0000`;
  });
}

/**
 * Abbreviations and symbols that read badly when spoken literally.
 * Keys are matched case-sensitively where case carries meaning.
 */
const SYMBOL_REPLACEMENTS = [
  // Money-adjacent and misc symbols first
  [/\s*&\s*/g, ' and '],
  [/\s*@\s*/g, ' at '],
  [/\s*#\s*/g, ' number '],
  [/\s*%\s*/g, ' percent '],
  [/\s*\+\s*/g, ' plus '],
  [/=\s*/g, ' equals '],
  [/!\s*/g, '! '],
  [/\?/g, '?'],
  [/\s*\/\s*/g, ' slash '],
  [/\s*\*\s*/g, ' '],
  [/\s*<\s*/g, ' less than '],
  [/\s*>\s*/g, ' greater than '],
  [/\s*\|\s*/g, ' '],
  [/\s*~\s*/g, ' '],
  [/\$\s+/g, '$'],
];
// Ordered longest-first so "Accts." wins over "Acct."
const ABBREVIATIONS = [
  ['Drs.', 'Doctors'], ['Dr.', 'Doctor'], ['Mr.', 'Mister'], ['Mrs.', 'Missus'],
  ['Ms.', 'Miss'], ['Prof.', 'Professor'], ['St.', 'Saint'],
  ['vs.', 'versus'], ['etc.', 'et cetera'], ['e.g.', 'for example'],
  ['i.e.', 'that is'], ['approx.', 'approximately'], ['est.', 'estimated'],
  ['Inc.', 'Incorporated'], ['Ltd.', 'Limited'], ['Co.', 'Company'],
  ['Corp.', 'Corporation'], ['Dept.', 'Department'], ['Univ.', 'University'],
  ['Jan.', 'January'], ['Feb.', 'February'], ['Mar.', 'March'], ['Apr.', 'April'],
  ['Jun.', 'June'], ['Jul.', 'July'], ['Aug.', 'August'],
  ['Sep.', 'September'], ['Sept.', 'September'], ['Oct.', 'October'],
  ['Nov.', 'November'], ['Dec.', 'December'],
  ['Mon.', 'Monday'], ['Tue.', 'Tuesday'], ['Wed.', 'Wednesday'],
  ['Thu.', 'Thursday'], ['Fri.', 'Friday'], ['Sat.', 'Saturday'], ['Sun.', 'Sunday'],
  ['Q1', 'first quarter'], ['Q2', 'second quarter'], ['Q3', 'third quarter'],
  ['Q4', 'fourth quarter'],
  ['YoY', 'year over year'], ['QoQ', 'quarter over quarter'], ['MoM', 'month over month'],
  ['KPI', 'key performance indicator'], ['KPIs', 'key performance indicators'],
  ['ROI', 'return on investment'], ['B2B', 'business to business'],
  ['B2C', 'business to consumer'], ['SaaS', 'sass'], ['API', 'A P I'],
  ['URL', 'U R L'], ['UI', 'U I'], ['UX', 'U X'],
  ['pct.', 'percent'], ['ppt.', 'percentage points'], ['pp', 'percentage points'],
  ['acct.', 'account'], ['accts.', 'accounts'], ['admin.', 'administration'],
  ['approx', 'approximately'], ['avg.', 'average'], ['min.', 'minimum'],
  ['max.', 'maximum'], ['no.', 'number'], ['nos.', 'numbers'],
  ['ref.', 'reference'], ['refs.', 'references'], ['dept', 'department'],
  ['mfg.', 'manufacturing'], ['mgmt.', 'management'], ['mktg.', 'marketing'],
  ['hrs.', 'hours'], ['wk.', 'week'], ['wks.', 'weeks'], ['yr.', 'year'],
  ['yrs.', 'years'], ['mo.', 'month'], ['mos.', 'months'],
  ['ASAP', 'as soon as possible'], ['FYI', 'for your information'],
  ['FAQ', 'F A Q'], ['ETA', 'E T A'], ['TBD', 'to be determined'],
  ['FY', 'fiscal year'], ['OK', 'okay'], ['A/C', 'account'],
  ['EOD', 'end of day'], ['COB', 'close of business'], ['EOB', 'end of business'],
  ['PTO', 'paid time off'], ['WFH', 'work from home'], ['LGTM', 'looks good to me'],
  ['Rs.', 'rupees'], ['INR', 'rupees'], ['USD', 'U S dollars'],
  ['EUR', 'euros'], ['GBP', 'pounds'], ['JPY', 'yen'],
];

// Words that need a comma when spelled out, for smoother prosody.
const CONTRACTIONS = {
  "it's": 'it is', "don't": 'do not', "doesn't": 'does not', "didn't": 'did not',
  "can't": 'cannot', "won't": 'will not', "isn't": 'is not', "aren't": 'are not',
  "wasn't": 'was not', "weren't": 'were not', "haven't": 'have not',
  "hasn't": 'has not', "hadn't": 'had not', "shouldn't": 'should not',
  "wouldn't": 'would not', "couldn't": 'could not', "you're": 'you are',
  "we're": 'we are', "they're": 'they are', "I'm": 'I am', "I've": 'I have',
  "I'd": 'I would', "I'll": 'I will', "we'll": 'we will', "we've": 'we have',
  "that's": 'that is', "there's": 'there is', "what's": 'what is',
  "let's": 'let us', "he's": 'he is', "she's": 'she is',
};

/**
 * Full normalization pipeline.
 *
 * Order matters:
 *   1. contractions (before anything rewrites apostrophes)
 *   2. symbol cleanup
 *   3. ordinals (before cardinals)
 *   4. currency / percent (before bare numbers)
 *   5. times / ranges / phones (before bare numbers)
 *   6. years
 *   7. bare cardinals (last, catches everything left)
 */
export function normalize(text, options = {}) {
  const {
    expandContractions = true,
    expandAbbreviations = true,
    expandNumbers = true,
    spokenPunctuation = true,
  } = options;

  if (typeof text !== 'string' || !text) return '';

  let out = text;

  // Pass 0: shield non-prose spans (URLs, emails) from every later pass.
  const store = [];
  out = protect(out, URL_RE, null, store, 'U');
  out = protect(out, EMAIL_RE, null, store, 'U');

  // Shield phone numbers BEFORE the symbol pass — otherwise the "+" in
  // "+1 555-123-4567" is rewritten to "plus" and the country code is lost.
  // The digits stay digits; only the country code gets spoken on restore.
  const phoneStore = [];
  out = protect(out, PHONE_RE, null, phoneStore, 'F');

  if (expandContractions) {
    for (const [k, v] of Object.entries(CONTRACTIONS)) {
      out = out.replace(new RegExp(`\\b${k.replace(/'/g, "'")}\\b`, 'gi'), (m) => {
        // Preserve sentence-initial capitalization
        if (/^[A-Z]/.test(m) && m === m.toUpperCase()) return v.toUpperCase();
        if (/^[A-Z]/.test(m)) return v[0].toUpperCase() + v.slice(1);
        return v;
      });
    }
  }

  if (expandAbbreviations) {
    for (const [abbr, spoken] of ABBREVIATIONS) {
      const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Word-boundary-ish match that tolerates the dot in "Dr." and "Inc."
      const pattern = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'g');

      // Acronyms (all caps, no trailing dot) stay case-sensitive: "Q3" is a
      // quarter but "q3" might not be. Ordinary abbreviations like "approx."
      // match case-insensitively so "Approx." expands too.
      const isAcronym = /^[A-Z0-9/&]+$/.test(abbr);
      const flags = isAcronym ? 'g' : 'gi';

      out = out.replace(new RegExp(pattern.source, flags), (match, offset, whole) => {
        // Preserve sentence-initial capitalization: "Q3 revenue" should
        // become "Third quarter revenue", not "third quarter revenue".
        const before = whole.slice(0, offset);
        const atSentenceStart = /(^|[.!?]\s+)$/.test(before);
        if (atSentenceStart && /^[a-z]/.test(spoken)) {
          return spoken[0].toUpperCase() + spoken.slice(1);
        }
        return spoken;
      });
    }
  }

  for (const [pattern, replacement] of SYMBOL_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }

  // Shield identifier-like tokens (SKU-9921, A1-B2) from numeric expansion.
  // This runs AFTER abbreviation expansion so "Q3" can still become
  // "third quarter" instead of being mistaken for a code.
  const codeStore = [];
  out = protect(out, CODE_RE, null, codeStore, 'C');

  // Fiscal years: "FY24" -> "fiscal year twenty four", "FY2024" -> "fiscal
  // year twenty twenty-four". Runs after code protection so the digit run
  // isn't mistaken for an identifier.
  out = out.replace(/\bFY\s?(\d{2,4})\b/gi, (match, yrRaw) => {
    const yr = Number(yrRaw);
    if (!Number.isFinite(yr)) return match;
    // Two digits are a short year (24 -> 2024); four digits are explicit.
    const spoken = yrRaw.length === 2
      ? (yr >= 70 ? numberToWords(1900 + yr) : numberToWords(2000 + yr))
      : yearToWords(yr);
    return `fiscal year ${spoken}`;
  });

  if (expandNumbers) {
    // Currency runs BEFORE the Indian-grouping pass so "₹1,50,000" is still
    // one intact number when the currency regex sees it.
    out = normalizeCurrency(out);
    out = normalizeIndianGrouping(out);
    out = normalizeOrdinals(out);
    out = normalizePercent(out);
    out = normalizeMagnitudes(out);

    out = normalizeDates(out);
    out = normalizeTimes(out);
    out = normalizeRanges(out);
    out = normalizeUnits(out);
    out = normalizeYears(out);

    // Bare cardinals: numbers with optional thousands separators and decimals.
    out = out.replace(
      /(?<![\w.$])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\w.%])/g,
      (match, intRaw, fracRaw) => {
        const intVal = Number(intRaw.replace(/,/g, ''));
        if (!Number.isFinite(intVal)) return match;

        if (fracRaw) return decimalToWords(intRaw.replace(/,/g, ''), fracRaw);
        return speakNumericString(intRaw);
      },
    );
  }

  // Restore phones, then codes, then URLs and emails.
  out = out.replace(/\u0000F(\d+)\u0000/g, (_, i) => {
    const raw = phoneStore[Number(i)];
    return raw.replace(PHONE_RE, (m, cc, area, mid, last) => {
      const prefix = cc ? `${numberToWords(Number(cc))} ` : '';
      return `${prefix}${area} ${mid} ${last}`;
    });
  });

  out = out.replace(/\u0000C(\d+)\u0000/g, (_, i) => codeStore[Number(i)]);
  out = out.replace(/\u0000U(\d+)\u0000/g, (_, i) => store[Number(i)]);

  if (spokenPunctuation) {
    // Keep closing quotes attached to the sentence they end.
    out = out.replace(/\s+"/g, ' "');
  }

  // Collapse whitespace introduced by the replacements.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1');
  return out.trim();
}

/** Split text into sentences, keeping terminal punctuation attached. */
export function splitSentences(text) {
  if (!text) return [];
  const parts = text
    .split(/(?<=[.!?])\s+(?=[A-Z"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}

export default { normalize, splitSentences, numberToWords, ordinalToWords, yearToWords };
