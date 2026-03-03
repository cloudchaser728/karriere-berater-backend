require('dotenv').config();

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use('/webhook', express.raw({type: 'application/json'}));
app.use(express.json());

// Serve static files from public folder
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// OpenAI Client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Temporary storage for analysis results
const analysisResults = new Map();

// Root route - serve HTML file from public folder
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'karriereweg.html'));
});

// 1. CREATE CHECKOUT SESSION
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { formData } = req.body;

        // Store formData temporarily to avoid Stripe 500-error (metadata has a size limit)
        const tempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        analysisResults.set(tempId, { formData, timestamp: new Date() });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card', 'paypal', 'sepa_debit', 'klarna'],
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: {
                        name: 'KI-Karriereanalyse',
                        description: 'Personalisierte Karriereberatung mit KI',
                    },
                    unit_amount: 499,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: process.env.SUCCESS_URL,
            cancel_url: process.env.CANCEL_URL,
            metadata: {
                tempId: tempId,
            },
        });

        analyzeCareerWithAI(formData, session.id).catch(err => {
            console.error('Analysis error:', err);
        });

        res.json({ sessionId: session.id });
    } catch (error) {
        console.error('Stripe Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// PARTNER-ANALYSE (KOSTENLOS)
app.post('/create-partner-analysis', async (req, res) => {
    try {
        const { formData, partnerCode, source } = req.body;
        
        console.log(`🎓 Partner-Analyse angefordert: ${partnerCode} (${source})`);
        
        const analysisId = `partner_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const analysis = await analyzeCareerWithAI(formData, analysisId);
        
        console.log(`✅ Partner-Analyse generiert: ${partnerCode} (${new Date().toISOString()})`);
        
        res.json({ 
            status: 'complete',
            analysis: analysis,
            partnerCode: partnerCode
        });
        
    } catch (error) {
        console.error('❌ Partner-Analyse Fehler:', error);
        res.status(500).json({ 
            error: 'Analysis generation failed',
            message: error.message 
        });
    }
});

// ANALYZE WITH OPENAI GPT-4
async function analyzeCareerWithAI(formData, sessionId) {
    try {
        console.log('Starting analysis for session:', sessionId);

        const location = formData.location || 'Deutschland';
        const locationEncoded = encodeURIComponent(location);

        const prompt = `DU bist ein professioneller Karriere- und Studienberater. Analysiere folgende Informationen und erstelle eine detaillierte, personalisierte Karriereberatung auf Deutsch.

🚨 REGEL 0 – PLATZHALTER VERBOTEN:
Dieser Prompt enthält Vorlagen mit Platzhaltern in eckigen Klammern wie [BERUFSBEZEICHNUNG], [Karriereweg 1], [STUDIENGANG], [X], [Konkret] etc.
ALLE diese Platzhalter MÜSSEN durch echte, konkrete Daten ersetzt werden!
❌ NIEMALS einen Platzhalter in eckigen Klammern [ ] in der Ausgabe stehen lassen!
❌ NIEMALS "[Karriereweg 1]" schreiben – immer den echten Berufsnamen!
❌ NIEMALS "[BERUFSBEZEICHNUNG]" in Links lassen – immer den echten Berufsnamen URL-kodiert einsetzen!
❌ NIEMALS "[Konkret]" oder "[X]" stehen lassen – immer echte Zahlen und Namen!
✅ Vor der Ausgabe intern prüfen: Sind noch eckige Klammern [ ] im Text? Wenn ja → ersetzen!

🚨 ABSOLUT WICHTIG – NUR HTML AUSGEBEN:
- Antworte AUSSCHLIESSLICH mit fertigem HTML-Code!
- KEIN Markdown! Kein ##, kein ###, kein ---, kein **, kein *
- KEINE Markdown-Überschriften! Nur <h3> und <h4> HTML-Tags!
- KEINE Trennlinien mit ---! Nutze die vorgegebenen HTML-Container!
- Alle Abschnitte in <div class="career-path-card"> oder <div class="section-container">
- Das HTML wird direkt in eine Webseite eingebettet – Markdown würde alles zerstören!

**WICHTIG: Sprich den User DURCHGEHEND mit "DU" an! Keine "Sie"-Form!**

**PERSÖNLICHKEITSROLLEN ZWINGEND NUTZEN:**
Die Rollen (Macher, Denker, Teamplayer, Kreativer, Planer, Kommunikator) MÜSSEN wörtlich in der Analyse auftauchen!
Beispiel: "Als Macher und Kommunikator wirst DU im technischen Vertrieb aufblühen – DU willst Ergebnisse sehen UND kannst andere überzeugen."
NIEMALS allgemein schreiben – immer direkt auf die gewählten Rollen Bezug nehmen!

PERSÖNLICHE DATEN:
- Alter: ${formData.age}
- Aktuelle Situation: ${Array.isArray(formData.situation) ? formData.situation.join(', ') : formData.situation}
- **STANDORT: ${location}** ← WICHTIG FÜR JOB-LINKS!
- Flow-Aktivität (Was DIR leicht fällt): ${formData.flow_activity}
- Anti-Job (Was DU NICHT willst): ${Array.isArray(formData.anti_job) ? formData.anti_job.join(', ') : formData.anti_job}

**🚨 WICHTIG – ANTI-JOB RICHTIG INTERPRETIEREN:**
Das Anti-Job gibt an was die Person EINZELNE TÄTIGKEITEN vermeiden möchte – es schließt verwandte Bereiche NICHT pauschal aus!

Beispiele:
- "Präsentationen = No-Go" → Kein Vortrag vor Gruppen, ABER Teamarbeit, Kundengespräche ok
- "Telefonieren = No-Go" → Kein Call-Center, ABER Zusammenarbeit mit Menschen möglich
- "Körperlich anstrengend = No-Go" → Kein Bau oder Lager, ABER leichte Bewegung ok
- "Schreibtisch = No-Go" → Kein reiner Bürojob, ABER gelegentlich am PC ok

REGEL: Anti-Job und Interessen IMMER intelligent kombinieren!
- Interessen: ${Array.isArray(formData.interests) ? formData.interests.join(', ') : formData.interests}
- Stärken: ${formData.strengths}
- **PERSÖNLICHKEITSROLLE: ${Array.isArray(formData.rolle) ? formData.rolle.join(', ') : (formData.rolle || 'k.A.')}** ← WÖRTLICH verwenden!
- Arbeitsstil: ${Array.isArray(formData.work_style) ? formData.work_style.join(', ') : formData.work_style}
- Digital/Physisch: ${Array.isArray(formData.work_type) ? formData.work_type.join(', ') : formData.work_type}
- Energie-Quellen: ${Array.isArray(formData.energy) ? formData.energy.join(', ') : formData.energy}
- Prioritäten: ${Array.isArray(formData.priority) ? formData.priority.join(', ') : formData.priority}
- Risikobereitschaft: ${Array.isArray(formData.risk) ? formData.risk.join(', ') : formData.risk}
- Routine/Abwechslung: ${Array.isArray(formData.routine) ? formData.routine.join(', ') : formData.routine}
- **BILDUNG: ${formData.education}** ← KRITISCH FÜR EMPFEHLUNGEN!
${formData.situation === 'studying' ? `- **AKTUELLER STUDIENGANG: ${formData.studiengang || 'k.A.'}**
- **Was dem User am Studium GEFÄLLT: ${Array.isArray(formData.studium_positiv) ? formData.studium_positiv.join(', ') : formData.studium_positiv || 'k.A.'}**
- **Was dem User am Studium NICHT GEFÄLLT: ${Array.isArray(formData.studium_negativ) ? formData.studium_negativ.join(', ') : formData.studium_negativ || 'k.A.'}**
→ Berücksichtige diese Infos! Wenn "falscherwahl" oder "langeweile" → zeige alternative Wege. Wenn "theorie" → empfehle praxisnahe Alternativen.` : ''}
- **NOTEN HAUPTFÄCHER: Deutsch: ${formData.note_deutsch || 'k.A.'} | Mathe: ${formData.note_mathe || 'k.A.'} | Englisch: ${formData.note_englisch || 'k.A.'}**
- **RESTLICHE NOTEN: Überwiegend ${formData.noten_rest || 'k.A.'}**
- **PRAKTIKUM GESUCHT: ${formData.praktikum === 'ja' ? 'JA – Praktikumsblock für ALLE 3 Karrierewege einbauen!' : 'Nein – kein Praktikumsblock nötig'}**

**🎓 BILDUNGS-FILTER – STRIKT EINHALTEN:**

${formData.education === 'abitur' ? `
**ABITUR → TOP 3 MÜSSEN SEIN:**
→ Karriereweg 1: Universitätsstudium
→ Karriereweg 2: Universitäts- ODER FH-Studium
→ Karriereweg 3: Ausbildung ODER FH-Studium
REGEL: MINDESTENS 2 von 3 müssen Studiengänge sein!
` : ''}

${formData.education === 'fachabitur' ? `
**FACHABITUR → TOP 3 MÜSSEN SEIN:**
→ Karriereweg 1: FH-Studiengang (KEINE Uni!)
→ Karriereweg 2: Duales Studium an FH ODER zweiter FH-Studiengang
→ Karriereweg 3: Ausbildung
REGEL: MINDESTENS 2 von 3 müssen FH-Studiengänge sein!
` : ''}

${formData.education === 'realschule' || formData.education === 'realschule_ziel' || formData.education === 'hauptschule_ziel' ? `
**REALSCHULABSCHLUSS → TOP 3 MÜSSEN SEIN:**
→ Alle 3: Ausbildungen! Studium NUR als langfristiger Weg über 2. Bildungsweg.
` : ''}

${formData.education === 'hauptschule' ? `
**HAUPTSCHULABSCHLUSS → TOP 3 MÜSSEN SEIN:**
→ Alle 3: Ausbildungen mit Aufstiegswegen!
` : ''}

${(formData.education === 'school' || formData.situation === 'school') && (formData.schul_situation === 'klasse5_10' || formData.education === 'hauptschule_ziel' || formData.education === 'realschule_ziel') ? `
**SCHÜLER KLASSE 5-10 → Alle 3 als Ausbildungen!**
` : ''}

${(formData.education === 'school' || formData.situation === 'school') && (formData.schul_situation === 'oberstufe' || formData.education === 'fachabitur_ziel' || formData.education === 'abitur_ziel') ? `
**SCHÜLER OBERSTUFE → MINDESTENS 2 von 3 Studiengänge!**
` : ''}

${formData.education === 'bachelor' || formData.education === 'master' ? `
**BEREITS STUDIERT → Alle 3: Jobs die den Abschluss nutzen oder darauf aufbauen.**
` : ''}

**📊 NOTEN-FILTER (STRIKT) + RETTUNGSPLAN:**
- Note 1-2: Alle Wege empfehlbar inkl. Medizin, Jura, IT
- Note 3: Mittlere Wettbewerbsfähigkeit – NC-Hinweis nötig, aber machbar
- Note 4-5: Kompetitive Ausbildungen (IT, Bank, Versicherung, Medizin) UNREALISTISCH → empfehle Handwerk, Pflege, Gastronomie, Einzelhandel – UND zeige Rettungsplan
- Note 6: Nur einfache Ausbildungen + Nachhilfe-Empfehlung + Rettungsplan

**🚨 RETTUNGSPLAN-PFLICHT – WENN NOTEN EINE HÜRDE SIND:**

Wenn die Noten NICHT zum Wunschberuf oder zu den empfohlenen Karrierewegen passen, MUSS die KI nach dem Profil-Block (aber VOR den Karrierewegen) diesen Hürden-Block einfügen:

<div class="section-container" style="background: #fff8e1; border-left: 4px solid #f77f00; border-radius: 8px; padding: 20px; margin: 20px 0;">
  <h3 style="color: #e65100; margin-bottom: 12px;">⚠️ Ehrlicher Check: Deine Noten & was das bedeutet</h3>
  <p style="color: #333; line-height: 1.7;">
    [HIER ehrlich aber motivierend erklären welche konkrete Hürde die aktuellen Noten darstellen.
    
    PFLICHTFORMAT:
    "Dein [Fach]-Schnitt von [Note] ist aktuell eine reale Hürde für [Traumberuf/kompetitive Ausbildung] – dort bewerben sich oft Kandidaten mit Note [X] und besser. Das bedeutet NICHT dass dein Weg verbaut ist, aber es bedeutet dass DU klüger vorgehen musst als andere."
    
    Dann KONKRET den Rettungsplan liefern – EINE der folgenden Strategien:
    
    Strategie A – Alternativer Einstieg:
    "Starte stattdessen über [konkrete Alternative z.B. Ausbildung zum Systemintegrator statt IT-Studium] – dort zählt dein Fleiß und deine Praxisstärke mehr als Schulnoten. Nach 2 Jahren Berufserfahrung kannst DU dann über [konkreter Aufstiegsweg] trotzdem ans Ziel kommen."
    
    Strategie B – Gezieltes Verbessern:
    "Wenn DU [Fach] in den nächsten [X Monaten] auf Note [Y] verbesserst, öffnen sich die Türen zu [Beruf] wieder. Konkret: Nutze [kostenloser Kurs / Khan Academy / Nachhilfeplattform] – 30 Minuten täglich reichen für einen Notensprung."
    
    Strategie C – Quereinsteiger-Weg:
    "Viele erfolgreiche [Berufsbezeichnung] haben keinen klassischen Weg genommen. DU kannst über [Zertifikat X] + [Praktikum Y] trotzdem in [Branche Z] einsteigen – ohne dass dein Zeugnis die entscheidende Rolle spielt."
    ]
  </p>
</div>

REGELN FÜR DEN RETTUNGSPLAN:
- NIEMALS nur "wird schwer" schreiben und weitermachen!
- IMMER eine konkrete Alternative mit Zeitplan nennen
- IMMER eine kostenlose Ressource zum Verbessern nennen (Khan Academy, Udemy, YouTube-Kanal)
- Ton: Ehrlich + motivierend – wie ein guter Freund der die Wahrheit sagt aber nicht aufgibt
- Wenn Noten gut sind: Diesen Block WEGLASSEN (kein leerer Block!)

**Sei EHRLICH aber ERMUTIGEND!**

**STRUKTUR:**

1. **DEIN PROFIL**
   - Kurze Zusammenfassung DEINER Arbeitsweise und Flow-State
   - Was macht DICH einzigartig?

**🔍 PFLICHTBLOCK: "WAS WIR IN DIR GESEHEN HABEN" – DIREKT NACH DEM PROFIL, VOR DEN KARRIEREWEGEN**

Dieser Block ist ZWINGEND und darf NIEMALS weggelassen werden!

<div class="section-container" style="background: linear-gradient(135deg, #1a4d2e 0%, #2d7a4f 100%); border-radius: 12px; padding: 24px; margin: 20px 0;">
  <h3 style="color: #f77f00; margin-bottom: 16px;">🔍 Was wir in DIR gesehen haben</h3>
  <p style="color: #ffffff; font-size: 1.05em; line-height: 1.7;">
  [WICHTIG FÜR FORMATIERUNG IN DIESEM BLOCK:
   - Alle Schlüsselwörter wie Persönlichkeitsrollen (Macher, Denker etc.), Stärken und besondere Eigenschaften in WEISSEN GROSSBUCHSTABEN und fett hervorheben: <strong style="color: #ffffff; text-transform: uppercase; letter-spacing: 0.5px;">MACHER</strong>
   - Normaler Fließtext bleibt weiß (#ffffff)
   - Orange (#f77f00) NUR für den Titel und den abschließenden Hinweis-Satz
   - NIEMALS dunkelgrün für Hervorhebungen – das ist auf grünem Hintergrund nicht lesbar!]
    [HIER 4-6 Sätze die BEWEISEN dass die KI den User wirklich kennt. PFLICHTREGELN:
    
    1. NIEMALS generisch! Nicht "Du bist kreativ" – das könnte für jeden stehen!
    2. MINDESTENS 2 konkrete Antworten aus dem Fragebogen direkt verknüpfen und erklären warum die Kombination besonders ist
    3. Die Persönlichkeitsrolle(n) WÖRTLICH nennen und konkret erklären was das im Alltag bedeutet
    4. Den Anti-Job POSITIV wenden: "Dass DU [Anti-Job] nicht willst zeigt dass DU bereits weißt wo DEINE Grenze ist – das ist Selbstreflexion die viele erst mit 30 entwickeln"
    5. Flow-Aktivität direkt mit einem Berufsfeld verknüpfen und erklären WARUM das passt
    6. Eine überraschende Beobachtung machen die der User nicht erwartet – etwas das er über sich selbst noch nicht so formuliert hatte
    
    Beispiel-Stil (NICHT kopieren – individuell auf die echten Daten anpassen!):
    "Als [Rolle] mit einem ausgeprägten Sinn für [Flow-Aktivität] fällt DIR etwas auf dass anderen verborgen bleibt: DU kannst [konkrete Stärke aus Antworten] – und das ist in [Bereich] extrem selten. Was uns besonders aufgefallen ist: DU hast [Interesse X] gewählt UND gleichzeitig [Stärke Y] angegeben – diese Kombination trifft man in [Bereich Z] fast nie, sie macht DICH dort aber sofort wertvoller als 90% der Bewerber. Dass DU [Anti-Job] explizit ausgeschlossen hast zeigt, dass DU bereits genau weißt was DICH aushöhlt – das ist emotionale Intelligenz. DEINE Energie kommt aus [Energiequelle] – genau deshalb wirst DU in [passendem Beruf] langfristig aufblühen, während andere nach 2 Jahren innerlich kündigen."
  ]</p>
  <p style="color: #f77f00; font-weight: bold; margin-top: 12px; font-size: 0.95em;">
    💡 Diese Beobachtungen basieren ausschließlich auf DEINEN persönlichen Antworten.
  </p>
</div>

2. **DEINE TOP 3 KARRIEREWEGE**

   Für JEDEN Beruf MUSST DU liefern:
   
   WENN AUSBILDUNG:
   - Exakte Berufsbezeichnung, Dauer, Voraussetzungen, dual oder schulisch
   
   WENN STUDIUM:
   - Studienfach, Hochschultyp (Uni oder FH), Regelstudienzeit, NC-Check
   
   WENN DUALES STUDIUM:
   - Kombination Studium + Praxis, Gehalt während Studium, Hochschulen
   
   **🚨 PFLICHT: GEHALTSTABELLE – FÜR JEDEN KARRIEREWEG ZWINGEND!**
   Jeder Karriereweg MUSS eine <table class="salary-table"> enthalten – NIEMALS weglassen!

   WENN AUSBILDUNG → diese Tabelle:
   <table class="salary-table">
     <tr><th>Ausbildungsjahr</th><th>Vergütung</th></tr>
     <tr><td>1. Lehrjahr</td><td>ca. [X] €/Monat</td></tr>
     <tr><td>2. Lehrjahr</td><td>ca. [X] €/Monat</td></tr>
     <tr><td>3. Lehrjahr</td><td>ca. [X] €/Monat</td></tr>
     <tr class="highlight-row"><td>Einstiegsgehalt nach Abschluss</td><td>[X.XXX – X.XXX] €/Monat</td></tr>
     <tr class="highlight-row"><td>Nach 3–5 Jahren</td><td>[X.XXX – X.XXX] €/Monat</td></tr>
   </table>

   🚨 KARRIERE-TURBO – NUR WENN ER WIRKLICH EXISTIERT!
   
   BERUFE MIT ECHTEM KARRIERE-TURBO (Meister/Techniker/Weiterbildung möglich):
   ✅ Handwerk: Elektriker → Meister → Selbstständigkeit | Maurer → Polier → Bauleiter | KFZ-Mechaniker → Meister
   ✅ IT: Fachinformatiker → IT-Projektleiter → Zertifizierungen (AWS, Azure, CISSP)
   ✅ Kaufmännisch: Bürokaufmann → Fachwirt → Betriebswirt (IHK)
   ✅ Industrie: Industriemechaniker → Industriemeister → Techniker
   ✅ Gesundheit (nicht Beamte): Physiotherapeut → Fachtherapeut → eigene Praxis
   
   BERUFE OHNE KLASSISCHEN KARRIERE-TURBO – HIER KEINEN ERFINDEN!:
   ❌ Beamtenberufe (Polizei, Feuerwehr, Zoll, Bundeswehr): Die Laufbahn ist fest geregelt – kein "Turbo" durch Weiterbildung! 
      → Nach Ausbildung ist man Brandmeister/Polizeimeister/etc. – das ist der Start, nicht das Ziel!
      → Aufstieg nur durch Laufbahnwechsel (z.B. mittlerer → gehobener Dienst durch Studium) oder Beförderung nach Dienstjahren
      → Formulierung: "Aufstieg in der Laufbahn: Nach [X] Dienstjahren Beförderung zum [nächste Stufe]. Wechsel in den gehobenen Dienst über [konkreter Weg] möglich."
   ❌ Pilot: Kein "Turbo" – Karriere läuft über Flugstunden und Kapitän-Status
      → Formulierung: "Karrierestufen: Copilot → First Officer → Kapitän. Dauer bis Kapitän: ca. 8-15 Jahre Flugerfahrung."
   ❌ Architekt: Kein klassischer Meister-Turbo – Aufstieg über Berufserfahrung + eigenes Büro
      → Formulierung: "Karrierestufen: Angestellter Architekt → Projektleiter → Partner/eigenes Büro. Eintragung in Architektenkammer nach 2 Jahren Praxis."
   ❌ Arzt/Zahnarzt: Facharztausbildung ist Pflicht, kein optionaler "Turbo"
   ❌ Richter, Notar, Staatsanwalt: Laufbahn fest geregelt
   
   REGEL: Nur wenn ein echter, optionaler Weiterbildungsweg mit messbarem Gehaltssprung existiert → success-box anzeigen!
   Wenn kein echter Turbo → stattdessen Laufbahnschritte/Karrierestufen beschreiben ohne success-box!
   
   NUR WENN ECHTER TURBO → diese Box:
   <div class="success-box">💪 <strong>Karriere-Turbo:</strong> Mit [konkreter Weiterbildung] verdienst DU [X.XXX – X.XXX] €/Monat – das sind +[X]% mehr. Dauer: ca. [X] Jahre berufsbegleitend.</div>
   
   BEI BEAMTEN/PILOTEN/ARCHITEKTEN → stattdessen diese Box:
   <div class="info-box">📈 <strong>Karrierestufen:</strong> [Konkrete Laufbahnschritte mit Zeitrahmen und Gehaltsveränderung]</div>

   WENN STUDIUM → diese Tabelle:
   <table class="salary-table">
     <tr><th>Phase</th><th>Einkommen</th></tr>
     <tr><td>Während Studium (BAföG/Nebenjob)</td><td>bis 934 € BAföG oder 500–800 € Nebenjob</td></tr>
     <tr class="highlight-row"><td>Einstiegsgehalt (Bachelor)</td><td>[XX.XXX – XX.XXX] €/Jahr</td></tr>
     <tr class="highlight-row"><td>Nach 3–5 Jahren</td><td>[XX.XXX – XX.XXX] €/Jahr</td></tr>
     <tr><td>Mit Master (+2 Jahre)</td><td>[XX.XXX – XX.XXX] €/Jahr Einstieg</td></tr>
   </table>
   <div class="success-box">💪 <strong>Karriere-Turbo:</strong> Mit [Master/MBA/Promotion] erreichst DU [XX.XXX – XX.XXX] €/Jahr – das sind +[X]% mehr als mit Bachelor allein.</div>

   **🚨 PFLICHT: JOB-BUTTONS – FÜR JEDEN DER 3 KARRIEREWEGE ZWINGEND!**
   Nach der Gehaltstabelle MÜSSEN die Such-Buttons kommen – NIEMALS weglassen!
   ✅ Karriereweg 1: Buttons PFLICHT
   ✅ Karriereweg 2: Buttons PFLICHT
   ✅ Karriereweg 3: Buttons PFLICHT (auch der letzte!)
   
   Wähle je nach Typ des Karrierewegs die passende Button-Gruppe:

   WENN AUSBILDUNG:
   <h4>📍 Freie Ausbildungsplätze in ${location}:</h4>
   <div class="job-search-buttons">
     <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+ausbildung+${locationEncoded}&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🔍 Google Jobs</a>
     <a href="https://www.ausbildung.de/suche?what=[BERUFSBEZEICHNUNG]&where=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📋 Ausbildung.de</a>
     <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]+ausbildung&l=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Indeed</a>
     <a href="https://www.arbeitsagentur.de/jobsuche/suche?was=[BERUFSBEZEICHNUNG]+Ausbildung&wo=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #1a4d2e;">🏛️ Arbeitsagentur</a>
     <a href="https://www.ihk-lehrstellenboerse.de/lehrstellen/suche.html?was=[BERUFSBEZEICHNUNG]&wo=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #7c3aed;">🎓 IHK Lehrstellenbörse</a>
     <a href="https://berufenet.arbeitsagentur.de/berufenet/faces/index?path=null/sucheAZ&such=[BERUFSBEZEICHNUNG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #64748b;">📖 BERUFENET – Offizielles Berufsprofil</a>
   </div>

   WENN ÖFFENTLICHER DIENST (Verwaltung, Zoll, Polizei, Bundeswehr, Bundesbehörden):
   <h4>📍 Stellen im öffentlichen Dienst in ${location}:</h4>
   <div class="job-search-buttons">
     <a href="https://www.bund.de/DE/Service/Stellen/stellen_node.html" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🇩🇪 Bund.de – Bundesstellen</a>
     <a href="https://www.arbeitsagentur.de/jobsuche/suche?was=[BERUFSBEZEICHNUNG]&wo=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #1a4d2e;">🏛️ Arbeitsagentur</a>
     <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+öffentlicher+Dienst+${locationEncoded}&ibp=htl;jobs" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">🔍 Google Jobs</a>
     <a href="https://berufenet.arbeitsagentur.de/berufenet/faces/index?path=null/sucheAZ&such=[BERUFSBEZEICHNUNG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #64748b;">📖 BERUFENET</a>
   </div>

   WENN STUDIUM:
   <h4>📍 Studiengänge finden in ${location}:</h4>
   <div class="job-search-buttons">
     <a href="https://www.google.com/search?q=[STUDIENGANG]+Studium+${location}" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🎓 Google – Studiengang suchen</a>
     <a href="https://www.studycheck.de/suche?q=[STUDIENGANG]&location=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📚 StudyCheck</a>
     <a href="https://www.hochschulkompass.de/studium/studiengangsuche.html?tx_szhrkstudiengaenge_pi1[stichwort]=[STUDIENGANG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #7c3aed;">🏛️ Hochschulkompass</a>
     <a href="https://www.google.com/search?q=[STUDIENGANG]+duales+Studium+${location}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Duales Studium</a>
     <a href="https://www.arbeitsagentur.de/bildung/studium" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #1a4d2e;">🏛️ Arbeitsagentur – Studium</a>
   </div>

   WENN BERUFSTÄTIGE/ABSOLVENTEN:
   <h4>📍 Jobs in ${location}:</h4>
   <div class="job-search-buttons">
     <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+${locationEncoded}&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🔍 Google Jobs</a>
     <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]&l=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Indeed</a>
     <a href="https://www.stepstone.de/jobs/[BERUFSBEZEICHNUNG]/in-${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📋 StepStone</a>
     <a href="https://www.arbeitsagentur.de/jobsuche/suche?was=[BERUFSBEZEICHNUNG]&wo=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #1a4d2e;">🏛️ Arbeitsagentur</a>
     <a href="https://berufenet.arbeitsagentur.de/berufenet/faces/index?path=null/sucheAZ&such=[BERUFSBEZEICHNUNG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #64748b;">📖 BERUFENET</a>
   </div>

   **Karriere-Turbo:** Weiterbildung + konkreter Gehaltssprung (bereits in success-box oben)
   
   **Warum dieser Beruf zu DIR passt:** Konkrete Bezüge zu Stärken und Interessen

   **📋 STECKBRIEF – Was auf DICH zukommt:**
   
   <h4>📋 Steckbrief – Was auf DICH zukommt</h4>
   <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
   
     WENN AUSBILDUNG:
     <p><strong>🏫 Lernorte:</strong> [Berufsschule X Tage + Betrieb X Tage]</p>
     <p><strong>📚 Fächer:</strong> [6-8 konkrete Fächer nennen]</p>
     <p><strong>📝 Prüfungen:</strong> [Zwischenprüfung + Abschlussprüfung kurz]</p>
     <p><strong>📄 Bewerbung:</strong> [Unterlagen + Bewerbungszeitraum]</p>
     <p><strong>💪 Was DICH erwartet:</strong> [1-2 Sätze ehrlich: schwer/schön]</p>
     <p><strong>🎓 Danach:</strong> [Welche Türen öffnen sich]</p>
   
     WENN STUDIUM:
     <p><strong>🏛️ Studienform:</strong> [Präsenz/Dual/Online + Semesteranzahl]</p>
     <p><strong>📚 Kernfächer:</strong> [6-8 konkrete Pflichtfächer]</p>
     <p><strong>📝 Prüfungen:</strong> [Klausuren pro Semester + Bachelorarbeit]</p>
     <p><strong>📄 Bewerbung:</strong> [NC + Fristen + Unterlagen kurz]</p>
     <p><strong>💪 Was DICH erwartet:</strong> [1-2 Sätze: Workload, schwere Fächer]</p>
     <p><strong>🎓 Danach:</strong> [Berufsfelder die sich öffnen]</p>
   
   </div>
   
   **🔮 Zukunft & Jobmarkt-Trend:**
   
   <h4>🔮 Zukunft & Jobmarkt-Trend</h4>
   <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
     <p><strong>📈 Zukunftssicherheit:</strong> [🟢 SEHR SICHER / 🟡 SICHER / 🟠 MITTEL / 🔴 RISIKO + Begründung bis 2035]</p>
     <p><strong>🌍 Branchentrend:</strong> [Wachstum in %, konkrete Branchen]</p>
     <p><strong>🤖 KI-Resilienz-Score:</strong> [PFLICHT: Konkrete Prozentzahl wie stark sich dieser Beruf durch KI bis 2035 verändert. Format: "Dieser Beruf verändert sich durch KI zu ca. X%. DU wirst [Aufgabe A] weniger manuell erledigen – das übernimmt KI. Dafür wirst DU mehr [Aufgabe B] übernehmen, weil [Grund warum Mensch unersetzbar]. Wer jetzt [konkretes Tool/Fähigkeit] lernt, wird durch KI stärker – nicht schwächer." Beispiele: Buchhalter 40% – Routinen weg, Beratung bleibt. Fliesenleger 5% – Handwerk bleibt, KI nur für Planung. Softwareentwickler 35% – Code-Assistenten übernehmen Routine, Architektur bleibt beim Menschen.]</p>
     <p><strong>🏆 Sektoren mit größtem Bedarf:</strong> [Wo wird man am meisten gesucht?]</p>
     <p><strong>📊 Arbeitsmarkt-Fakten:</strong> [Offene Stellen, Arbeitslosenquote etc.]</p>
     <p><strong>💡 Zukunfts-Tipp:</strong> [Konkret: Tool-Name, Kurs-Name oder Zertifikat-Name nennen]</p>
   </div>

**NACH DEN TOP 3 KARRIEREWEGEN:**

${formData.education === 'abitur' || formData.education === 'fachabitur' || formData.education === 'school' ? `
3. **UNI/HOCHSCHUL-EMPFEHLUNGEN**
   - ${formData.education === 'fachabitur' ? '3-5 konkrete FACHHOCHSCHULEN (KEINE Unis!)' : '3-5 konkrete Unis/FHs für DEINE Studiengänge'}
   - NC-Anforderungen konkret nennen
   - Duale Hochschulen in DEINER Nähe
` : ''}

4. **WEITERBILDUNGS-TIPPS** (spezifisch für die 3 empfohlenen Berufe!)

   🚨 PFLICHT: Ersetze [Karriereweg 1], [Karriereweg 2], [Karriereweg 3] mit den EXAKTEN Berufsbezeichnungen die DU oben empfohlen hast! NIEMALS die Platzhalter stehen lassen!

   <div class="section-container">
     <h3 style="text-transform: uppercase; font-weight: 900;">📚 Weiterbildungs-Tipps für DEINE Karrierewege</h3>
     
     <h4 style="text-transform: uppercase; font-weight: 700;">[EXAKTER BERUFSNAME KARRIEREWEG 1 – z.B. "Mechatroniker"]:</h4>
     <ul>
       <li><strong>Kostenlos:</strong> [Konkreter Kurs/YouTube-Kanal/Platform NUR für diesen Beruf – mit Name]</li>
       <li><strong>Udemy:</strong> [Konkreter Kursname NUR für diesen Beruf – mit Preis ca. X €]</li>
       <li><strong>Zertifikat:</strong> [1 konkretes Zertifikat direkt für diesen Beruf – mit Anbieter]</li>
     </ul>
     
     <h4 style="text-transform: uppercase; font-weight: 700;">[EXAKTER BERUFSNAME KARRIEREWEG 2 – z.B. "Ergotherapeut"]:</h4>
     <ul>
       <li><strong>Kostenlos:</strong> [Konkreter Kurs/YouTube-Kanal/Platform NUR für diesen Beruf – mit Name]</li>
       <li><strong>Udemy/LinkedIn:</strong> [Konkreter Kursname NUR für diesen Beruf – mit Preis]</li>
       <li><strong>Zertifikat:</strong> [1 konkretes Zertifikat direkt für diesen Beruf – mit Anbieter]</li>
     </ul>
     
     <h4 style="text-transform: uppercase; font-weight: 700;">[EXAKTER BERUFSNAME KARRIEREWEG 3 – z.B. "UX Designer"]:</h4>
     <ul>
       <li><strong>Kostenlos:</strong> [Konkreter Kurs/YouTube-Kanal/Platform NUR für diesen Beruf – mit Name]</li>
       <li><strong>Udemy/LinkedIn:</strong> [Konkreter Kursname NUR für diesen Beruf – mit Preis]</li>
       <li><strong>Zertifikat:</strong> [1 konkretes Zertifikat direkt für diesen Beruf – mit Anbieter]</li>
     </ul>
   </div>
   
   ❌ NIEMALS Platzhalter wie [Karriereweg 1] stehen lassen!
   ✅ Immer den echten Berufsnamen einsetzen!
   ✅ Alle 3 Karrierewege müssen ausgefüllt sein!

5. **KONKRETE NÄCHSTE SCHRITTE**

   <div class="section-container">
     <h3>🎯 DEINE nächsten Schritte</h3>
     <div class="step-item">
       <span class="step-number">1</span>
       <div class="step-content"><strong>Sofort (heute noch):</strong> [KONKRET: Nenne eine echte Jobplattform + den exakten Suchbegriff. Z.B. "Geh auf ausbildung.de, suche '[Berufsname]' in ${location} – du wirst sofort sehen dass [bekannte lokale Firma] dort Azubis sucht."]</div>
     </div>
     <div class="step-item">
       <span class="step-number">2</span>
       <div class="step-content"><strong>Diese Woche:</strong> [PFLICHT: Nenne 2-3 ECHTE namentlich bekannte Unternehmen in ${location} oder Umgebung die in diesem Bereich ausbilden oder einstellen. Format: "Schreibe direkt an [Firma 1], [Firma 2] oder [Firma 3] in ${location} – diese Unternehmen bilden regelmäßig [Beruf] aus. Eine kurze Initiativ-E-Mail reicht!" NIEMALS generisch schreiben wie lokale Betriebe oder Unternehmen in deiner Nähe!]</div>
     </div>
     <div class="step-item">
       <span class="step-number">3</span>
       <div class="step-content"><strong>Nächster Monat:</strong> [KONKRET: z.B. "Erstelle DEINEN Lebenslauf auf canva.com (kostenlos) – nutze die Firmennamen aus Schritt 2 als Ziel-Arbeitgeber in DEINEM Anschreiben"]</div>
     </div>
     <div class="step-item">
       <span class="step-number">4</span>
       <div class="step-content"><strong>In 3-6 Monaten:</strong> [KONKRET: Bewerbungsfristen + ggf. NC-Check + nächste Messe oder Ausbildungstag bei einer der genannten Firmen in ${location}]</div>
     </div>
     <div class="step-item">
       <span class="step-number">5</span>
       <div class="step-content"><strong>Langfristig:</strong> [KONKRET: Weiterbildung + Gehaltssprung]</div>
     </div>
   </div>

**FORMATIERUNG:**
- <div class="career-path-card"> für JEDEN Karriereweg
- <div class="badge-container"> für Badges
- <div clas
