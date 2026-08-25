# SODIX Crawler (API v3)

Holt den kompletten Inhaltsbestand aus der SODIX GraphQL API v3 als NDJSON —
Metadatensätze, Quellen, Herausgeber, Medien-Sammlungen, alle Vokabular-Listen
und das GraphQL-Schema. Ohne Abhängigkeiten, nur Node ≥ 20.

Grundlage: [Dokumentation SODIX API v3](https://fwu-de.atlassian.net/wiki/spaces/SXDOC/pages/966132836/Dokumentation+SODIX+API+v3)
plus Introspection der laufenden API.

## Schnellstart

```bash
cp .env.example .env   # Zugangsdaten eintragen
```

```bash
node bin/sodix-crawl.mjs stats
```

```bash
node bin/sodix-crawl.mjs all --status all
```

`stats` zählt nur und lädt nichts herunter — guter erster Test der Zugangsdaten.
`all` schreibt den Vollabzug nach `./data`.

## Bestand (gemessen auf api3.sodix.de, 24.08.2026)

| Datensatzart | Anzahl |
|---|---|
| Metadaten `ACTIVATED` | 140.175 |
| Metadaten `UNAVAILABLE` | 66.984 |
| Metadaten `DEACTIVATED` | 7.061 |
| Metadaten `DISABLED` | 1.551 |
| Metadaten `CREATED` | 97 |
| Metadaten `DRAFT` / `REVISED` | 0 |
| **Metadaten gesamt** | **215.868** |
| Quellen | 1.985 |
| Herausgeber | 972 |
| Medien-Sammlungen | 60 |
| Vokabular-Listen | 21 |

Für die Auslieferung sind laut Dokumentation nur `ACTIVATED`-Datensätze relevant;
Default des Crawlers ist daher `--status ACTIVATED`.

## Befehle

| Befehl | Wirkung |
|---|---|
| `all` | dictionary + me + sources + publishers + collections + metadata |
| `metadata` | Metadatensätze (der große Teil) |
| `sources` | Quellen inkl. zugeordneter Herausgeber |
| `publishers` | Herausgeber inkl. zugeordneter Quellen |
| `collections` | Medien-Sammlungen inkl. Mitglieder-IDs |
| `dictionary` | alle 21 Vokabular-Listen in eine JSON-Datei |
| `me` | eigener Account, Mandant, Rollen |
| `stats` | nur Datensatzzahlen zählen |
| `schema` | vollständige Introspection als JSON |

Die wichtigsten Optionen (`--help` zeigt alle):

| Option | Wirkung |
|---|---|
| `--status all` | jeden Datensatzstatus statt nur `ACTIVATED` |
| `--tenant-only` | nur vom Mandanten freigeschaltete Datensätze |
| `--since 2026-08-01` | Delta-Lauf über `time.anyUpdate.from` |
| `--page-size` / `--concurrency` | Durchsatz justieren (Default 100 / 4) |
| `--gzip` | NDJSON komprimiert schreiben |
| `--limit 500 --fresh` | schneller Testlauf |
| `--fat` | Herausgeber in jeden Metadatensatz einbetten |

## Ausgabe

```
data/
  metadata.ndjson             ein Metadatensatz pro Zeile
  metadata.checkpoint.json    Fortschritt (für Resume)
  sources.ndjson
  publishers.ndjson
  media-collections.ndjson
  metadata.unreadable.json    serverseitig defekte Datensätze (nur falls vorhanden)
  dictionary.json             alle 21 Vokabular-Listen
  account.json                auth.me
  stats.json                  Datensatzzahlen
  run-summary.json            Laufprotokoll: Optionen, Dauer, Requests, Ergebnisse
```

NDJSON, weil es streambar ist und ein Abbruch nur die letzte Zeile beschädigt —
nicht die ganze Datei. Auswerten z. B. so:

```bash
jq -r '[.sodixId, .general.title, .media.dataType] | @tsv' data/metadata.ndjson | head
```

Datensätze je Quelle offline auszählen (die API-seitige Variante ist unbrauchbar,
siehe *Fallstricke*):

```bash
jq -r '.source.name' data/metadata.ndjson | sort | uniq -c | sort -rn | head -20
```

## Abbruch und Wiederaufnahme

Derselbe Befehl setzt einen abgebrochenen Lauf fort — auch nach `kill -9`:

```bash
node bin/sodix-crawl.mjs metadata --status all
```

Der Checkpoint hält die fertig geschriebenen Seiten. Zusätzlich liest der Crawler
beim Resume die bereits gespeicherten IDs ein und verwirft Duplikate. Eine Seite
wird erst *nach* dem Schreiben als erledigt vermerkt, der Fehler geht also immer
in die harmlose Richtung: im schlimmsten Fall wird eine Seite erneut geholt und
dedupliziert. Getestet mit `kill -9` mitten im Lauf — Ergebnis: 3.000 Zeilen,
0 Duplikate, 0 beschädigte Zeilen.

`--fresh` erzwingt einen Neuanfang. Ändert sich die Abfrage (Status, Filter,
Seitengröße, Feldliste), verwirft der Crawler den alten Fortschritt automatisch,
weil die Seitengrenzen dann nicht mehr passen.

## Delta-Läufe

Für den laufenden Betrieb reicht ein täglicher Delta-Lauf über `time.anyUpdate`:

```bash
node bin/sodix-crawl.mjs metadata --since 2026-08-23 --out data/delta-2026-08-24
```

`anyUpdate` erfasst jede Änderung, `--created-since` (`time.createdAt.from`) nur
Neuanlagen. Gelöschte bzw. deaktivierte Datensätze erkennt man nicht über einen
Delta-Lauf — dafür regelmäßig mit `--status all` voll abziehen und die
`recordStatus`-Werte vergleichen.

## Fallstricke der API (gemessen, nicht geraten)

**Paging ist 0-basiert.** `page: 0` ist die erste Seite. `page: 1` liefert bereits
Seite zwei — mit 1-basierter Annahme fehlen die ersten `pageSize` Datensätze
stillschweigend. Ein Offset-Limit gibt es nicht: Offset 140.000 liefert
zuverlässig Daten.

**`source.publishers` pro Metadatensatz ist eine N+1-Bombe.** 100 Datensätze
brauchen damit 9,0 s statt 0,8 s, `pageSize: 1000` endet im `504 Gateway
Time-out` nach 60 s. Der Crawler holt Herausgeber deshalb als eigenen, kleinen
Dump (972 Datensätze) und verknüpft über `source.id`. Wer die eingebettete
Variante wirklich braucht: `--fat`.

**`Source.metadata.totalCount` ist serverseitig defekt.** ~49 s je 100 Quellen und
dann `Exception while fetching data (/source/search/data[0]/metadata) : null`.
Das Feld ist bewusst nicht in der Feldliste; die Zahl lässt sich offline aus
`metadata.ndjson` auszählen (siehe oben). Bei `MediaCollection` funktioniert das
gleichnamige Feld dagegen einwandfrei.

**Einzelne Datensätze sind serverseitig defekt und reißen die ganze Seite mit.**
Betroffene Sätze antworten auf *jede* Abfrage mit `Exception while fetching data
(/metadata/search) : null` — auch auf `{ id }` allein, auch über
`metadata.bySodixId`. Clientseitig ist da nichts zu retten. Im Vollabzug über
alle Status waren 174 von 2.159 Seiten betroffen; ohne Gegenmaßnahme kostet ein
defekter Satz seine 99 gesunden Nachbarn, also bis zu 17.400 Datensätze.

Der Crawler teilt eine nicht ladbare Seite deshalb auf (100 → 10 → 1) und
rettet, was zu retten ist. Nur die tatsächlich unlesbaren Offsets landen in
`metadata.unreadable.json` — der Verlust ist damit protokolliert und nicht
stillschweigend. Beispiel aus dem Testlauf:

```
[metadata] Seite 139 nicht ladbar (Exception while fetching data ...) — teile auf
[metadata] Datensatz an Offset 13994 ist serverseitig unlesbar
[metadata] Seite 139: 99 von 100 Datensaetzen gerettet
```

Diese Datensätze lassen sich nur über den SODIX-Support klären; ein
`metadata.unreadable.json` mit Inhalt ist ein Ticket wert.

**Introspection ist gedrosselt.** Mehrere `inputFields`-Blöcke in einer Abfrage
werden mit `BadFaithIntrospection` abgelehnt: *"This request is not asking for
introspection in good faith"*. Der `schema`-Befehl fragt Input-Typen daher
einzeln ab.

**`pageSize` maximal 1000**, praktikabel sind 100–200. Ohne Angabe liefert die API
nur 10 Datensätze.

**Sortierung:** nur *ein* `orderBy`-Feld erlaubt, mehrere führen zum Fehler. Der
Crawler nutzt `createdAt: ASC`, damit während des Laufs neu angelegte Datensätze
am Ende anwachsen und keine bereits gelesene Seite verschieben. Nach dem
regulären Durchlauf sammelt ein Nachlauf angewachsene Datensätze noch ein.

**Token** gilt ~8 h (`expiresIn: 28799`). Der Client erneuert ihn proaktiv 60 s
vor Ablauf und zusätzlich bei jedem 401/403.

**`identifier` heißt in v3 `sodixId`.** Die Playout-Dokumentation spricht noch von
`metadata{identifier}`; im v3-Schema existiert das Feld nicht.

## Bewusst nicht enthalten

**Mediendateien.** Der Crawler holt Metadaten, keine Binärdateien. Die Links dazu
stehen in jedem Datensatz (`media.url`, `media.downloadUrl`, `media.originalUrl`),
ein Download-Lauf über 215.868 Datensätze ist aber eine eigene Entscheidung —
Volumen im TB-Bereich und je Datensatz eigene Lizenzbedingungen
(`rights.license`, `rights.downloadRight`).

**Playout-Links.** `playout.window` liefert bewusst *temporär* gültige URLs; sie in
einen Abzug zu schreiben wäre sinnlos. Playout-Links gehören zur Laufzeit der
ausliefernden Mediathek geholt, mit `media.url` als Fallback für noch nicht
unterstützte Formate.

## Aufbau

| Datei | Aufgabe |
|---|---|
| `bin/sodix-crawl.mjs` | CLI, Argumente, Befehls-Dispatch, Introspection-Dump |
| `src/config.mjs` | `.env`-Loader und Defaults |
| `src/client.mjs` | GraphQL-Client: Login, Token-Erneuerung, Retries, Parallelitätslimit |
| `src/crawl.mjs` | generischer Seiten-Crawler + die einzelnen Datensatzarten |
| `src/fields.mjs` | Feldselektionen aus der Introspection, N+1-bereinigt |
| `src/writer.mjs` | NDJSON-Writer (optional gzip), atomares JSON |
| `src/state.mjs` | Checkpoint für Resume |

Retries greifen bei 408/425/429/5xx, Timeouts, Netzwerkfehlern und dem
`Exception while fetching data`-Wrapper der SODIX-API — exponentieller Backoff,
max. 30 s. Auf Seitenebene ist das Budget bewusst klein (2 Versuche), weil das
Bisect der eigentliche Rettungsweg ist: fünf Backoff-Runden vor jedem Bisect
kosten bei einer defekten Seite gut eine Minute, bei 174 Seiten eine
Dreiviertelstunde ohne jeden Nutzen. Die Sub-Requests des Bisects laufen mit
vollem Budget, transiente Fehler werden also weiterhin ausgesessen.

Schlägt eine Seite auch nach dem Bisect komplett fehl, wird sie im Checkpoint
vermerkt, der Lauf endet mit Exit-Code 2 und ein erneuter Aufruf holt genau
diese Seiten nach.

## Zugangsdaten

Nur in `.env` (per `.gitignore` ausgeschlossen, Rechte `600`) oder als
Umgebungsvariable. Der Account braucht die Rolle `ROLE_API`.

---

# Teil 2: Auslieferung über Nostr (AMB, kind:30142)

Die gecrawlten Metadaten lassen sich als AMB-Events über ein Nostr-Relay
ausliefern. Zwei Drittel der Kette kommen von [edufeed-org](https://github.com/edufeed-org)
und werden hier nur verdrahtet — neu ist allein die Abbildung SODIX → AMB.

```
data/metadata.ndjson                  SODIX v3, aus Teil 1
        │
        │  bin/sodix-to-amb.mjs       ← neu: SODIX → AMB-JSON-LD
        ▼
data/amb-cc.jsonl                     AMB, ein Datensatz pro Zeile
        │
        │  amb-nostr-converter        ← edufeed-org, unverändert
        ▼
data/events.jsonl                     signierte kind:30142-Events
        │
        │  bin/nostr-publish.mjs      ← neu: Relay-Auslieferung
        ▼
    dein Relay
```

## Vorbereitung

Der Konverter liegt auf einer eigenen Registry, die keine Transitiv-Abhängigkeiten
spiegelt (`npm install amb-nostr-converter --registry=…` scheitert an `chalk`),
und der GitHub-Tarball enthält nur `dist`, das nicht eingecheckt ist. Deshalb
lokal klonen und bauen:

```bash
npm run vendor:build
```

## Die drei Schritte

```bash
npm run amb:cc
```

```bash
vendor/amb-nostr-converter/dist/cli/index.js amb:nostr data/amb-cc.jsonl --nsec $NOSTR_NSEC -o data/events.jsonl
```

```bash
node bin/nostr-publish.mjs -i data/events.jsonl --relay wss://dein-relay --confirm
```

Ohne `--relay` **und** `--confirm` läuft der Publisher nur als Trockenlauf: er
prüft jedes Event auf `kind`, `d`-Tag, 64-stellige `id`, 128-stellige `sig` und
den Default-Pubkey `0x00…` (den erzeugt der Konverter, wenn `--nsec` fehlt) und
meldet, was gesendet *würde*. Zwei Stufen, weil ein Nostr-Event über Relays
repliziert und praktisch nicht zurückholbar ist.

## Teilmengen

`--filter` entscheidet, was überhaupt in die Auslieferung geht. Die Lizenzlage
im SODIX-Bestand macht das zur wichtigsten Entscheidung der ganzen Kette:

| Filter | Datensätze | Was drin ist |
|---|---|---|
| `cc` (Default) | 35.020 | `ACTIVATED` **und** CC-Lizenz-URI — echtes OER, rechtlich unstrittig |
| `free` | ~124.000 | `ACTIVATED` und `NOT_PAID`, also auch „Copyright, freier Zugang" |
| `activated` | ~135.600 | jeder aktive Datensatz, inklusive Kaufmedien |
| `all` | ~203.800 | alles im Dump, auch `UNAVAILABLE` und `DEACTIVATED` |

Nur **18,6 %** des Gesamtbestands tragen eine CC-Lizenz-URI. 53 % sind
„Copyright, freier Zugang", 25 % „Copyright, lizenzpflichtig", 23,5 % sind
Kaufmedien und 29,5 % haben `downloadRight: false`. Metadaten-Weitergabe ist bei
AMB/OERSI der Normalfall — verteilt werden Titel, Beschreibung und Link, nicht
die Mediendateien. Ob die SODIX-Nutzungsbedingungen das decken, ist aber eine
Rechtsfrage und keine technische; `cc` ist deshalb der Default.

## Die AMB-`id` ist eine Einbahnstraße

`--id-scheme` bestimmt die AMB-`id`, und die wird zum Nostr-`d`-Tag. Bei einem
addressierbaren Event (`kind:pubkey:d`) ist das die Identität über alle künftigen
Updates hinweg. Ein späterer Wechsel des Schemas erzeugt für jeden Datensatz ein
zweites, unverknüpftes Event statt eines Updates.

| Schema | Wert | Abwägung |
|---|---|---|
| `urn` (Default) | `urn:sodix:SODIX-0001234` | stabil; verletzt die AMB-Empfehlung einer dereferenzierbaren HTTP-URI |
| `media` | die Medien-URL | dereferenzierbar, aber instabil — ändert sich die URL, entsteht ein neues Event |

## Was wohin abgebildet wird

AMB-Kernfelder werden nur belegt, wenn die Semantik trägt. Alles SODIX-Eigene
geht in den `ext`-Namespace, den NIP-AMB genau dafür vorsieht — hier
`ext:de.sodix:*` in Reverse-DNS-Notation, wie der NIP es für neue Autoritäten
empfiehlt.

| SODIX | AMB | Anmerkung |
|---|---|---|
| `general.title` | `name` | Pflichtfeld; ohne Titel wird der Satz übersprungen |
| `general.description` | `description` + `content` | der NIP verlangt beides |
| `general.keywords` | `keywords` → `t`-Tags | dedupliziert |
| `general.languages` | `inLanguage` | Enum → BCP47 |
| `lifeCycle.author` / `.producer` | `creator[]` | Person bzw. Organization |
| `source.name` / `.website` | `publisher[]` | |
| `createdAt` / `publishedTime` / `updateTime` | `dateCreated` / `datePublished` / `dateModified` | |
| `rights.license.url` | `license.id` | nur echte URIs, normalisiert |
| `paymentType` | `isAccessibleForFree` | `NOT_PAID` → `true` |
| `educational.learningResourceType` | `learningResourceType[]` | → HCRT |
| `educational.educationalLevel` | `educationalLevel[]` | → ISCED-1997 |
| `educational.subject` | `about[]` | → KIM-Schulfächer |
| `media.duration` | `duration` | `HH:MM:SS` → ISO-8601 |
| `media.url` / `.dataType` / `.size` | `encoding[]` | `dataType` ist schon IANA |
| `media.thumbnail` | `image` | |
| `hubbs.*`, FSK/USK, Kompetenzen, Schulform, Klassenstufe | `ext:de.sodix:*` | |

Feldabdeckung im CC-Durchlauf (35.020 Sätze, 0 übersprungen): `id`, `type`,
`name`, `description`, `license`, `learningResourceType`, `educationalLevel`,
`encoding`, `image`, `dateCreated`, `dateModified`, `isAccessibleForFree` je
100 %; `keywords` 98,5 %; `inLanguage` 89,7 %; `creator` 71,1 %; `about` 61,5 %.

## Fallstricke der Vokabular-Abbildung

**SODIX führt Vokabular-Namen in gemischten Sprachen.** `lrts`,
`educationLevels`, `schoolTypes`, `costs` und die meisten `hubbs`-Vokabulare sind
englisch, `subjects` und `competences` deutsch — und `lands` mischt beides in
*einer* Liste („Baden-Württemberg" neben „Bavaria"). Ein SODIX-Name als
`prefLabel.de` wäre in den meisten Fällen eine falsche Sprachangabe. Deshalb:
KIM-abgebildete Konzepte tragen das autoritative deutsche Label aus dem
KIM-SKOS-Schema selbst, `ext`-Konzepte tragen den SODIX-Namen mit der Sprache,
die das jeweilige Vokabular wirklich führt, und wo die Sprache nicht eindeutig
ist (`lands`, `lernfeld`) wird **kein** `prefLabel` behauptet.

**Kompetenzen gehen nicht nach `teaches`.** AMB verlangt dort eine URI als `id`,
SODIX liefert interne Zahlenschlüssel (`40004020201`). Sie landen in
`ext:de.sodix:kompetenz`.

**Sechs „Sprachen" sind keine.** `WITHOUT_LANGUAGE`, `AUDIO_DESCRIPTION`,
`PLAIN_LANGUAGE`, `SIMPLE_LANGUAGE`, `ORIGINAL_VERSION_WITH_SUBTITLES` und
`SUBTITLES_FOR_THE_HEARING_IMPAIRED` sind Fassungsmerkmale und gehören nicht nach
`inLanguage` — sie gehen nach `ext:de.sodix:sprachfassung`.

**`/deed.de` ist nicht `/de/`.** Bei CC-URLs ist `…/by-sa/4.0/deed.de` nur die
deutschsprachige *Ansicht* derselben Lizenz und wird auf die kanonische URI
normalisiert. `…/by-nc-nd/3.0/de/` ist dagegen die portierte deutsche
Lizenzfassung — eine eigene Lizenz, die erhalten bleibt.

**Jede verlustbehaftete Abbildung behält das Original.** 48 SODIX-Ressourcentypen
gehen auf 26 HCRT-Konzepte, 2.043 Fächer auf 61 KIM-Fächer. Der SODIX-Wert steht
darum immer zusätzlich in `ext:de.sodix:ressourcentyp` bzw. `…:fach`.
Vereinfachen ja, verschwinden lassen nein. 14 SODIX-Oberfächer ohne tragfähiges
KIM-Pendant („Freizeit", „Heimatraum, Region", „Sachgebietsübergreifende
Medien" …) sind absichtlich gar nicht abgebildet.

## Verifikation

Der Rundlauf AMB → kind:30142 → AMB ist verlustfrei: 70 Felder rein, 70 zurück,
kein Feld verloren, keines verändert.

```bash
vendor/amb-nostr-converter/dist/cli/index.js nostr:amb data/events.jsonl -o /tmp/rueck.jsonl
```

Größenordnung für den CC-Durchlauf: 35.020 Sätze → 115,6 MB AMB → 179,6 MB
Events, Konvertierung rund eine Minute.
