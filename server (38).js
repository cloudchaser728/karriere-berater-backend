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

// 🆕 PARTNER-ANALYSE (KOSTENLOS)
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

// 2. ANALYZE WITH OPENAI GPT-4
async function analyzeCareerWithAI(formData, sessionId) {
    try {
        console.log('Starting analysis for session:', sessionId);

        const location = formData.location || 'Deutschland';
        const locationEncoded = encodeURIComponent(location);
        const isDeutschlandweit = location === 'Deutschlandweit';

        // ── PRAKTIKUM-BLOCK: wird in jeden career-path-card eingefügt wenn gewünscht ──
        const praktikumBlock = formData.praktikum === 'ja' ? `
**🎯 PRAKTIKUM GESUCHT – PFLICHTBLOCK FÜR ALLE 3 KARRIEREWEGE:**
Der User sucht aktiv ein Praktikum! Füge in JEDEN der 3 career-path-card Blöcke diesen Block ein,
DIREKT VOR den normalen Job-/Ausbildungs-Such-Buttons:

<h4>🎯 Praktikum – So findest DU einen Platz</h4>
<div class="info-box" style="background: #fff7ed; border-left: 4px solid #f97316;">
  <p><strong>🏢 Wer bietet Praktika an?</strong> [Konkrete Firmen und Unternehmenstypen in ${location} die in DIESEM Bereich Praktika vergeben – nenne 3-5 bekannte Arbeitgeber oder typische Unternehmensarten]</p>
  <p><strong>⏰ Wann bewerben?</strong> [Typische Fristen für Praktika in DIESEM Bereich – z.B. "3-6 Monate vorher, viele Firmen nehmen ganzjährig auf"]</p>
  <p><strong>📄 Was brauchst DU?</strong> [Konkrete Unterlagen: Lebenslauf, kurzes Anschreiben, letztes Zeugnis – was in DIESEM Bereich besonders wichtig ist]</p>
  <p><strong>💰 Wird das Praktikum bezahlt?</strong> [Typische Vergütung in DIESEM Bereich: Schulpraktikum meist unbezahlt, Pflichtpraktikum 300-800€/Monat, freiwillig bis 1.200€]</p>
  <p><strong>💡 Insider-Tipp:</strong> [Konkreter branchenspezifischer Tipp – z.B. "Ruf direkt an statt E-Mail – 80% der Praktikumsplätze werden nie ausgeschrieben"]</p>
</div>
<div class="job-search-buttons">
  <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+praktikum+${isDeutschlandweit ? 'deutschland' : locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #f97316;">
    🔍 Praktikum ${isDeutschlandweit ? 'deutschlandweit' : `in ${location}`} suchen
  </a>
  <a href="https://www.praktikum.de/search?q=[BERUFSBEZEICHNUNG]${isDeutschlandweit ? '' : `&location=${locationEncoded}`}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">
    📋 Praktikum.de
  </a>
  <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]+praktikum${isDeutschlandweit ? '' : `&l=${locationEncoded}`}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">
    💼 Indeed Praktikum
  </a>
</div>
` : '';

        const prompt = `DU bist ein professioneller Karriere- und Studienberater. Analysiere folgende Informationen und erstelle eine detaillierte, personalisierte Karriereberatung auf Deutsch.

🚨 ABSOLUT WICHTIG – NUR HTML AUSGEBEN:
- Antworte AUSSCHLIESSLICH mit fertigem HTML-Code!
- KEIN Markdown! Kein ##, kein ###, kein ---, kein **, kein *
- KEINE Markdown-Überschriften! Nur <h3> und <h4> HTML-Tags!
- KEINE Trennlinien mit ---! Nutze die vorgegebenen HTML-Container!
- Alle Abschnitte in <div class="career-path-card"> oder <div class="section-container">
- Das HTML wird direkt in eine Webseite eingebettet – Markdown würde alles zerstören!

**WICHTIG: Sprich den User DURCHGEHEND mit "DU" an! Keine "Sie"-Form!**

PERSÖNLICHE DATEN:
- Alter: ${formData.age}
- Aktuelle Situation: ${Array.isArray(formData.situation) ? formData.situation.join(', ') : formData.situation}
- **STANDORT: ${location}** ← WICHTIG FÜR JOB-LINKS!
- Flow-Aktivität (Was DIR leicht fällt): ${formData.flow_activity}
- Anti-Job (Was DU NICHT willst): ${Array.isArray(formData.anti_job) ? formData.anti_job.join(', ') : formData.anti_job}
- Interessen: ${Array.isArray(formData.interests) ? formData.interests.join(', ') : formData.interests}
- Stärken: ${formData.strengths}
- Arbeitsstil: ${Array.isArray(formData.work_style) ? formData.work_style.join(', ') : formData.work_style}
- Digital/Physisch: ${Array.isArray(formData.work_type) ? formData.work_type.join(', ') : formData.work_type}
- Energie-Quellen: ${Array.isArray(formData.energy) ? formData.energy.join(', ') : formData.energy}
- Prioritäten: ${Array.isArray(formData.priority) ? formData.priority.join(', ') : formData.priority}
- Risikobereitschaft: ${Array.isArray(formData.risk) ? formData.risk.join(', ') : formData.risk}
- Routine/Abwechslung: ${Array.isArray(formData.routine) ? formData.routine.join(', ') : formData.routine}
- **BILDUNG: ${formData.education}** ← KRITISCH FÜR EMPFEHLUNGEN!
- **NOTEN HAUPTFÄCHER: Deutsch: ${formData.note_deutsch || 'k.A.'} | Mathe: ${formData.note_mathe || 'k.A.'} | Englisch: ${formData.note_englisch || 'k.A.'}**
- **RESTLICHE NOTEN: Überwiegend ${formData.noten_rest || 'k.A.'}**
- **PRAKTIKUM GESUCHT: ${formData.praktikum === 'ja' ? 'JA – Praktikumsblock (orange) für ALLE 3 Karrierewege einbauen!' : 'Nein – kein Praktikumsblock'}**

**🎓 BILDUNGS-FILTER (STRIKT BEACHTEN!):**

${formData.education === 'abitur' ? `
**DU HAST ABITUR (Allgemeine Hochschulreife)** - WICHTIG:
- MINDESTENS 1-2 DEINER Top 3 Empfehlungen MÜSSEN Studiengänge (Uni/FH) sein!
- Duales Studium ist eine exzellente Option (Gehalt + Abschluss)
- Ausbildung nur als Alternative, nicht als Hauptempfehlung
- Für Studiengänge: NC angeben, BAföG/Finanzierung erwähnen
- Zeige den akademischen Weg als primäre Option!
- DU kannst an ALLEN Universitäten und Fachhochschulen studieren!
` : ''}

${formData.education === 'fachabitur' ? `
**DU HAST FACHABITUR (Fachhochschulreife)** - WICHTIG:
- Zeige SOWOHL Ausbildungen ALS AUCH FH-Studiengänge!
- DU kannst an FACHHOCHSCHULEN studieren (NICHT an Universitäten!)
- Duales Studium ist ideal (Gehalt + Abschluss an FH)
- Ausbildung ist gleichwertige Option
- NICHT "Uni" vorschlagen, nur "FH" oder "Hochschule"!
- Erwähne explizit: "Mit Fachabitur an FH möglich"
- NC für FH-Studiengänge angeben
` : ''}

${formData.education === 'realschule' ? `
**DU HAST REALSCHULABSCHLUSS** - WICHTIG:
- Schlage PRIMÄR Ausbildungen vor
- Erkläre den Weg zum Studium NUR über den 2. Bildungsweg
- Beispiel: "Nach der Ausbildung kannst DU DEIN Fachabitur nachholen und dann studieren"
- Duales Studium ist NICHT direkt möglich (erst nach Ausbildung + Fachabitur)
` : ''}

${formData.education === 'hauptschule' ? `
**DU HAST HAUPTSCHULABSCHLUSS** - WICHTIG:
- Fokus auf Ausbildungsberufe
- Zeige den Weg auf: Ausbildung → Weiterbildung zum Meister/Techniker
- Erwähne: "Mit guten Leistungen in der Ausbildung kannst DU später DEIN Abitur nachholen"
` : ''}

${formData.education === 'school' ? `
**DU BIST NOCH IN DER SCHULE** - WICHTIG:
- Frage DICH: Welcher Abschluss wird angestrebt? (Abi, Real, Haupt?)
- Zeige BEIDE Wege: Ausbildung UND Studium
- Erkläre die Unterschiede
` : ''}

${formData.education === 'bachelor' || formData.education === 'master' ? `
**DU HAST SCHON STUDIERT** - WICHTIG:
- Fokus auf Berufe die ein Studium erfordern/bevorzugen
- Karrierewechsel innerhalb akademischer Berufe
- Weiterbildungen auf Master/MBA-Level
` : ''}

**📊 NOTEN-FILTER (STRIKT BEACHTEN!):**

Basierend auf den Noten/Punkten MUSST DU die Karriereempfehlungen realistisch filtern:

- **Hauptfächer Note 1-2 / Punkte 13-15:** Alle Karrierewege empfehlbar – auch hoch kompetitive wie Medizin, Informatik, Bank, Versicherung, Jura
- **Hauptfächer Note 3 / Punkte 10-12:** Mittlere Wettbewerbsfähigkeit – IT-Ausbildung möglich aber schwieriger, Studium realistisch mit NC-Hinweis
- **Hauptfächer Note 4-5 / Punkte 5-9:** Kompetitive Ausbildungen (IT, Bank, Versicherung, Medizin) sind UNREALISTISCH → empfehle stattdessen: Handwerk, Lager, Produktion, Gastronomie, Pflege, Einzelhandel + zeige Verbesserungswege
- **Hauptfächer Note 6 / Punkte 0-4:** Nur einfache Ausbildungsberufe + Empfehlung für Nachhilfe/Förderung

**Sei EHRLICH aber ERMUTIGEND!** Zeige immer auch den Weg zur Verbesserung!

${praktikumBlock}

AUFGABE:
Erstelle eine umfassende Karriereberatung mit KONKRETEM FAHRPLAN für jeden Beruf.

**WICHTIG - KLASSISCHE STUDIENGÄNGE NICHT VERGESSEN:**
Ziehe auch klassische, etablierte Studiengänge in Betracht:
- **Medizin** (wenn Interesse an Gesundheit + hohe Lernbereitschaft)
- **Jura** (wenn analytisches Denken + Argumentation)
- **Maschinenbau** (wenn Technik + Hands-on)
- **Elektrotechnik** (wenn Technik + Digital)
- **Informatik** (wenn Technologie + Problemlösen)
- **BWL** (wenn Business + Zahlen)
- **Psychologie** (wenn Menschen + Verstehen)
- **Architektur** (wenn Kreativität + Struktur)
- **Lehramt** (wenn Menschen + Wissensvermittlung)

NICHT nur "Management"-Studiengänge vorschlagen!
Wenn User "Gesundheit" wählt → auch MEDIZIN (Arzt/Ärztin) zeigen!
Wenn User "Recht/Regeln" erwähnt → auch JURA zeigen!

**STRUKTUR:**

1. **DEIN PROFIL**
   - Kurze Zusammenfassung DEINER Arbeitsweise und Flow-State
   - Was macht DICH einzigartig?

2. **DEINE TOP 3 KARRIEREWEGE**
   
   **WICHTIG: Berücksichtige den Bildungsabschluss strikt!**
   
   **BEISPIELE FÜR PASSENDE EMPFEHLUNGEN:**
   - Interesse "Gesundheit" → Medizin (Staatsexamen), Zahnmedizin, Psychologie
   - Interesse "Recht/Regeln" → Jura (Staatsexamen), Rechtswissenschaften
   - Interesse "Technik" → Maschinenbau, Elektrotechnik, Informatik
   - Interesse "Menschen" → Psychologie, Soziale Arbeit, Lehramt
   - Interesse "Business" → BWL, VWL, Wirtschaftsinformatik
   
   Für JEDEN Beruf MUSST DU folgendes liefern:
   
   **[Berufsbezeichnung]** (z.B. "Fachinformatiker/in" oder "Wirtschaftsinformatik (B.Sc.)")
   
   **Der Weg dorthin:**
   
   WENN AUSBILDUNG:
   - Exakte Berufsbezeichnung
   - Dauer (z.B. "3 Jahre")
   - Voraussetzungen: Abitur, Realschulabschluss, Hauptschulabschluss?
   - Dual oder schulisch?
   
   WENN STUDIUM:
   - Studienfach: Exakter Name (z.B. "Betriebswirtschaftslehre (B.Sc.)")
   - Hochschultyp: Universität oder Fachhochschule?
   - Regelstudienzeit: Meist 6-7 Semester (3-3,5 Jahre)
   - Voraussetzung: Abitur (Uni) oder Fachabitur (FH)
   - NC-Check: Ungefährer Numerus Clausus (z.B. "NC meist zwischen 2,0-3,0")
   
   WENN DUALES STUDIUM:
   - Kombiniert Studium + Praxis
   - Gehalt während des Studiums (ca. 1.000-1.500 €/Monat)
   - Welche Hochschulen bieten das an?
   
   **Die harten Fakten:**
   
   WENN AUSBILDUNG:
   - Ausbildungsvergütung: 1./2./3. Jahr
   - Einstiegsgehalt nach Abschluss
   - Gehalt nach 3-5 Jahren
   
   WENN STUDIUM:
   - Finanzierung: BAföG (bis zu 934 €) oder Nebenjob (ca. 500-800 €)
   - Einstiegsgehalt nach Bachelor
   - Gehalt nach 3-5 Jahren
   - Mit Master: Wie viel mehr?
   
   **Karriere-Turbo:** Konkrete Zahlen (z.B. "von 3.500 € auf 5.000 €")
   
   **Warum dieser Beruf zu DIR passt:** Konkrete Bezüge zu Stärken und Interessen

   ${formData.praktikum === 'ja' ? `
   ⚠️ PRAKTIKUM PFLICHT: Füge den orangenen Praktikumsblock (aus dem PRAKTIKUM-BLOCK oben)
   DIREKT VOR den Job-/Ausbildungs-Such-Buttons ein! Ersetze [BERUFSBEZEICHNUNG] mit dem exakten Namen!
   ` : ''}

   **📋 STECKBRIEF – Was auf DICH zukommt:**
   
   Nutze dieses Format innerhalb jedes <div class="career-path-card">:
   
   <h4>📋 Steckbrief – Was auf DICH zukommt</h4>
   <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
   
     WENN AUSBILDUNG:
     <p><strong>🏫 Lernorte & Aufteilung:</strong> [Wie viele Tage Betrieb + Berufsschule]</p>
     <p><strong>📚 Fächer in der Berufsschule:</strong> [MINDESTENS 10-12 konkrete Fächer]</p>
     <p><strong>🔧 Praxis im Ausbildungsbetrieb:</strong> [Was man im Betrieb macht, Tools, Einarbeitung]</p>
     <p><strong>📅 Was passiert in welchem Ausbildungsjahr:</strong> [1./2./3. Jahr konkret]</p>
     <p><strong>📝 Prüfungen im Detail:</strong> [Zwischenprüfung + Abschlussprüfung]</p>
     <p><strong>📄 Bewerbung – vollständige Checkliste:</strong> [Alle Unterlagen, wo bewerben, Fristen]</p>
     <p><strong>⏰ Ein typischer Ausbildungstag:</strong> [Konkreter Tagesablauf]</p>
     <p><strong>💪 Was wirklich auf DICH zukommt:</strong> [Ehrliche Einschätzung]</p>
     <p><strong>✅ Voraussetzungen & Bewerbungstipps:</strong> [Schulabschluss, Noten, Tipps]</p>
     <p><strong>🎓 Das kannst DU danach:</strong> [Fähigkeiten, Zertifikate, Türen die sich öffnen]</p>
   
     WENN STUDIUM (FH oder Uni):
     <p><strong>🏛️ Studienform & Aufbau:</strong> [Präsenz/Dual/Online + konkreter Aufbau]</p>
     <p><strong>📚 Pflichtfächer Grundstudium (1.-2. Sem.):</strong> [MINDESTENS 8-10 konkrete Fächer]</p>
     <p><strong>📚 Fächer Hauptstudium (3.-5. Sem.):</strong> [MINDESTENS 8-10 weitere Fächer]</p>
     <p><strong>🎯 Spezialisierungen & Wahlpflichtfächer:</strong> [Vertiefungsrichtungen]</p>
     <p><strong>📅 Semesterplan:</strong> [Was passiert in welchem Semester]</p>
     <p><strong>📝 Prüfungen im Detail:</strong> [Klausuren, Hausarbeiten, Bachelorarbeit]</p>
     <p><strong>📄 Bewerbung – vollständige Checkliste:</strong> [NC, Fristen, Unterlagen]</p>
     <p><strong>⏰ Eine typische Studienwoche:</strong> [Stunden Vorlesungen + Selbststudium]</p>
     <p><strong>💪 Was wirklich auf DICH zukommt:</strong> [Ehrliche Einschätzung, Workload]</p>
     <p><strong>✅ Voraussetzungen & Tipps:</strong> [Vorkenntnisse, Stärken, Bewerbungstipps]</p>
     <p><strong>🎓 Das kannst DU danach:</strong> [Fähigkeiten, Berufsfelder]</p>
   
   </div>
   
   **🔮 Zukunftsprognose & Jobmarkt-Trend:**
   
   <h4>🔮 Zukunft & Jobmarkt-Trend</h4>
   <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
     <p><strong>📈 Zukunftssicherheit:</strong> [🟢 SEHR SICHER / 🟡 SICHER / 🟠 MITTEL / 🔴 RISIKO + Begründung]</p>
     <p><strong>🌍 Branchentrend:</strong> [Entwicklung bis 2030/2035]</p>
     <p><strong>🤖 KI & Automatisierungs-Einfluss:</strong> [Bedroht, verändert oder gestärkt?]</p>
     <p><strong>🏆 Sektoren mit größtem Bedarf:</strong> [Wo wird man am meisten gesucht?]</p>
     <p><strong>📊 Arbeitsmarkt-Fakten:</strong> [Konkrete Zahlen – offene Stellen, Arbeitslosenquote]</p>
     <p><strong>💡 Zukunfts-Tipp:</strong> [Was zusätzlich lernen?]</p>
   </div>

**NACH DEN TOP 3 KARRIEREWEGEN KOMMEN DIE WEITEREN SEKTIONEN**

${formData.education === 'abitur' || formData.education === 'fachabitur' || formData.education === 'school' ? `
4. **UNI/HOCHSCHUL-EMPFEHLUNGEN**
   - ${formData.education === 'fachabitur' ? '3-5 konkrete FACHHOCHSCHULEN in Deutschland (KEINE Unis!)' : '3-5 konkrete Unis/FHs in Deutschland für DEINE Studiengänge'}
   - NC-Anforderungen
   - Duale Hochschulen in DEINER Nähe
` : ''}

5. **WEITERBILDUNGS-TIPPS**
   🚨 Spezifisch für die 3 empfohlenen Karrierewege – KEINE generischen Kurse!
   
   <div class="section-container">
     <h3>📚 Weiterbildungs-Tipps für DEINE Karrierewege</h3>
     <h4>[Karriereweg 1]:</h4>
     <ul>
       <li><strong>Kostenlos:</strong> [Konkrete Kurse/Kanäle NUR für diesen Beruf]</li>
       <li><strong>Udemy:</strong> [Konkrete Kurse mit Preis]</li>
       <li><strong>Zertifikat:</strong> [1 konkretes Zertifikat]</li>
     </ul>
     <h4>[Karriereweg 2]:</h4>
     <ul>
       <li><strong>Kostenlos:</strong> [...]</li>
       <li><strong>Udemy/LinkedIn Learning:</strong> [...]</li>
       <li><strong>Zertifikat:</strong> [...]</li>
     </ul>
     <h4>[Karriereweg 3]:</h4>
     <ul>
       <li><strong>Kostenlos:</strong> [...]</li>
       <li><strong>Udemy/LinkedIn Learning:</strong> [...]</li>
       <li><strong>Zertifikat:</strong> [...]</li>
     </ul>
   </div>

6. **KONKRETE NÄCHSTE SCHRITTE**
   <div class="section-container">
     <h3>🎯 DEINE nächsten Schritte</h3>
     <div class="step-item"><span class="step-number">1</span><div class="step-content"><strong>Sofort (heute noch):</strong> [KONKRET auf Karriereweg 1 + Standort zugeschnitten]</div></div>
     <div class="step-item"><span class="step-number">2</span><div class="step-content"><strong>Diese Woche:</strong> [KONKRET]</div></div>
     <div class="step-item"><span class="step-number">3</span><div class="step-content"><strong>Nächster Monat:</strong> [KONKRET]</div></div>
     <div class="step-item"><span class="step-number">4</span><div class="step-content"><strong>In 3-6 Monaten:</strong> [KONKRET]</div></div>
     <div class="step-item"><span class="step-number">5</span><div class="step-content"><strong>Langfristig:</strong> [KONKRET]</div></div>
   </div>

**FORMATIERUNG:**
- <div class="career-path-card"> für JEDEN Karriereweg
- <div class="badge-container"> für Badges
- <div class="info-box"> für wichtige Infos
- <table class="salary-table"> für Gehälter
- <div class="step-item"> für Schritte
- Sprich IMMER mit "DU"!

**JOB-/AUSBILDUNGS-SUCH-BUTTONS (nach dem optionalen Praktikumsblock):**

Bei Ausbildung:
<div class="job-search-buttons">
  <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+ausbildung+${isDeutschlandweit ? '' : locationEncoded}&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🔍 Ausbildungsplätze finden</a>
  <a href="https://www.ausbildung.de/suche?what=[BERUFSBEZEICHNUNG]${isDeutschlandweit ? '' : `&where=${locationEncoded}`}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📋 Ausbildung.de</a>
  <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]+ausbildung${isDeutschlandweit ? '' : `&l=${locationEncoded}`}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Indeed</a>
</div>

Bei Studium:
<div class="job-search-buttons">
  <a href="https://www.hochschulkompass.de/studium/studiengangsuche/erweiterte-studiengangsuche.html?tx_szhrksearch_pi1[fach]=[STUDIENGANG]${isDeutschlandweit ? '' : `&tx_szhrksearch_pi1[ort]=${locationEncoded}`}" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🎓 Hochschulkompass</a>
  <a href="https://www.studycheck.de/suche?q=[STUDIENGANG]${isDeutschlandweit ? '' : `&location=${locationEncoded}`}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📚 StudyCheck</a>
  <a href="https://www.wegweiser-duales-studium.de/suche/?q=[STUDIENGANG]${isDeutschlandweit ? '' : `+${locationEncoded}`}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Duales Studium</a>
</div>

Bei Jobs (Berufstätige/Absolventen):
<div class="job-search-buttons">
  <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+${isDeutschlandweit ? '' : locationEncoded}&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🔍 Jobs finden</a>
  <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]${isDeutschlandweit ? '' : `&l=${locationEncoded}`}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Indeed</a>
  <a href="https://www.stepstone.de/jobs/[BERUFSBEZEICHNUNG]${isDeutschlandweit ? '' : `/in-${locationEncoded}`}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📋 StepStone</a>
</div>

**🚨 ABSOLUT PFLICHT – GILT FÜR ALLE 3 KARRIEREWEGE OHNE AUSNAHME:**
✅ Karriereweg 1: Steckbrief + Zukunft + Warum passt + Alternativen ← PFLICHT
✅ Karriereweg 2: Steckbrief + Zukunft + Warum passt + Alternativen ← PFLICHT
✅ Karriereweg 3: Steckbrief + Zukunft + Warum passt + Alternativen ← PFLICHT (auch der letzte!)
${formData.praktikum === 'ja' ? '✅ Karriereweg 1 + 2 + 3: Praktikumsblock (orange, vor den Job-Buttons) ← PFLICHT' : ''}

Sei KONKRET und REALISTISCH! Berücksichtige STRIKT den Bildungsabschluss!`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `DU bist ein erfahrener Karriere- und Studienberater mit 15+ Jahren Erfahrung. DU gibst konkrete, umsetzbare Empfehlungen und sprichst die Leute IMMER mit DU an - nie mit Sie! DU bist wie ein guter Freund der hilft.

EXTREM WICHTIG - AUSGABE-FORMAT:
- Gib NUR reines HTML zurück - NIEMALS Markdown!
- NIEMALS ## oder ### oder --- oder ** oder * verwenden!
- NIEMALS Markdown-Überschriften wie "## DEIN PROFIL" schreiben!
- NIEMALS "### 1. Fachinformatiker" schreiben - immer <h3> Tags nutzen!
- NIEMALS --- als Trennlinie - stattdessen die HTML-Klassen nutzen!
- Alle Überschriften als <h3> oder <h4> Tags
- Alle Abschnitte in die vorgegebenen HTML-Container wie <div class="career-path-card"> etc.
- Das Ergebnis muss direkt als fertiges HTML in die Webseite eingebettet werden können
- Kein Markdown, kein Plain-Text, nur sauberes HTML!`
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.7,
            max_tokens: 8000,
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

DEINE Aufgabe:
- Beantworte Fragen zur Analyse konkret und präzise
- Nutze die Informationen aus der Analyse
- Gib praktische, umsetzbare Tipps
- Sei ermutigend und motivierend
- Verwende "DU"-Anrede
- Halte Antworten auf 3-5 Sätze (nicht zu lang!)
- Füge wenn passend Job-Links oder Weiterbildungs-Tipps hinzu

Beispiel gute Antwort:
"Die Ausbildung zum Industriekaufmann dauert 3 Jahre. In Köln gibt es viele große Unternehmen wie Ford, Bayer oder Lanxess, die regelmäßig Azubis suchen. DU verdienst im ersten Jahr ca. 850€ und nach der Ausbildung 2.800-3.200€. Schau DIR am besten die Links in DEINER Analyse an - da findest DU aktuelle Stellen!"

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
        
        res.json({ answer: answer });
        
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
    console.log('🎯 Praktikum-Feature aktiv!');
    console.log('=================================');
});

module.exports = app;
