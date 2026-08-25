/**
 * SODIX v3 → AMB ("Allgemeines Metadatenprofil für Bildungsressourcen").
 *
 * Das Ergebnis ist AMB-JSON-LD, das `amb-nostr-converter` von edufeed-org
 * unverändert zu kind:30142-Events verarbeitet. Diese Datei ist damit das
 * einzige Stück der Kette, das es noch nicht gab.
 *
 * Leitlinien:
 *  - AMB-Kernfelder werden nur belegt, wenn die Semantik wirklich passt.
 *  - Jede verlustbehaftete Abbildung (48 SODIX-Typen → 26 HCRT-Konzepte,
 *    2.043 Fächer → 61 KIM-Fächer) trägt den Originalwert zusätzlich als
 *    `ext:de.sodix:*`. Vereinfachen ja, verschwinden lassen nein.
 *  - Felder, die nur SODIX-intern Sinn haben (recordStatus, tenantRecordStatus),
 *    sind Filterkriterium und wandern nicht ungefragt in die Events.
 */

import {
  LEARNING_RESOURCE_TYPES,
  EDUCATIONAL_LEVELS,
  SUBJECTS,
  LANGUAGES,
  LANGUAGE_MARKERS,
  normalizeLicenseUrl,
  isOpenLicense,
  durationToIso8601,
  toIsoDate,
  stripUnescapableControls,
} from './vocab.mjs';

/** Reverse-DNS-Namespace, wie NIP-AMB es für neue Autoritäten empfiehlt. */
export const EXT_NS = 'de.sodix';

const AMB_CONTEXT = ['https://w3id.org/kim/amb/context.jsonld', { '@language': 'de' }];

const clean = (value) => {
  if (typeof value !== 'string') return null;
  // Steuerzeichen hier entfernen, nicht erst beim Signieren: sonst weicht die
  // Event-Serialisierung von der des Relays ab (siehe stripUnescapableControls).
  const trimmed = stripUnescapableControls(value).trim();
  return trimmed.length ? trimmed : null;
};

const list = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);

/** Concept aus einem KIM-Eintrag `{id, de}` — Label ist autoritativ deutsch. */
const kimConcept = (entry) => {
  if (!entry?.id) return null;
  const out = { id: entry.id, type: 'Concept' };
  if (entry.de) out.prefLabel = { de: entry.de };
  return out;
};

/**
 * Concept aus einem SODIX-Wert. `lang` ist die Sprache, in der das jeweilige
 * SODIX-Vokabular seine Namen führt (siehe EXT_LABEL_LANG). `null` bedeutet:
 * Sprache nicht verlässlich bestimmbar, dann wird kein prefLabel behauptet.
 */
const sodixConcept = (id, label, lang) => {
  const key = clean(id);
  if (!key) return null;
  const out = { id: key, type: 'Concept' };
  const text = clean(label);
  if (text && lang) out.prefLabel = { [lang]: text };
  return out;
};

/**
 * Sprache der Namen je SODIX-Vokabular — geprüft gegen dictionary.json.
 * SODIX ist hier inkonsistent: die meisten Vokabulare sind englisch, Fächer
 * und Kompetenzen deutsch, und `lands` mischt beides in einer Liste
 * ("Baden-Württemberg" neben "Bavaria"). Wo die Sprache nicht eindeutig ist,
 * steht `null` und es wird kein prefLabel geschrieben — der SODIX-Schlüssel
 * selbst bleibt als `id` erhalten.
 */
const EXT_LABEL_LANG = {
  ressourcentyp: 'en',
  bildungsstufe: 'en',
  schulform: 'en',
  klassenstufe: 'en',
  kostenstatus: 'en',
  ausbildungsjahr: 'en',
  ausbildungsart: 'en',
  ausbildungsbereich: 'en',
  berufsschulkompetenz: 'en',
  beruflicherRessourcentyp: 'en',
  fsk: 'en',
  usk: 'en',
  fach: 'de',
  berufsfeld: 'de',
  kompetenz: 'de',
  bundesland: null, // in sich gemischt
  lernfeld: null, // rein numerisch ("1", "2", "3")
};

/** Schema.org-Typ aus Ressourcentyp und IANA-Medientyp ableiten. */
function deriveType(record) {
  const lrts = list(record.educational?.learningResourceType).map((x) => x.id);
  const dataType = clean(record.media?.dataType) || '';
  const base = ['LearningResource'];

  if (lrts.includes('KURS')) return [...base, 'Course'];
  if (lrts.includes('PRESENTATION')) return [...base, 'PresentationDigitalDocument'];
  if (lrts.some((t) => ['VIDEO', 'AUDIOVISUELLES', 'RADIO'].includes(t)) || dataType.startsWith('video/')) {
    return [...base, 'VideoObject'];
  }
  if (lrts.includes('AUDIO') || dataType.startsWith('audio/')) return [...base, 'AudioObject'];
  if (lrts.some((t) => ['BILD', 'POSTER', 'INFOGRAFIK'].includes(t)) || dataType.startsWith('image/')) {
    return [...base, 'ImageObject'];
  }
  return base;
}

/** Sammler für `ext:de.sodix:*` — verwirft leere Facetten automatisch. */
class Ext {
  constructor() {
    this.facets = {};
  }
  scalar(facet, value) {
    const text = clean(typeof value === 'boolean' ? String(value) : value);
    if (!text) return;
    (this.facets[facet] ||= []).push(text);
  }
  concept(facet, id, label) {
    const c = sodixConcept(id, label, EXT_LABEL_LANG[facet] ?? null);
    if (c) (this.facets[facet] ||= []).push(c);
  }
  build() {
    return Object.keys(this.facets).length ? { [EXT_NS]: this.facets } : null;
  }
}

/**
 * Bildet einen SODIX-Metadatensatz auf AMB ab.
 *
 * @param {object} record  Ein Satz aus metadata.ndjson
 * @param {object} [options]
 * @param {(sodixId: string) => string} [options.idFor]  Erzeugt die AMB-`id`
 *        (wird das Nostr-`d`-Tag). Default: `urn:sodix:<sodixId>`.
 * @returns {{ok: true, amb: object} | {ok: false, reason: string}}
 */
export function sodixToAmb(record, options = {}) {
  const idFor = options.idFor || ((sodixId) => `urn:sodix:${sodixId}`);

  const sodixId = clean(record?.sodixId);
  if (!sodixId) return { ok: false, reason: 'kein sodixId' };
  // AMB verlangt `name`; ohne Titel ist der Satz nicht konform abbildbar.
  const name = clean(record.general?.title);
  if (!name) return { ok: false, reason: 'kein Titel' };

  const ext = new Ext();
  const amb = {
    '@context': AMB_CONTEXT,
    id: idFor(sodixId),
    type: deriveType(record),
    name,
  };

  const description = clean(record.general?.description);
  if (description) amb.description = description;

  const keywords = list(record.general?.keywords).map(clean).filter(Boolean);
  if (keywords.length) amb.keywords = [...new Set(keywords)];

  // Sprachen: echte Sprachcodes nach inLanguage, Fassungsmerkmale
  // (AUDIO_DESCRIPTION, PLAIN_LANGUAGE, …) nach ext — das sind keine Sprachen.
  const languages = new Set();
  for (const entry of list(record.general?.languages)) {
    const id = clean(entry.id);
    if (!id) continue;
    if (LANGUAGE_MARKERS.has(id)) {
      ext.scalar('sprachfassung', entry.name || id);
    } else if (LANGUAGES[id]) {
      languages.add(LANGUAGES[id]);
    } else {
      ext.scalar('sprache', entry.name || id);
    }
  }
  if (languages.size) amb.inLanguage = [...languages];

  // Urheber: SODIX liefert Autoren als Freitext-Liste, Produzent als Firma.
  const creators = list(record.lifeCycle?.author)
    .map(clean)
    .filter(Boolean)
    .map((author) => ({ type: 'Person', name: author }));
  const producer = clean(record.lifeCycle?.producer);
  if (producer) creators.push({ type: 'Organization', name: producer });
  if (creators.length) amb.creator = creators;

  const sourceName = clean(record.source?.name);
  if (sourceName) {
    const publisher = { type: 'Organization', name: sourceName };
    const website = clean(record.source?.website);
    if (website && /^https?:\/\//i.test(website)) publisher.id = website;
    amb.publisher = [publisher];
  }

  const dateCreated = toIsoDate(record.createdAt);
  if (dateCreated) amb.dateCreated = dateCreated;
  const datePublished = toIsoDate(record.lifeCycle?.publishedTime);
  if (datePublished) amb.datePublished = datePublished;
  const dateModified = toIsoDate(record.updateTime);
  if (dateModified) amb.dateModified = dateModified;

  // Lizenz: nur eine echte URI darf nach license.id. "Copyright, freier
  // Zugang" ist keine Lizenz-URI und wäre dort eine Falschaussage.
  const license = record.rights?.license || {};
  const licenseUrl = normalizeLicenseUrl(license.url);
  if (licenseUrl) amb.license = { id: licenseUrl };
  const licenseName = clean(license.name);
  if (licenseName && !licenseUrl) ext.scalar('lizenzname', licenseName);

  if (record.paymentType) amb.isAccessibleForFree = record.paymentType === 'NOT_PAID';
  const cost = record.rights?.cost;
  if (cost?.id) ext.concept('kostenstatus', cost.id, cost.name);
  if (typeof record.rights?.downloadRight === 'boolean') {
    ext.scalar('downloadRecht', record.rights.downloadRight);
  }
  const additional = clean(record.rights?.additionalLicenseInformation);
  if (additional) ext.scalar('lizenzhinweis', additional);

  // Bildung
  const lrtConcepts = [];
  for (const entry of list(record.educational?.learningResourceType)) {
    const target = LEARNING_RESOURCE_TYPES[entry.id];
    if (target) lrtConcepts.push(kimConcept(target));
    // Der SODIX-Typ bleibt immer erhalten: HCRT ist gröber als SODIX.
    ext.concept('ressourcentyp', entry.id, entry.name);
  }
  const uniqueLrt = [...new Map(lrtConcepts.filter(Boolean).map((c) => [c.id, c])).values()];
  if (uniqueLrt.length) amb.learningResourceType = uniqueLrt;

  const levels = [];
  for (const entry of list(record.educational?.educationalLevel)) {
    const target = EDUCATIONAL_LEVELS[entry.id];
    if (target) levels.push(kimConcept(target));
    else ext.concept('bildungsstufe', entry.id, entry.name);
  }
  const uniqueLevels = [...new Map(levels.filter(Boolean).map((c) => [c.id, c])).values()];
  if (uniqueLevels.length) amb.educationalLevel = uniqueLevels;

  const about = [];
  for (const entry of list(record.educational?.subject)) {
    const target = SUBJECTS[entry.id];
    if (target) about.push(kimConcept(target));
    else ext.concept('fach', entry.id, entry.name);
  }
  const uniqueAbout = [...new Map(about.filter(Boolean).map((c) => [c.id, c])).values()];
  if (uniqueAbout.length) amb.about = uniqueAbout;

  // Kompetenzen NICHT nach `teaches`: AMB verlangt dort eine URI als `id`,
  // SODIX liefert aber interne Zahlenschlüssel ("40004020201"). Die als URI
  // auszugeben waere schema-widrig, darum ext.
  for (const entry of list(record.educational?.competence)) {
    ext.concept('kompetenz', entry.id, entry.name);
  }

  // Schulform und Klassenstufe haben in AMB-core kein passendes Feld:
  // `audience` meint Rollen (Lernende/Lehrende), nicht Schularten.
  for (const entry of list(record.educational?.schoolType)) {
    ext.concept('schulform', entry.id, entry.name);
  }
  for (const entry of list(record.educational?.classLevel)) {
    ext.concept('klassenstufe', entry.id, entry.name);
  }
  const targetAudience = clean(record.educational?.targetAudience);
  if (targetAudience) ext.scalar('zielgruppe', targetAudience);

  // Technisches
  const media = record.media || {};
  const duration = durationToIso8601(media.duration);
  if (duration) amb.duration = duration;
  const thumbnail = clean(media.thumbnail);
  if (thumbnail) amb.image = thumbnail;

  const encoding = {};
  const contentUrl = clean(media.url);
  if (contentUrl) encoding.contentUrl = contentUrl;
  const dataType = clean(media.dataType);
  if (dataType) encoding.encodingFormat = dataType;
  if (media.size != null && String(media.size) !== '0') encoding.contentSize = String(media.size);
  if (Object.keys(encoding).length) {
    amb.encoding = [{ type: 'MediaObject', ...encoding }];
  }
  const downloadUrl = clean(media.downloadUrl);
  if (downloadUrl && downloadUrl !== contentUrl) ext.scalar('downloadUrl', downloadUrl);
  const originalUrl = clean(media.originalUrl);
  if (originalUrl) ext.scalar('originalUrl', originalUrl);
  if (media.video360Degrees === true) ext.scalar('video360', 'true');

  // Berufliche Bildung (hubbs) — vollständig SODIX-eigen, daher komplett ext.
  const hubbs = record.hubbs || {};
  const HUBBS_FACETS = [
    ['yearOfTraining', 'ausbildungsjahr'],
    ['occupationArea', 'berufsfeld'],
    ['learningField', 'lernfeld'],
    ['professionalLearningResourceType', 'beruflicherRessourcentyp'],
    ['vocationalTrainingArea', 'ausbildungsbereich'],
    ['typeOfTraining', 'ausbildungsart'],
    ['vocationalSchoolCompetency', 'berufsschulkompetenz'],
    ['federalState', 'bundesland'],
  ];
  for (const [field, facet] of HUBBS_FACETS) {
    for (const entry of list(hubbs[field])) ext.concept(facet, entry.id, entry.name);
  }
  if (hubbs.approvedByFederalState === true) ext.scalar('landesfreigabe', 'true');

  // Kaufmedien-Zusatzmetadaten
  const paid = record.paidMetadataInfo || {};
  ext.scalar('originaltitel', paid.originalTitle);
  ext.scalar('serientitel', paid.seriesTitle);
  ext.scalar('verleih', paid.distributor);
  ext.scalar('didaktischeHinweise', paid.didacticalRemarks);
  for (const country of list(paid.producerCountries)) ext.scalar('produktionsland', country);
  if (paid.fsk?.id) ext.concept('fsk', paid.fsk.id, paid.fsk.name);
  if (paid.usk?.id) ext.concept('usk', paid.usk.id, paid.usk.name);

  // Herkunft
  ext.scalar('sodixId', sodixId);
  if (record.source?.id) ext.scalar('quelleId', record.source.id);
  if (record.recordStatus) ext.scalar('datensatzstatus', record.recordStatus);

  const extObject = ext.build();
  if (extObject) amb.ext = extObject;

  return { ok: true, amb };
}

/** Filter für die Auswahl der auszuliefernden Teilmenge. */
export const FILTERS = {
  /** Nur echte offene Lizenzen (CC-URI). Rechtlich unstrittig. */
  cc: (r) => r.recordStatus === 'ACTIVATED' && isOpenLicense(r.rights?.license?.url),
  /** Alles Aktive ohne Bezahlpflicht — überwiegend urheberrechtlich geschützt. */
  free: (r) => r.recordStatus === 'ACTIVATED' && r.paymentType === 'NOT_PAID',
  /** Jeder aktive Datensatz, inklusive Kaufmedien. */
  activated: (r) => r.recordStatus === 'ACTIVATED',
  /** Keine Auswahl — alles, was im Dump liegt. */
  all: () => true,
};
