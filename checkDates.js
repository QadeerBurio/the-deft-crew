const XLSX = require('xlsx');
const wb = XLSX.readFile('Ticketwala_Karachi_Events.xlsx');
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

function parseEventDate(rawDate) {
  if (!rawDate) return null;
  let str = String(rawDate).trim();
  if (!str || str.toUpperCase() === 'TBA' || str.toUpperCase() === 'TBD') return null;

  // 1. Strip ordinals
  str = str.replace(/(\d+)(st|nd|rd|th)/gi, '$1');

  // 2. Range of days: '5 - 6 Sep 2026' -> '5 Sep 2026'
  str = str.replace(/(\b\d{1,2})\s*(?:-|–|—|to)\s*\d{1,2}\b/gi, '$1');

  // 3. Extract time if present (e.g. 5:00 pm, 7:00-10:00 pm, 8:00 pm-12:00 am)
  let hours = 0, minutes = 0;
  const timeMatch = str.match(/(\d{1,2})(?::(\d{2}))?\s*(?:-\s*\d{1,2}(?::\d{2})?\s*)?(am|pm)/i);
  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3].toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
  }

  // 4. Find month
  const monthMatch = str.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i);
  if (!monthMatch) return null;
  const monthIndex = MONTHS[monthMatch[1].toLowerCase().slice(0, 3)];

  // 5. Find year
  const yearMatch = str.match(/\b(20\d{2})\b/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

  // 6. Find day number (e.g. 5 Sep 2026 -> 5)
  // Remove year and time from str to avoid picking year/time digits as day
  let dayStr = str.replace(/\b(20\d{2})\b/, '').replace(/\d{1,2}(?::\d{2})?\s*(?:-\s*\d{1,2}(?::\d{2})?\s*)?(am|pm)/gi, '');
  const dayMatch = dayStr.match(/\b(\d{1,2})\b/);
  if (!dayMatch) return null;
  const day = parseInt(dayMatch[1], 10);

  return new Date(Date.UTC(year, monthIndex, day, hours, minutes, 0));
}

let failed = 0;
rows.forEach((r, idx) => {
  const parsed = parseEventDate(r.date);
  if (!parsed || isNaN(parsed.getTime())) {
    console.error(`Row ${idx+1} FAILED: "${r.date}"`);
    failed++;
  } else {
    console.log(`Row ${idx+1}: "${r.date}" -> ${parsed.toISOString()}`);
  }
});
console.log(`Total failed: ${failed} out of ${rows.length}`);
