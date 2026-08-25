/**
 * Feldselektionen, generiert aus der GraphQL-Introspection von api3.sodix.de
 * und anschliessend von N+1-Bomben befreit.
 *
 * Wichtig: `source.publishers` pro Metadatensatz aufzuloesen kostet ~11x
 * Antwortzeit (100 Datensaetze: 9.0 s statt 0.8 s), weil der Server je Satz
 * die Publisher nachlaedt. Publisher und Sources werden darum als eigene,
 * kleine Dumps gecrawlt und ueber `source.id` bzw. `publisherId` verknuepft.
 * Wer die eingebettete Variante braucht: METADATA_FIELDS_FAT / --fat.
 */

export const METADATA_FIELDS = `
  id
  sodixId
  externalIds
  general {
    title
    description
    keywords
    languages { id name }
    availableTo
  }
  lifeCycle {
    author
    authorWebsite
    producer
    publishedTime
  }
  recordStatus
  tenantRecordStatus
  source {
    id
    name
    description
    status
    ltiEnabled
    website
    termsOfUse
    generalUseRights
    createdAt
    lastModifiedAt
    thumbnail
    createdBy
  }
  educational {
    targetAudience
    learningResourceType { id name }
    educationalLevel { id name }
    schoolType { id name }
    classLevel { id name }
    subject { id name level }
    competence { id name level }
  }
  media {
    url
    downloadUrl
    originalUrl
    thumbnail
    duration
    dataType
    size
    video360Degrees
  }
  relation {
    childMedia { totalCount }
    linkedObjects { totalCount }
  }
  hubbs {
    yearOfTraining { id name }
    occupationArea { id name occupationCodes level }
    learningField { id name }
    professionalLearningResourceType { id name }
    vocationalTrainingArea { id name }
    typeOfTraining { id name }
    vocationalSchoolCompetency { id name }
    federalState { id name }
    approvedByFederalState
    showInClosedArea
  }
  paymentType
  rights {
    cost { id name }
    license {
      id
      name
      version
      country
      url
      text
      categoryId
      categoryName
    }
    downloadRight
    additionalLicenseInformation
  }
  paidMetadataInfo {
    originalTitle
    extendedTitle
    seriesTitle
    subtitles { id name }
    producerCountries
    producerDate
    broadcastDates
    fsk { id name }
    usk { id name }
    didacticalRemarks
    distributor
    eafRawMetadata
  }
  updated
  updateTime
  createdAt
`;

/** Wie METADATA_FIELDS, aber mit eingebetteten Publishern (deutlich langsamer). */
export const METADATA_FIELDS_FAT = METADATA_FIELDS.replace(
  '    createdBy\n  }\n  educational',
  `    createdBy
    publishers {
      totalCount
      data {
        id
        title
        description
        thumbnail
        officialWebsite
        linkToGeneralUseRights
        createdAt
        lastModifiedAt
      }
    }
  }
  educational`
);

export const SOURCE_FIELDS = `
  id
  name
  description
  status
  ltiEnabled
  website
  termsOfUse
  generalUseRights
  createdAt
  lastModifiedAt
  thumbnail
  createdBy
  publishers { totalCount data { id title } }
`;
// Hinweis: `metadata { totalCount }` gibt es auf Source ebenfalls, ist aber
// serverseitig unbrauchbar — die Abfrage laeuft ~49 s je 100 Quellen und
// endet dann in "Exception while fetching data (/source/search/data[0]/metadata)".
// Die Zahl der Datensaetze je Quelle laesst sich stattdessen offline aus
// metadata.ndjson ueber source.id auszaehlen (siehe README).

export const PUBLISHER_FIELDS = `
  id
  title
  description
  thumbnail
  officialWebsite
  linkToGeneralUseRights
  createdAt
  lastModifiedAt
  sources { totalCount data { id name } }
`;

export const MEDIA_COLLECTION_FIELDS = `
  id
  sodixId
  title
  description
  keywords
  status
  createdBy
  createdAt
  lastModifiedAt
  firstPublishedAt
  availableFrom
  availableTo
  thumbnail
  metadata { totalCount data { id sodixId } }
`;

export const ME_FIELDS = `
  id
  username
  firstName
  lastName
  email
  roles
  currentTenant
  tenants
`;

/**
 * Alle Dictionary-Listen (Vokabulare) der API v3.
 * `name(language:)` gibt es nur bei vocationalSchoolCompetencies;
 * `subjects`/`competences` liefern zusaetzlich `level`.
 */
export const DICTIONARIES = [
  { field: 'vocationalSchoolCompetencies', selection: 'id name' },
  { field: 'vocationalTrainingArea', selection: 'id name' },
  { field: 'typesOfTraining', selection: 'id name' },
  { field: 'professionalLearningResourceTypes', selection: 'id name' },
  { field: 'yearsOfTraining', selection: 'id name' },
  { field: 'costs', selection: 'id name' },
  { field: 'fskUskValues', selection: 'id name' },
  { field: 'schoolTypes', selection: 'id name' },
  { field: 'educationLevels', selection: 'id name' },
  { field: 'lrtSubcategories', selection: 'id name' },
  { field: 'lrts', selection: 'id name' },
  { field: 'mediaTypes', selection: 'id name' },
  { field: 'lands', selection: 'id name' },
  { field: 'licenses', selection: 'id name' },
  { field: 'subjects', selection: 'id name level' },
  { field: 'competences', selection: 'id name level' },
  { field: 'classLevels', selection: 'id name' },
  { field: 'languages', selection: 'id name' },
  { field: 'learningFields', selection: 'id name' },
  { field: 'occupationAreas', selection: 'id name' },
  { field: 'eafLanguages', selection: 'id name' },
];

/** Alle von der API dokumentierten Datensatz-Status. */
export const RECORD_STATUSES = [
  'DRAFT',
  'CREATED',
  'ACTIVATED',
  'DEACTIVATED',
  'DISABLED',
  'REVISED',
  'UNAVAILABLE',
];
