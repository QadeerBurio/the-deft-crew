const XLSX = require('xlsx');
const { Event } = require('../../models/Event');
const eventSocket = require('../../socket/eventSocket');

const DEFAULT_CATEGORY_IMAGES = {
  concert: '/assets/images/categories/concert.svg',
  workshop: '/assets/images/categories/workshop.svg',
  festival: '/assets/images/categories/festival.svg',
  'open mic': '/assets/images/categories/open_mic.svg',
  tech: '/assets/images/categories/tech.svg',
  networking: '/assets/images/categories/networking.svg',
  exhibition: '/assets/images/categories/exhibition.svg',
  sports: '/assets/images/categories/sports.svg',
  default: '/assets/images/categories/default_event.svg'
};

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

// Known Pakistani cities for normalization (case-insensitive match)
const KNOWN_CITIES = [
  'Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad',
  'Multan', 'Peshawar', 'Quetta', 'Hyderabad', 'Sialkot',
  'Gujranwala', 'Bahawalpur', 'Sargodha', 'Sukkur', 'Larkana'
];

function escapeRegExp(string) {
  return (string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ✅ FIX: Normalize a city string coming from CSV/XLSX.
 * - Trims whitespace
 * - Matches against known city names case-insensitively
 * - Returns canonical casing if matched, otherwise returns the trimmed raw value
 * - Returns '' (empty string) if the input is empty/undefined so we never
 *   silently fall back to "Karachi".
 */
function normalizeCity(rawCity) {
  if (!rawCity) return '';
  const trimmed = String(rawCity).trim();
  if (!trimmed) return '';

  // If multiple cities are listed (e.g. "Lahore, Karachi, Islamabad"),
  // take the first one as the primary city.
  const first = trimmed.split(',')[0].trim();
  if (!first) return '';

  const match = KNOWN_CITIES.find(
    (c) => c.toLowerCase() === first.toLowerCase()
  );
  return match || first;
}

/**
 * ✅ FIX: Try to extract a city from the venue / location string when the
 * dedicated `city` column is missing or empty. Matches known city names
 * anywhere in the string (case-insensitive).
 */
function inferCityFromLocation(location) {
  if (!location) return '';
  const haystack = String(location).toLowerCase();
  for (const city of KNOWN_CITIES) {
    if (haystack.includes(city.toLowerCase())) {
      return city;
    }
  }
  return '';
}

function parseEventDate(rawDate) {
  if (!rawDate) return null;

  if (rawDate instanceof Date) {
    return isNaN(rawDate.getTime()) ? null : rawDate;
  }

  if (typeof rawDate === 'number') {
    const d = new Date((rawDate - 25569) * 86400 * 1000);
    return isNaN(d.getTime()) ? null : d;
  }

  let str = String(rawDate).trim();
  if (!str || str.toUpperCase() === 'TBA' || str.toUpperCase() === 'TBD') {
    return null;
  }

  try {
    str = str.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
    str = str.replace(/(\b\d{1,2})\s*(?:-|–|—|to)\s*\d{1,2}\b/gi, '$1');

    let hours = 0;
    let minutes = 0;
    const timeMatch = str.match(/(\d{1,2})(?::(\d{2}))?\s*(?:(?:-|to)\s*\d{1,2}(?::\d{2})?)?\s*(am|pm)/i);
    if (timeMatch) {
      hours = parseInt(timeMatch[1], 10);
      minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const ampm = timeMatch[3].toLowerCase();
      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;
    }

    const monthMatch = str.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i);
    if (!monthMatch) {
      console.warn(`⚠️ [csvImporter] Unable to parse month from date: "${rawDate}"`);
      return null;
    }
    const monthKey = monthMatch[1].toLowerCase().slice(0, 3);
    const monthIndex = MONTHS[monthKey];

    const yearMatch = str.match(/\b(20\d{2})\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : 2026;

    const dayCleanStr = str
      .replace(/\b(20\d{2})\b/, '')
      .replace(/\d{1,2}(?::\d{2})?\s*(?:(?:-|to)\s*\d{1,2}(?::\d{2})?)?\s*(am|pm)/gi, '');
    const dayMatch = dayCleanStr.match(/\b(\d{1,2})\b/);
    if (!dayMatch) {
      console.warn(`⚠️ [csvImporter] Unable to parse day from date: "${rawDate}"`);
      return null;
    }
    const day = parseInt(dayMatch[1], 10);

    const utcDate = new Date(Date.UTC(year, monthIndex, day, hours, minutes, 0));
    if (isNaN(utcDate.getTime())) {
      console.warn(`⚠️ [csvImporter] Invalid Date result for "${rawDate}"`);
      return null;
    }

    return utcDate;
  } catch (err) {
    console.warn(`⚠️ [csvImporter] Error parsing date "${rawDate}": ${err.message}`);
    return null;
  }
}

function getEventImage(row, category) {
  const rawImage = row.image || row.image_url || row.imageurl || row.source_image || row.photo;
  if (rawImage && typeof rawImage === 'string' && rawImage.trim().length > 0) {
    return rawImage.trim();
  }

  const catLower = (category || '').toString().toLowerCase().trim();

  if (catLower.includes('concert') || catLower.includes('music') || catLower.includes('qawwali') || catLower.includes('rave')) {
    return DEFAULT_CATEGORY_IMAGES.concert;
  }
  if (catLower.includes('workshop') || catLower.includes('seminar') || catLower.includes('education')) {
    return DEFAULT_CATEGORY_IMAGES.workshop;
  }
  if (catLower.includes('festival') || catLower.includes('carnival') || catLower.includes('gala') || catLower.includes('food') || catLower.includes('market')) {
    return DEFAULT_CATEGORY_IMAGES.festival;
  }
  if (catLower.includes('open mic') || catLower.includes('comedy') || catLower.includes('theatre') || catLower.includes('film')) {
    return DEFAULT_CATEGORY_IMAGES['open mic'];
  }
  if (catLower.includes('tech')) {
    return DEFAULT_CATEGORY_IMAGES.tech;
  }
  if (catLower.includes('network') || catLower.includes('meetup') || catLower.includes('conference') || catLower.includes('talk') || catLower.includes('social') || catLower.includes('book')) {
    return DEFAULT_CATEGORY_IMAGES.networking;
  }
  if (catLower.includes('exhibition') || catLower.includes('expo') || catLower.includes('fashion') || catLower.includes('showcase')) {
    return DEFAULT_CATEGORY_IMAGES.exhibition;
  }
  if (catLower.includes('adventure') || catLower.includes('trip') || catLower.includes('sport') || catLower.includes('game')) {
    return DEFAULT_CATEGORY_IMAGES.sports;
  }

  return DEFAULT_CATEGORY_IMAGES.default;
}

function parseEventsFile(filePathOrBuffer, originalFilename = '') {
  let workbook;

  if (Buffer.isBuffer(filePathOrBuffer)) {
    workbook = XLSX.read(filePathOrBuffer, { type: 'buffer', cellDates: true });
  } else if (typeof filePathOrBuffer === 'string') {
    workbook = XLSX.readFile(filePathOrBuffer, { cellDates: true });
  } else {
    throw new Error('Invalid input: Expected file path string or Buffer.');
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];

  const worksheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

  const events = rawRows.map((row) => {
    // Normalize header keys to lowercase with underscores
    const normalizedRow = {};
    for (const key of Object.keys(row)) {
      const cleanKey = key.trim().toLowerCase().replace(/\s+/g, '_');
      normalizedRow[cleanKey] = row[key];
    }

    const title = (normalizedRow.name || normalizedRow.title || normalizedRow.event_name || '').toString().trim();
    const rawDate = (normalizedRow.date || normalizedRow.event_date || normalizedRow.time || '').toString().trim();
    const location = (normalizedRow.venue || normalizedRow.location || normalizedRow.place || '').toString().trim();
    const description = (normalizedRow.description || normalizedRow.desc || normalizedRow.details || '').toString().trim();
    const category = (normalizedRow.category || normalizedRow.type || '').toString().trim();
    const externalUrl = (normalizedRow.source_url || normalizedRow.sourceurl || normalizedRow.url || normalizedRow.link || '').toString().trim();

    // ✅ FIX: Read the city column (supports several header spellings).
    const rawCity =
      normalizedRow.city ||
      normalizedRow.event_city ||
      normalizedRow.town ||
      '';

    // ✅ FIX: Normalize the explicit city first, then fall back to inferring
    // the city from the venue/location string. NEVER default to "Karachi".
    let city = normalizeCity(rawCity);
    if (!city) {
      city = inferCityFromLocation(location);
    }
    if (!city) {
      city = inferCityFromLocation(title); // last resort — some titles include the city
    }

    // Skip empty rows without title
    if (!title) return null;

    const parsedDate = parseEventDate(rawDate);
    const image = getEventImage(normalizedRow, category);

    const eventObj = {
      title,
      date: rawDate,
      parsedDate,
      location,
      description,
      type: category || 'General',
      categories: category ? [category] : [],
      externalUrl,
      image,
      city,                       // ✅ FIX: real city value (may be '' if unknown)
      source: 'csv',
      sourceId:
        externalUrl ||
        `${title}_${rawDate}`.replace(/[^a-zA-Z0-9]/g, '_')
    };

    return eventObj;
  }).filter(Boolean);

  return events;
}

async function importEventsToDatabase(filePathOrBuffer, originalFilename = '') {
  const parsedEvents = parseEventsFile(filePathOrBuffer, originalFilename);

  let added = 0;
  let skipped = 0;
  const insertedEvents = [];

  for (const eventData of parsedEvents) {
    const titleTrimmed = eventData.title.trim();
    const dateTrimmed = eventData.date.trim();
    const locationTrimmed = eventData.location.trim();

    const existing = await Event.findOne({
      title: { $regex: new RegExp(`^${escapeRegExp(titleTrimmed)}$`, 'i') },
      date: { $regex: new RegExp(`^${escapeRegExp(dateTrimmed)}$`, 'i') },
      location: { $regex: new RegExp(`^${escapeRegExp(locationTrimmed)}$`, 'i') }
    });

    if (existing) {
      skipped++;
    } else {
      const newEvent = new Event({
        ...eventData,
        isImported: true,
        lastSynced: new Date()
      });
      const savedEvent = await newEvent.save();
      added++;
      insertedEvents.push(savedEvent);
    }
  }

  if (added > 0 && eventSocket && typeof eventSocket.emitNewEventsImported === 'function') {
    try {
      eventSocket.emitNewEventsImported(added, insertedEvents);
    } catch (err) {
      console.warn('⚠️ [csvImporter] Socket notification failed:', err.message);
    }
  }

  return {
    total: parsedEvents.length,
    added,
    skipped,
    insertedEvents
  };
}

module.exports = {
  parseEventsFile,
  importEventsToDatabase,
  parseEventDate,
  normalizeCity,
  inferCityFromLocation,
  DEFAULT_CATEGORY_IMAGES
};