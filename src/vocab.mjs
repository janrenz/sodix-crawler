/**
 * Vokabular-Abbildungen SODIX v3 → AMB / KIM-SKOS.
 *
 * Alle Zielvokabulare sind gegen die lebenden SKOS-Schemata geprüft:
 *   HCRT   https://w3id.org/kim/hcrt/scheme.json          (26 Konzepte)
 *   ISCED  https://w3id.org/kim/isced-1997/scheme.json    (7 Stufen)
 *   Fächer https://w3id.org/kim/schulfaecher/index.json   (61 Fächer)
 *
 * Grundregel bei jeder verlustbehafteten Abbildung: der SODIX-Originalwert
 * wird zusätzlich als `ext:sodix:*`-Tag mitgeführt. Ein Mapping darf
 * vereinfachen, aber nichts verschwinden lassen.
 */

// Die deutschen Labels stammen aus den KIM-SKOS-Schemata selbst, nicht aus
// SODIX: SODIX liefert die Vokabularnamen gemischt (lrts/educationLevels/
// schoolTypes englisch, subjects/competences deutsch, lands sogar in sich
// gemischt). Ein SODIX-Name als `prefLabel.de` waere in den meisten Faellen
// eine falsche Sprachangabe.
const HCRT = (slug, de) => ({ id: `https://w3id.org/kim/hcrt/${slug}`, de });
const ISCED = (level, de) => ({ id: `https://w3id.org/kim/isced-1997/level${level}`, de });
const FACH = (id, de) => ({ id: `http://w3id.org/kim/schulfaecher/${id}`, de });

/**
 * SODIX-Lernressourcentyp → HCRT.
 * HCRT hat 26 Konzepte, SODIX 48 — die Abbildung ist notwendigerweise grob.
 * `other` heisst hier "in HCRT nicht abbildbar", nicht "unbekannt": der
 * genaue SODIX-Typ steht immer zusätzlich in `ext:sodix:ressourcentyp`.
 */
export const LEARNING_RESOURCE_TYPES = {
  APP: HCRT('application', "Softwareanwendung"),
  ARBEITSBLATT: HCRT('worksheet', "Arbeitsmaterial"),
  AUDIO: HCRT('audio', "Audio"),
  AUDIOVISUELLES: HCRT('video', "Video"),
  BILD: HCRT('image', "Abbildung"),
  DATEN: HCRT('data', "Daten"),
  ENTDECKENDES: HCRT('other', "Sonstiges"),
  EXPERIMENT: HCRT('experiment', "Experiment"),
  FALLSTUDIE: HCRT('case_study', "Fallstudie"),
  GLOSSAR: HCRT('index', "Nachschlagewerk"),
  HANDBUCH: HCRT('text', "Textdokument"),
  INTERAKTION: HCRT('other', "Sonstiges"),
  KARTE: HCRT('map', "Karte"),
  KURS: HCRT('course', "Kurs"),
  LERNKONTROLLE: HCRT('assessment', "Lernkontrolle"),
  LERNSPIEL: HCRT('educational_game', "Lernspiel"),
  MODELL: HCRT('other', "Sonstiges"),
  OFFENE: HCRT('other', "Sonstiges"),
  PROJECT: HCRT('other', "Sonstiges"),
  QUELLE: HCRT('index', "Nachschlagewerk"),
  RADIO: HCRT('video', "Video"),
  RECHERCHE: HCRT('other', "Sonstiges"),
  ROLLENSPIEL: HCRT('other', "Sonstiges"),
  SIMULATION: HCRT('simulation', "Simulation"),
  SOFTWARE: HCRT('application', "Softwareanwendung"),
  SONSTIGES: HCRT('other', "Sonstiges"),
  TEST: HCRT('assessment', "Lernkontrolle"),
  TEXT: HCRT('text', "Textdokument"),
  UBUNG: HCRT('drill_and_practice', "Übung"),
  UNTERRICHTSBAUSTEIN: HCRT('lesson_plan', "Unterrichtsplanung"),
  UNTERRICHTSPLANUNG: HCRT('lesson_plan', "Unterrichtsplanung"),
  VERANSCHAULICHUNG: HCRT('image', "Abbildung"),
  VIDEO: HCRT('video', "Video"),
  WEBSEITE: HCRT('web_page', "Webseite"),
  WEBTOOL: HCRT('application', "Softwareanwendung"),
  PRESENTATION: HCRT('slide', "Präsentation"),
  BROSCHUERE: HCRT('text', "Textdokument"),
  ANLEITUNG: HCRT('text', "Textdokument"),
  EBOOK: HCRT('textbook', "Lehrbuch"),
  FLYER: HCRT('text', "Textdokument"),
  HANDREICHUNG: HCRT('text', "Textdokument"),
  INFOGRAFIK: HCRT('diagram', "Diagramm"),
  LEHRBUCH: HCRT('textbook', "Lehrbuch"),
  MERKBLATT: HCRT('text', "Textdokument"),
  MUSIKNOTEN: HCRT('sheet_music', "Musiknoten"),
  POSTER: HCRT('image', "Abbildung"),
  REZEPT: HCRT('text', "Textdokument"),
  VIRTUAL: HCRT('simulation', "Simulation"),
};

/** SODIX-Bildungsstufe → ISCED-1997. */
export const EDUCATIONAL_LEVELS = {
  ELEMENTARBEREICH: ISCED('0', "Elementarbereich"),
  PRIMARBEREICH: ISCED('1', "Primarbereich"),
  SEKUNDARSTUFE_I: ISCED('2', "Sekundarbereich I"),
  SEKUNDARSTUFE_II: ISCED('3', "Sekundarbereich II"),
  FORT_UND_WEITERBILDUNG: ISCED('4', "Post-sekundarer, nicht-tertiärer Bereich"),
};

/**
 * SODIX-Oberfach (level 1, 38 Stück) → KIM-Schulfach.
 * Nur die fachlich tragfähigen Treffer; SODIX-Kategorien ohne KIM-Pendant
 * (etwa "Freizeit", "Heimatraum, Region", "Sachgebietsübergreifende Medien")
 * bleiben absichtlich unabgebildet und landen in `ext:sodix:fach`.
 */
export const SUBJECTS = {
  '020': FACH('s1048', "Arbeitslehre"), // Arbeitslehre
  '040': FACH('s1049', "Berufs- und Studienorientierung"), // Berufliche Bildung → Berufs- und Studienorientierung
  '060': FACH('s1015', "Kunst"), // Bildende Kunst → Kunst
  '080': FACH('s1001', "Biologie"), // Biologie
  100: FACH('s1002', "Chemie"), // Chemie
  120: FACH('s1005', "Deutsch"), // Deutsch
  160: FACH('s1008', "Ethik"), // Ethik
  200: FACH('s1050', "Fremdsprachen"), // Fremdsprachen
  220: FACH('s1010', "Geografie"), // Geografie
  240: FACH('s1011', "Geschichte"), // Geschichte
  260: FACH('s1012', "Gesundheit"), // Gesundheit
  320: FACH('s1013', "Informatik"), // Informationstechnische Bildung → Informatik
  380: FACH('s1017', "Mathematik"), // Mathematik
  400: FACH('s1046', "Medienbildung"), // Medienpädagogik → Medienbildung
  420: FACH('s1020', "Musik"), // Musik
  440: FACH('s1045', "Erziehungswissenschaften"), // Pädagogik → Erziehungswissenschaften
  450: FACH('s1021', "Philosophie"), // Philosophie
  460: FACH('s1022', "Physik"), // Physik
  480: FACH('s1023', "Politik"), // Politische Bildung → Politik
  510: FACH('s1043', "Psychologie"), // Psychologie
  520: FACH('s1055', "Religion"), // Religion
  560: FACH('s1029', "Sexualerziehung"), // Sexualerziehung
  600: FACH('s1031', "Sport"), // Sport
  700: FACH('s1033', "Wirtschaftskunde"), // Wirtschaftskunde
};
// Absichtlich nicht abgebildet, weil es in KIM kein tragfähiges Pendant gibt —
// diese landen vollständig in `ext:sodix:fach`:
//   140 Elementarbereich/Vorschulerziehung, 180 Freizeit, 300 Heimatraum/Region,
//   340 Interkulturelle Bildung, 360 Kinder- und Jugendbildung, 280 Grundschule,
//   500 Praxisorientierte Fächer, 540 Retten/Helfen/Schützen, 580 Spiel- und
//   Dokumentarfilm, 620 Sucht und Prävention, 640 Umweltschutz,
//   660 Verkehrserziehung, 680 Weiterbildung, 720 Sachgebietsübergreifende Medien

/**
 * SODIX-Sprachenum → BCP47 / ISO 639.
 * Die SODIX-Liste enthält drei Tippfehler (ALBANINAN, CHROATIAN, IRIS), die
 * hier bewusst auf den korrekten Code abgebildet werden.
 */
export const LANGUAGES = {
  GERMAN: 'de',
  ENGLISH: 'en',
  FRENCH: 'fr',
  SPANISH: 'es',
  RUSSIAN: 'ru',
  UKRAINIAN: 'uk',
  TURKISH: 'tr',
  ITALIAN: 'it',
  ARABIC: 'ar',
  DUTCH: 'nl',
  POLISH: 'pl',
  SWEDISH: 'sv',
  ROMANIAN: 'ro',
  PORTUGUESE: 'pt',
  PERSIAN: 'fa',
  GREEK: 'el',
  JAPANESE: 'ja',
  CHINESE: 'zh',
  NORWEGIAN: 'no',
  DANISH: 'da',
  CZECH: 'cs',
  KOREAN: 'ko',
  SLOVENIAN: 'sl',
  LATIN: 'la',
  TAMIL: 'ta',
  URDU: 'ur',
  KURDISH: 'ku',
  BULGARIAN: 'bg',
  LITHUANIAN: 'lt',
  HINDI: 'hi',
  FINNISH: 'fi',
  HUNGARIAN: 'hu',
  ROMANI: 'rom',
  AFRIKAANS: 'af',
  SWAHILI: 'sw',
  SERBIAN: 'sr',
  VIETNAMESE: 'vi',
  HEBREW: 'he',
  WOLOF: 'wo',
  ESTONIAN: 'et',
  THAI: 'th',
  MALAY: 'ms',
  SLOVAK: 'sk',
  CATALAN: 'ca',
  AMHARIC: 'am',
  ICELANDIC: 'is',
  BOSNIAN: 'bs',
  LATVIAN: 'lv',
  TAGALOG: 'tl',
  ARMENIAN: 'hy',
  TIBETAN: 'bo',
  SOMALI: 'so',
  INDONESIAN: 'id',
  PASHTO: 'ps',
  BENGALI: 'bn',
  GEORGIAN: 'ka',
  MONGOLIAN: 'mn',
  DZONGKHA: 'dz',
  MALTESE: 'mt',
  RUNDI: 'rn',
  MARSHALLESE: 'mh',
  ROMANSH: 'rm',
  NEPALI: 'ne',
  ZULU: 'zu',
  ASSAMESE: 'as',
  PANJABI: 'pa',
  INUKTITUT: 'iu',
  CENTRAL_KHMER: 'km',
  BASQUE: 'eu',
  WELSH: 'cy',
  KAZAKH: 'kk',
  GALICIAN: 'gl',
  QUECHUA: 'qu',
  MACEDONIAN: 'mk',
  AZERBAIJANI: 'az',
  AKAN: 'ak',
  TIGRINYA: 'ti',
  SORBIAN: 'wen',
  SWISS_GERMAN: 'gsw',
  ANCIENT_GREEK: 'grc',
  SIGN_LANGUAGE: 'sgn',
  // SODIX-Tippfehler, korrekt abgebildet:
  ALBANINAN: 'sq', // "Albanian"
  CHROATIAN: 'hr', // "Croatian"
  IRIS: 'ga', // "Irish"
};

/**
 * Werte, die SODIX unter `languages` führt, die aber keine Sprache benennen,
 * sondern eine Fassung oder ein Barrierefreiheitsmerkmal. Diese dürfen nicht
 * nach `inLanguage` — sie landen in `ext:sodix:sprachfassung`.
 */
export const LANGUAGE_MARKERS = new Set([
  'WITHOUT_LANGUAGE',
  'AUDIO_DESCRIPTION',
  'ORIGINAL_VERSION_WITH_SUBTITLES',
  'PLAIN_LANGUAGE',
  'SIMPLE_LANGUAGE',
  'SUBTITLES_FOR_THE_HEARING_IMPAIRED',
]);

/**
 * Normalisiert eine Creative-Commons-URL auf die kanonische Lizenz-URI.
 *
 * Wichtige Unterscheidung: `/deed.de` ist nur die deutschsprachige *Ansicht*
 * derselben Lizenz und wird entfernt. `/de/` bezeichnet dagegen die portierte
 * deutsche Lizenzfassung — eine eigene Lizenz, die erhalten bleiben muss.
 */
export function normalizeLicenseUrl(url) {
  if (!url) return null;
  let out = String(url).trim();
  if (!/^https?:\/\//i.test(out)) return null;
  out = out.replace(/^http:/i, 'https:');
  out = out.replace(/\/deed\.[a-z_-]+\/?$/i, '/');
  if (!out.endsWith('/')) out += '/';
  return out;
}

/** Ist das eine echte offene Lizenz (CC) — im Unterschied zu "Copyright, freier Zugang"? */
export function isOpenLicense(url) {
  const normalized = normalizeLicenseUrl(url);
  return Boolean(normalized && /creativecommons\.org/i.test(normalized));
}

/**
 * SODIX-Dauer `HH:MM:SS` → ISO-8601-Dauer `PTnHnMnS`.
 * Im gesamten Bestand kommt nur dieses eine Format vor (134.301 Werte geprüft).
 */
export function durationToIso8601(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d+):([0-5]\d):([0-5]\d)$/);
  if (!m) return null;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!h && !min && !s) return null;
  return `PT${h ? `${h}H` : ''}${min ? `${min}M` : ''}${s ? `${s}S` : ''}`;
}

/**
 * Entfernt C0-Steuerzeichen, fuer die NIP-01 keine Escape-Regel kennt.
 *
 * NIP-01 listet genau sieben zu escapende Zeichen (\n \" \\ \r \t \b \f) und
 * schreibt fuer alle anderen "verbatim" vor. Ein literales U+000B ist in JSON
 * aber ungueltig, weshalb JSON.stringify es zu \u000b escapt. Relay und Client
 * serialisieren dann unterschiedlich und kommen auf verschiedene Event-Hashes —
 * das Relay lehnt mit "invalid: id is computed incorrectly" ab.
 *
 * Betroffen sind die Zeichen ohne NIP-01-Escape: 0x00-0x07, 0x0B, 0x0E-0x1F,
 * 0x7F. In den SODIX-Beschreibungen sind das Reste aus Copy-und-Paste, die
 * inhaltlich nichts tragen.
 */
export function stripUnescapableControls(value) {
  if (typeof value !== 'string') return value;
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x07\x0b\x0e-\x1f\x7f]/g, '');
}

/** ISO-Datum aus den unterschiedlichen SODIX-Zeitformaten. */
export function toIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
