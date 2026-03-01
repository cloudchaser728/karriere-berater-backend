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
                formData: JSON.stringify(formData),
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
  <p style="color: #e8f5ee; font-size: 1.05em; line-height: 1.7;">
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
   <div class="success-box">💪 <strong>Karriere-Turbo:</strong> Mit [Meister/Techniker/Fachwirt] verdienst DU [X.XXX – X.XXX] €/Monat – das sind +[X]% mehr. Dauer: ca. [X] Jahre berufsbegleitend.</div>

   WENN STUDIUM → diese Tabelle:
   <table class="salary-table">
     <tr><th>Phase</th><th>Einkommen</th></tr>
     <tr><td>Während Studium (BAföG/Nebenjob)</td><td>bis 934 € BAföG oder 500–800 € Nebenjob</td></tr>
     <tr class="highlight-row"><td>Einstiegsgehalt (Bachelor)</td><td>[XX.XXX – XX.XXX] €/Jahr</td></tr>
     <tr class="highlight-row"><td>Nach 3–5 Jahren</td><td>[XX.XXX – XX.XXX] €/Jahr</td></tr>
     <tr><td>Mit Master (+2 Jahre)</td><td>[XX.XXX – XX.XXX] €/Jahr Einstieg</td></tr>
   </table>
   <div class="success-box">💪 <strong>Karriere-Turbo:</strong> Mit [Master/MBA/Promotion] erreichst DU [XX.XXX – XX.XXX] €/Jahr – das sind +[X]% mehr als mit Bachelor allein.</div>

   **🚨 PFLICHT: JOB-BUTTONS – FÜR JEDEN KARRIEREWEG ZWINGEND!**
   Nach der Gehaltstabelle MÜSSEN immer die Such-Buttons kommen – NIEMALS weglassen!

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
     <p><strong>📚 Fächer / Lerninhalte:</strong> [MINDESTENS 10-12 konkrete Fächer]</p>
     <p><strong>🔧 Praxis im Betrieb:</strong> [Was macht man, welche Tools/Maschinen]</p>
     <p><strong>📅 Was passiert in welchem Jahr:</strong> [Jahr 1, 2, 3 konkret]</p>
     <p><strong>📝 Prüfungen im Detail:</strong> [Zwischen- und Abschlussprüfung konkret]</p>
     <p><strong>📄 Bewerbung – Checkliste:</strong> [Alle Unterlagen, Fristen, Auswahlverfahren]</p>
     <p><strong>⏰ Typischer Ausbildungstag:</strong> [Morgens bis abends konkret]</p>
     <p><strong>💪 Was wirklich auf DICH zukommt:</strong> [Ehrlich: was ist schwer, was macht Spaß]</p>
     <p><strong>✅ Voraussetzungen & Tipps:</strong> [Schulabschluss, Noten, Bewerbungstipps]</p>
     <p><strong>🎓 Das kannst DU danach:</strong> [Konkrete Fähigkeiten und Türen die sich öffnen]</p>
   
     WENN STUDIUM:
     <p><strong>🏛️ Studienform & Aufbau:</strong> [Präsenz/Dual/Online, Semester, Aufbau]</p>
     <p><strong>📚 Pflichtfächer Grundstudium:</strong> [MINDESTENS 8-10 konkrete Fächer]</p>
     <p><strong>📚 Fächer Hauptstudium:</strong> [MINDESTENS 8-10 weitere Fächer]</p>
     <p><strong>🎯 Spezialisierungen:</strong> [Vertiefungsrichtungen, ab wann wählbar]</p>
     <p><strong>📅 Semesterplan:</strong> [Jedes Semester kurz beschreiben]</p>
     <p><strong>📝 Prüfungen im Detail:</strong> [Klausuren, Hausarbeiten, Bachelorarbeit]</p>
     <p><strong>📄 Bewerbung – Checkliste:</strong> [NC, Fristen, Unterlagen, Auswahlverfahren]</p>
     <p><strong>⏰ Typische Studienwoche:</strong> [Stunden Vorlesungen, Selbststudium, Gruppen]</p>
     <p><strong>💪 Was wirklich auf DICH zukommt:</strong> [Workload, schwere Fächer, Hürden]</p>
     <p><strong>✅ Voraussetzungen & Tipps:</strong> [Vorkenntnisse, Bewerbungstipps]</p>
     <p><strong>🎓 Das kannst DU danach:</strong> [Berufsfelder, Fähigkeiten, nächste Schritte]</p>
   
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

   <div class="section-container">
     <h3>📚 Weiterbildungs-Tipps für DEINE Karrierewege</h3>
     <h4>[Karriereweg 1]:</h4>
     <ul>
       <li><strong>Kostenlos:</strong> [Konkrete Kurse/Kanäle]</li>
       <li><strong>Udemy:</strong> [Konkrete Kurse mit Preis]</li>
       <li><strong>Zertifikat:</strong> [1 konkretes Zertifikat]</li>
     </ul>
     <h4>[Karriereweg 2]:</h4>
     <ul>
       <li><strong>Kostenlos:</strong> [Konkret]</li>
       <li><strong>Udemy/LinkedIn:</strong> [Konkret]</li>
       <li><strong>Zertifikat:</strong> [Konkret]</li>
     </ul>
     <h4>[Karriereweg 3]:</h4>
     <ul>
       <li><strong>Kostenlos:</strong> [Konkret]</li>
       <li><strong>Udemy/LinkedIn:</strong> [Konkret]</li>
       <li><strong>Zertifikat:</strong> [Konkret]</li>
     </ul>
   </div>

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
- <div class="info-box"> für wichtige Infos
- <table class="salary-table"> für Gehälter
- <h3> und <h4> für Überschriften
- Sprich IMMER mit "DU"!

**JOB-SUCH-BUTTONS FÜR AUSBILDUNG:**
<div class="job-search-buttons">
  <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+ausbildung+${locationEncoded}&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🔍 Ausbildungsplätze finden</a>
  <a href="https://www.ausbildung.de/suche?what=[BERUFSBEZEICHNUNG]&where=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📋 Auf Ausbildung.de suchen</a>
  <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]+ausbildung&l=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Auf Indeed suchen</a>
</div>

**JOB-SUCH-BUTTONS FÜR STUDIUM:**
<div class="job-search-buttons">
  <a href="https://www.google.com/search?q=[STUDIENGANG]+Studium+${location}" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🎓 Studiengang suchen</a>
  <a href="https://www.studycheck.de/suche?q=[STUDIENGANG]&location=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📚 StudyCheck</a>
  <a href="https://www.google.com/search?q=[STUDIENGANG]+duales+Studium+${location}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Duales Studium</a>
</div>

**JOB-SUCH-BUTTONS FÜR BERUFSTÄTIGE/ABSOLVENTEN:**
<div class="job-search-buttons">
  <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+${locationEncoded}&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🔍 Jobs auf Google finden</a>
  <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]&l=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Auf Indeed suchen</a>
  <a href="https://www.stepstone.de/jobs/[BERUFSBEZEICHNUNG]/in-${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📋 Auf StepStone suchen</a>
</div>

**🚨 PFLICHT – ALLE 3 KARRIEREWEGE MÜSSEN AM ENDE DIESE 3 BLÖCKE HABEN:**

Block A) 🔮 Zukunft & Jobmarkt-Trend (wie oben beschrieben)

Block B) 🎯 Warum dieser Weg zu DIR passt:
<h4>🎯 Warum dieser Weg zu DIR passt:</h4>
<div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
  <p>[Konkrete Begründung mit direktem Bezug auf Stärken, Flow, Interessen, Prioritäten]</p>
</div>

Block C) 🔀 3 ähnliche Alternativen:
<h4>🔀 3 ähnliche Alternativen die ebenfalls passen könnten:</h4>
<div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
  <p><strong>Alternative 1:</strong> [Beruf] – [Warum + Unterschied]</p>
  <p><strong>Alternative 2:</strong> [Beruf] – [Warum + Unterschied]</p>
  <p><strong>Alternative 3:</strong> [Beruf] – [Warum + Unterschied]</p>
</div>

✅ Karriereweg 1: Block A + B + C ← PFLICHT
✅ Karriereweg 2: Block A + B + C ← PFLICHT
✅ Karriereweg 3: Block A + B + C ← PFLICHT

${formData.praktikum === 'ja' ? `
**PRAKTIKUM GESUCHT – Füge bei JEDEM Karriereweg diesen Button hinzu:**
<a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+Praktikum+${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #f97316;">🎯 Praktikum finden</a>
` : ''}

**🏭 LOKALE LEUCHTTURM-FIRMEN – PFLICHT FÜR JEDEN KARRIEREWEG:**

Bei den konkreten Nächsten Schritten UND bei Warum dieser Weg passt MUSST DU echte Firmen aus der Region  namentlich nennen!

REGELN:
- Nenne IMMER 2-3 echte, bekannte Unternehmen die in  oder Umgebung ansässig sind und in dem empfohlenen Bereich ausbilden oder einstellen
- KEINE generischen Aussagen wie lokale Unternehmen oder Betriebe in deiner Naehe
- Verknuepfe die Firma direkt mit dem Karriereweg: z.B. BMW in Muenchen bildet Mechatroniker aus - das waere ein Traumarbeitgeber fuer DICH

Beispiele nach Standort + Branche:
- Stuttgart + Technik: Mercedes-Benz, Bosch, Porsche
- Muenchen + IT: Siemens, MAN, Allianz Tech
- Koeln + Kaufmaennisch: Ford, REWE Group, Lanxess
- Hamburg + Logistik: Hapag-Lloyd, HHLA, Otto Group
- Berlin + Digital: Zalando, Delivery Hero, Siemens Energy
- Frankfurt + Finance: Deutsche Bank, DZ Bank, Commerzbank
- Duesseldorf + Handel: Metro, Henkel, Vodafone Deutschland
- Nuernberg + Technik: Siemens, Datev, Bosch
- Leipzig + Produktion: BMW, Amazon, Porsche
- Dortmund + Handwerk: ThyssenKrupp, Vonovia, Signal Iduna

WENN der Standort eine kleinere Stadt ist:
Nenne die 2-3 groessten lokalen Arbeitgeber die bekannt sind und ergaenze mit dem naechsten Ballungsraum: z.B. Oder schau in Richtung [naechste Grossstadt] - dort gibt es [Firma X]

Diese Firmen-Nennung macht die Analyse 10x persoenlicher und gibt dem Schueler sofort ein konkretes Ziel!

Sei KONKRET und REALISTISCH! Beruecksichtige STRIKT den Bildungsabschluss!`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `DU bist ein erfahrener Karriere- und Studienberater mit 15+ Jahren Erfahrung. DU gibst konkrete, umsetzbare Empfehlungen und sprichst die Leute IMMER mit DU an - nie mit Sie! DU bist wie ein guter Freund der hilft.

EXTREM WICHTIG - AUSGABE-FORMAT:
- Gib NUR reines HTML zurück - NIEMALS Markdown!
- NIEMALS ## oder ### oder --- oder ** oder * verwenden!
- NIEMALS Markdown-Überschriften – immer <h3> und <h4> Tags!
- Alle Abschnitte in die vorgegebenen HTML-Container
- Kein Markdown, kein Plain-Text, nur sauberes HTML!`
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.7,
            max_tokens: 16000,
        });

        const analysis = completion.choices[0].message.content;

        analysisResults.set(sessionId, {
            analysis: analysis,
            timestamp: new Date(),
            formData: formData
        });

        console.log('Analysis complete for session:', sessionId);

        return analysis;
    } catch (error) {
        console.error('OpenAI API Error:', error);
        throw error;
    }
}

// 3. GET ANALYSIS RESULT
app.get('/get-analysis/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    
    try {
        const result = analysisResults.get(sessionId);
        
        if (!result) {
            return res.status(202).json({ 
                status: 'processing',
                message: 'Analyse läuft noch...' 
            });
        }

        res.json({
            status: 'complete',
            analysis: result.analysis
        });
    } catch (error) {
        console.error('Get Analysis Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// CHATBOT ENDPOINT
// ==========================================
app.post('/api/chatbot', async (req, res) => {
    try {
        const { question, analysisContext, sessionId } = req.body;
        
        console.log('💬 Chatbot Question:', question);
        
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `DU bist ein freundlicher Karriereberater. 
                    
Der User hat gerade diese Karriere-Analyse bekommen:
${analysisContext}

DEINE ROLLE: Du bist kein passiver Auskunftgeber – DU bist ein aktiver Karriere-Mentor der den Schüler herausfordert, zum Nachdenken bringt und konkrete nächste Schritte einfordert.

MENTOR-PRINZIPIEN:
1. Beantworte die Frage – aber stelle IMMER eine Gegenfrage oder Challenge am Ende
2. Fordere den Schüler aktiv heraus: Trau DU dich das wirklich? Hast DU das schon probiert? Was hält DICH konkret zurück?
3. Wenn der Schüler Zweifel äußert → biete sofort eine Alternative aus der Analyse an
4. Wenn der Schüler begeistert ist → steigere die Motivation mit einem konkreten ersten Schritt HEUTE
5. Nutze "DU"-Anrede durchgehend, sei direkt und auf Augenhöhe – wie ein älterer Bruder/Schwester der es gut meint

ANTWORT-STRUKTUR (halte dich IMMER daran):
- Satz 1-2: Konkrete Antwort auf die Frage (faktenbasiert aus der Analyse)
- Satz 3: Persönliche Challenge oder überraschende Beobachtung
- Satz 4: Konkrete Handlungsaufforderung oder Gegenfrage die zum Nachdenken bringt

CHALLENGE-BEISPIELE (passe sie an den jeweiligen Kontext an):
- "Ich habe dir [Beruf] empfohlen. Aber mal ehrlich: Traust du dir zu, [konkrete Anforderung dieses Berufs]? Wenn nicht – kein Problem, dann lass uns über [Alternative aus Analyse] reden."
- "Du fragst nach [Thema]. Spannend – weißt DU schon warum genau DU dich das fragst? Das sagt viel über DEINE echten Prioritäten aus."
- "Das klingt gut – aber sag mir: Was ist DEIN konkreter Plan für die nächsten 7 Tage? Ohne Plan bleibt das eine schöne Idee."
- "Viele fragen mich das. Die die es wirklich durchziehen machen danach sofort [konkreter Schritt]. DU auch?"

WENN DER SCHÜLER ZWEIFELT:
→ Nicht beruhigen sondern konkret werden: "Okay, der Zweifel ist berechtigt. Lass uns das aufdröseln: Was genau macht dir Sorgen – das Gehalt, die Ausbildung selbst oder die Bewerbung?"

WENN DER SCHÜLER BEGEISTERT IST:
→ Direkt zum nächsten Schritt pushen: "Perfekt – dann mach JETZT folgendes: [eine konkrete Aktion die in 10 Minuten erledigt ist]"

Halte Antworten auf 4-6 Sätze. Kein Monolog – Dialog!

WICHTIG: Antworte immer basierend auf der Analyse oben!`
                },
                {
                    role: "user",
                    content: question
                }
            ],
            temperature: 0.7,
            max_tokens: 500
        });
        
        const answer = completion.choices[0].message.content;
        
        console.log('✅ Chatbot Answer generated');
        
        res.json({ 
            answer: answer
        });
        
    } catch (error) {
        console.error('❌ Chatbot Error:', error);
        res.status(500).json({ 
            error: 'Entschuldigung, da ist ein Fehler aufgetreten. Bitte versuche es nochmal.' 
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log('=================================');
    console.log('✅ SERVER LÄUFT auf Port', PORT);
    console.log('🆕 Partner-Endpoint aktiv!');
    console.log('🤖 Chatbot-Endpoint aktiv!');
    console.log('🔍 "KI hat dich durchschaut" Block aktiv!');
    console.log('=================================');
});

module.exports = app;
