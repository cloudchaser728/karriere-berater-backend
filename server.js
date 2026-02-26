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
                    unit_amount: 499, // 4.99 EUR
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

        // Start analysis immediately
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

// 2. ANALYZE WITH OPENAI GPT-4 (VERBESSERTER PROMPT!)
async function analyzeCareerWithAI(formData, sessionId) {
    try {
        console.log('Starting analysis for session:', sessionId);

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
- **STANDORT: ${formData.location}** ← WICHTIG FÜR JOB-LINKS!
- Flow-Aktivität (Was DIR leicht fällt): ${formData.flow_activity}
- Anti-Job (Was DU NICHT willst): ${Array.isArray(formData.anti_job) ? formData.anti_job.join(', ') : formData.anti_job}

**🚨 WICHTIG – ANTI-JOB RICHTIG INTERPRETIEREN:**
Das Anti-Job gibt an was die Person EINZELNE TÄTIGKEITEN vermeiden möchte – es schließt verwandte Bereiche NICHT pauschal aus!

Beispiele für korrekte Interpretation:
- "Präsentationen = No-Go" → Kein Vortrag vor Gruppen, ABER die Person kann trotzdem gerne mit Menschen arbeiten (Teamarbeit, Kundengespräche, Beratung sind völlig ok!)
- "Telefonieren = No-Go" → Kein Call-Center, ABER Zusammenarbeit mit Menschen weiterhin möglich
- "Körperlich anstrengend = No-Go" → Kein Bau oder Lager, ABER leichte Bewegung im Job ist ok
- "Schreibtisch = No-Go" → Kein reiner Bürojob, ABER gelegentlich am PC arbeiten ist ok

REGEL: Anti-Job und Interessen IMMER intelligent kombinieren! Nie pauschal ganze Berufsbereiche wegen einer einzelnen Tätigkeit ausschließen!
- Interessen: ${Array.isArray(formData.interests) ? formData.interests.join(', ') : formData.interests}
- Stärken: ${formData.strengths}
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
→ Berücksichtige diese Infos bei den Empfehlungen! Wenn "falscherwahl" oder "langeweile" → zeige alternative Wege. Wenn "theorie" → empfehle praxisnahe Alternativen oder duales Studium. Behalte was gut ist, ändere was nicht passt!` : ''}
- **NOTEN HAUPTFÄCHER: Deutsch: ${formData.note_deutsch || 'k.A.'} | Mathe: ${formData.note_mathe || 'k.A.'} | Englisch: ${formData.note_englisch || 'k.A.'}**
- **RESTLICHE NOTEN: Überwiegend ${formData.noten_rest || 'k.A.'}**
- **PRAKTIKUM GESUCHT: ${formData.praktikum === 'ja' ? 'JA – Praktikumsblock für ALLE 3 Karrierewege einbauen!' : 'Nein – kein Praktikumsblock nötig'}**

**🎓 BILDUNGS-FILTER – STRIKT EINHALTEN! DIE TOP 3 MÜSSEN DIESE MISCHUNG HABEN:**

${formData.education === 'abitur' ? `
**ABITUR → TOP 3 MÜSSEN SEIN:**
→ Karriereweg 1: Universitätsstudium (z.B. BWL, Informatik, Psychologie, Medizin, Jura)
→ Karriereweg 2: Universitäts- ODER FH-Studium (zweiter Studiengang oder duales Studium)
→ Karriereweg 3: Ausbildung ODER FH-Studium als Alternative
REGEL: MINDESTENS 2 von 3 müssen Studiengänge sein! NC angeben, BAföG erwähnen. DU kannst an ALLEN Universitäten und Fachhochschulen studieren!
` : ''}

${formData.education === 'fachabitur' ? `
**FACHABITUR → TOP 3 MÜSSEN SEIN:**
→ Karriereweg 1: FH-Studiengang (Fachhochschule – KEINE Uni!)
→ Karriereweg 2: Duales Studium an FH ODER zweiter FH-Studiengang
→ Karriereweg 3: Ausbildung
REGEL: MINDESTENS 2 von 3 müssen FH-Studiengänge sein! NIEMALS "Universität" vorschlagen – nur "Fachhochschule" oder "FH"! Immer "Mit Fachabitur an FH möglich" erwähnen. NC für FH angeben.
` : ''}

${formData.education === 'realschule' || formData.education === 'realschule_ziel' || formData.education === 'hauptschule_ziel' ? `
**REALSCHULABSCHLUSS → TOP 3 MÜSSEN SEIN:**
→ Karriereweg 1: Ausbildung (passend zu Interessen)
→ Karriereweg 2: Ausbildung (andere Richtung)
→ Karriereweg 3: Ausbildung mit Hinweis auf Weiterbildungsweg (z.B. Meister, Techniker, oder danach Fachabitur nachholen)
REGEL: ALLE 3 müssen Ausbildungen sein! Studium NUR als langfristiger Weg über 2. Bildungsweg erklären. Kein direktes Studium möglich!
` : ''}

${formData.education === 'hauptschule' ? `
**HAUPTSCHULABSCHLUSS → TOP 3 MÜSSEN SEIN:**
→ Karriereweg 1: Ausbildung
→ Karriereweg 2: Ausbildung
→ Karriereweg 3: Ausbildung mit Aufstiegsweg (Meister/Techniker)
REGEL: ALLE 3 müssen Ausbildungen sein! Weiterbildungswege aufzeigen.
` : ''}

${(formData.education === 'school' || formData.situation === 'school') && (formData.schul_situation === 'klasse5_10' || formData.education === 'hauptschule_ziel' || formData.education === 'realschule_ziel') ? `
**SCHÜLER KLASSE 5-10 → TOP 3 MÜSSEN SEIN:**
→ Karriereweg 1: Ausbildung (nach Realschulabschluss möglich)
→ Karriereweg 2: Ausbildung (andere Richtung)
→ Karriereweg 3: Ausbildung mit Aufstiegsweg
REGEL: Alle 3 als Ausbildungen! Schulisches Ziel berücksichtigen.
` : ''}

${(formData.education === 'school' || formData.situation === 'school') && (formData.schul_situation === 'oberstufe' || formData.education === 'fachabitur_ziel' || formData.education === 'abitur_ziel') ? `
**SCHÜLER OBERSTUFE (strebt Fach-/Abitur an) → TOP 3 MÜSSEN SEIN:**
→ Karriereweg 1: Studiengang passend zum angestrebten Abschluss
→ Karriereweg 2: Duales Studium ODER zweiter Studiengang
→ Karriereweg 3: Ausbildung als Alternative
REGEL: MINDESTENS 2 von 3 Studiengänge! Bei Fachabitur-Ziel nur FH, bei Abitur-Ziel Uni oder FH.
` : ''}

${formData.education === 'bachelor' || formData.education === 'master' ? `
**BEREITS STUDIERT → TOP 3 MÜSSEN SEIN:**
→ Alle 3: Jobs/Karrierewege die den vorhandenen Abschluss nutzen oder darauf aufbauen
REGEL: Fokus auf Berufsfelder, Karrierewechsel, Master/MBA wenn sinnvoll.
` : ''}

**📊 NOTEN-FILTER (STRIKT BEACHTEN!):**

Basierend auf den Noten/Punkten MUSST DU die Karriereempfehlungen realistisch filtern:

- **Hauptfächer Note 1-2 / Punkte 13-15:** Alle Karrierewege empfehlbar – auch hoch kompetitive wie Medizin, Informatik, Bank, Versicherung, Jura
- **Hauptfächer Note 3 / Punkte 10-12:** Mittlere Wettbewerbsfähigkeit – IT-Ausbildung möglich aber schwieriger, Studium realistisch mit NC-Hinweis
- **Hauptfächer Note 4-5 / Punkte 5-9:** Kompetitive Ausbildungen (IT, Bank, Versicherung, Medizin) sind UNREALISTISCH → empfehle stattdessen: Handwerk, Lager, Produktion, Gastronomie, Pflege, Einzelhandel + zeige Verbesserungswege
- **Hauptfächer Note 6 / Punkte 0-4:** Nur einfache Ausbildungsberufe + Empfehlung für Nachhilfe/Förderung

**Sei EHRLICH aber ERMUTIGEND!** Zeige immer auch den Weg zur Verbesserung!

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
   - Ausbildungsvergütung:
     * 1. Jahr: ca. XXX €
     * 2. Jahr: ca. XXX €
     * 3. Jahr: ca. XXX €
   - Einstiegsgehalt nach Abschluss
   - Gehalt nach 3-5 Jahren
   
   WENN STUDIUM:
   - Finanzierung: BAföG (bis zu 934 €) oder Nebenjob (ca. 500-800 €)
   - Einstiegsgehalt nach Bachelor (z.B. "45.000-55.000 €/Jahr")
   - Gehalt nach 3-5 Jahren
   - Mit Master: Wie viel mehr? (z.B. "+10.000 €/Jahr")
   
   **Karriere-Turbo:**
   - WENN AUSBILDUNG: Meister, Techniker, Fachwirt → Gehaltssprung angeben!
   - WENN STUDIUM: Master, MBA, Promotion → Gehaltssprung angeben!
   - Konkrete Zahlen nennen (z.B. "von 3.500 € auf 5.000 €")
   
   **Warum dieser Beruf zu DIR passt:**
   - Konkrete Bezüge zu Stärken und Interessen
   - Warum ist es genau das Richtige für DICH?

   **📋 STECKBRIEF – Was auf DICH zukommt:**
   Für JEDEN der Top 3 Karrierewege MUSST DU einen kompakten Steckbrief erstellen – passend zum jeweiligen Typ (Quereinsteiger, Ausbildung, FH, Uni):
   
   Nutze dieses Format innerhalb jedes <div class="career-path-card">:
   
   <h4>📋 Steckbrief – Was auf DICH zukommt</h4>
   <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
   
     WENN AUSBILDUNG:
     <p><strong>🏫 Lernorte:</strong> [Berufsschule (X Tage/Woche) + Ausbildungsbetrieb (X Tage/Woche)]</p>
     <p><strong>📚 Fächer / Lerninhalte:</strong> [Konkrete Fächer & Themen, z.B. "Rechnungswesen, Wirtschaftslehre, Deutsch, EDV, fachspezifische Praxis"]</p>
     <p><strong>📝 Prüfungen:</strong> [z.B. "Zwischenprüfung nach Jahr 1, Abschlussprüfung (schriftlich + praktisch) am Ende"]</p>
     <p><strong>📄 Bewerbung:</strong> [Was braucht man? z.B. "Lebenslauf, Anschreiben, letztes Zeugnis – Bewerbung direkt beim Betrieb"]</p>
     <p><strong>⏰ Typischer Alltag:</strong> [z.B. "3 Tage Betrieb, 2 Tage Berufsschule – abwechslungsreich, viel Praxis von Anfang an"]</p>
     <p><strong>💪 Was DICH erwartet:</strong> [Ehrliche Einschätzung: Was ist anspruchsvoll, was macht Spaß, worauf sollte man sich einstellen]</p>
     <p><strong>✅ Voraussetzungen:</strong> [Welcher Schulabschluss, Stärken, ggf. Eignungstest oder Auswahlverfahren]</p>
   
     WENN STUDIUM (FH oder Uni):
     <p><strong>🏛️ Studienform:</strong> [Präsenz / Online / Dual – und was das im Alltag bedeutet]</p>
     <p><strong>📚 Hauptfächer & Module:</strong> [Konkrete Fächer, z.B. "Analysis, Lineare Algebra, Programmierung, Algorithmen, Datenbanken, Softwaretechnik, Projektmanagement"]</p>
     <p><strong>📝 Prüfungen & Abschluss:</strong> [z.B. "Klausuren pro Semester, Hausarbeiten, Bachelorarbeit am Ende (ca. 3 Monate)"]</p>
     <p><strong>📄 Bewerbung:</strong> [Was braucht man? z.B. "Abitur/Fachabitur, Online-Bewerbung über Hochschulportal, ggf. Motivationsschreiben oder Eignungstest"]</p>
     <p><strong>⏰ Typischer Alltag:</strong> [z.B. "Vorlesungen morgens, Selbststudium nachmittags, Gruppenarbeiten, Lernphasen vor Prüfungen – viel Eigenorganisation nötig"]</p>
     <p><strong>💪 Was DICH erwartet:</strong> [Ehrliche Einschätzung: Was ist anspruchsvoll (z.B. Mathe-Anteil), was macht Spaß, Workload pro Woche]</p>
     <p><strong>✅ Voraussetzungen:</strong> [Abitur oder Fachabitur, NC, ggf. Vorpraktikum oder Eignungstest]</p>
   
     WENN QUEREINSTEIGER:
     <p><strong>🔄 Einstiegsweg:</strong> [Wie kommt man ohne klassische Ausbildung rein? z.B. "Über Praktikum, Trainee-Programm, Umschulung oder Zertifikatskurse"]</p>
     <p><strong>📚 Was man lernen muss:</strong> [Konkrete Skills & Kenntnisse, die man sich aneignen sollte, z.B. "Grundlagen Programmierung, Datenbankwissen, agile Methoden"]</p>
     <p><strong>📝 Nachweise / Zertifikate:</strong> [Welche Zertifikate oder Kurse helfen beim Einstieg, z.B. "Google IT Certificate, IHK-Zertifikat, Udemy-Kurs XY"]</p>
     <p><strong>📄 Bewerbung als Quereinsteiger:</strong> [Tipps: z.B. "Portfolio statt Zeugnisse, GitHub-Profil zeigen, auf Transferkompetenzen aus altem Beruf hinweisen"]</p>
     <p><strong>⏰ Typischer Einstieg:</strong> [z.B. "6-12 Monate Selbststudium + Zertifikate → Bewerbung als Junior → in 2-3 Jahren Mid-Level"]</p>
     <p><strong>💪 Was DICH erwartet:</strong> [Ehrliche Einschätzung: Wie schwer ist der Quereinstieg wirklich, was sind typische Hürden, wie lange dauert es]</p>
     <p><strong>✅ Voraussetzungen:</strong> [Was hilft beim Quereinstieg, z.B. "Erste Programmierkenntnisse, Eigenprojekte, Motivation zeigen"]</p>
   
   </div>
   
   **🔮 Zukunftsprognose & Jobmarkt-Trend:**
   Für JEDEN der Top 3 Karrierewege MUSST DU folgende Zukunftsanalyse liefern – egal ob es sich um einen Beruf, eine Ausbildung, ein Studium, ein duales Studium oder eine Weiterbildung handelt!
   
   Nutze dieses Format innerhalb jedes <div class="career-path-card">:
   
   <h4>🔮 Zukunft & Jobmarkt-Trend</h4>
   <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
     <p><strong>📈 Zukunftssicherheit:</strong> [Gilt für Ausbildung, Studium UND Beruf! z.B. "🟢 SEHR SICHER – Absolventen dieser Ausbildung/dieses Studiengangs sind bis 2035 stark gefragt" ODER "🟡 SICHER – Studiengang zukunftsfähig, aber Spezialisierung empfohlen"]</p>
     <p><strong>🌍 Branchentrend:</strong> [Wie entwickelt sich die Branche, in der dieser Ausbildungsberuf / Studiengang / Job eingesetzt wird? z.B. "Wachstumsbranche +20% bis 2030 – besonders in IT, Gesundheit und Green Energy"]</p>
     <p><strong>🤖 KI & Automatisierungs-Einfluss:</strong> [Konkret: Wird die Ausbildung / der Studiengang / der Beruf durch KI bedroht, verändert oder gestärkt? z.B. "Teile der Ausbildung werden digitaler, aber handwerkliche/soziale Kernkompetenzen bleiben unersetzlich" ODER "Informatik-Absolventen profitieren massiv von KI – sie werden die KI-Tools bauen und einsetzen"]</p>
     <p><strong>🏆 Sektoren mit größtem Bedarf:</strong> [Wo werden Absolventen dieser Ausbildung / dieses Studiengangs am meisten gesucht? z.B. "Industrie, Maschinenbau, Automotive – besonders in Bayern und NRW hoher Bedarf"]</p>
     <p><strong>📊 Arbeitsmarkt-Fakten:</strong> [Konkrete Zahlen wenn möglich, z.B. "Derzeit 150.000 offene Stellen in Deutschland" ODER "Arbeitslosenquote in diesem Bereich unter 2%" ODER "Einer der Top 10 gefragtesten Studiengänge laut Arbeitsagentur"]</p>
     <p><strong>💡 Zukunfts-Tipp:</strong> [Was sollte man während der Ausbildung / des Studiums ZUSÄTZLICH lernen, um noch gefragter zu sein? z.B. "Ergänze DEINE Ausbildung mit einem KI-Zertifikat oder lerne Englisch auf C1-Niveau – das verdoppelt DEINE Jobchancen"]</p>
   </div>
   
   Bewertungsskala für Zukunftssicherheit (gilt für Ausbildung, Studium UND Beruf – nutze passende Formulierung):
   - 🟢 SEHR SICHER: Fachkräftemangel, stark wachsende Branche, kaum automatisierbar, hohe Absolventennachfrage
   - 🟡 SICHER: Stabile Nachfrage, leichte Veränderungen durch Digitalisierung, Studiengang/Ausbildung bleibt relevant
   - 🟠 MITTEL: Branche im Wandel, Anpassung und Spezialisierung nötig, Teilautomatisierung möglich
   - 🔴 RISIKO: Starke Automatisierungsgefahr, schrumpfende Branche oder sinkende Absolventennachfrage (ehrlich kommunizieren!)

**NACH DEN TOP 3 KARRIEREWEGEN KOMMEN DIE WEITEREN SEKTIONEN**

${formData.education === 'abitur' || formData.education === 'fachabitur' || formData.education === 'school' ? `
4. **UNI/HOCHSCHUL-EMPFEHLUNGEN**
   - ${formData.education === 'fachabitur' ? '3-5 konkrete FACHHOCHSCHULEN in Deutschland (KEINE Unis!)' : '3-5 konkrete Unis/FHs in Deutschland für DEINE Studiengänge'}
   - NC-Anforderungen (z.B. "FH Münster: NC ca. 2,5 | FH Köln: NC ca. 2,8")
   - ${formData.education === 'fachabitur' ? 'Erwähne explizit: Mit Fachabitur an FH studieren' : 'Alternative Wege wenn NC nicht reicht (Wartesemester, Auswahlverfahren, private FHs)'}
   - Duale Hochschulen in DEINER Nähe
` : ''}

5. **WEITERBILDUNGS-TIPPS**
   
   🚨 WICHTIG: Diese Sektion MUSS spezifisch auf die 3 empfohlenen Karrierewege zugeschnitten sein!
   NICHT generisch! Wenn DU z.B. Fachinformatiker, Mechatroniker und Kaufmann empfohlen hast,
   gibst DU nur Tipps für genau diese 3 Berufe – KEINE allgemeinen Kurse!
   
   <div class="section-container">
     <h3>📚 Weiterbildungs-Tipps für DEINE Karrierewege</h3>
     
     <h4>[Karriereweg 1 – exakter Berufsname]:</h4>
     <ul>
       <li><strong>Kostenlos:</strong> [Konkrete Kurse/Kanäle NUR für diesen Beruf]</li>
       <li><strong>Udemy:</strong> [Konkrete Kurse NUR für diesen Beruf mit Preis]</li>
       <li><strong>Zertifikat:</strong> [1 konkretes Zertifikat direkt für diesen Beruf]</li>
     </ul>
     
     <h4>[Karriereweg 2 – exakter Berufsname]:</h4>
     <ul>
       <li><strong>Kostenlos:</strong> [Konkrete Kurse/Kanäle NUR für diesen Beruf]</li>
       <li><strong>Udemy/LinkedIn Learning:</strong> [Konkrete Kurse NUR für diesen Beruf]</li>
       <li><strong>Zertifikat:</strong> [1 konkretes Zertifikat direkt für diesen Beruf]</li>
     </ul>
     
     <h4>[Karriereweg 3 – exakter Berufsname]:</h4>
     <ul>
       <li><strong>Kostenlos:</strong> [Konkrete Kurse/Kanäle NUR für diesen Beruf]</li>
       <li><strong>Udemy/LinkedIn Learning:</strong> [Konkrete Kurse NUR für diesen Beruf]</li>
       <li><strong>Zertifikat:</strong> [1 konkretes Zertifikat direkt für diesen Beruf]</li>
     </ul>
   </div>

6. **KONKRETE NÄCHSTE SCHRITTE**
   
   Nutze <div class="section-container"> für diese Sektion:
   
   <div class="section-container">
     <h3>🎯 DEINE nächsten Schritte</h3>
     
     <div class="step-item">
       <span class="step-number">1</span>
       <div class="step-content">
         <strong>Sofort (heute noch):</strong> [KONKRET auf Karriereweg 1 + Standort zugeschnitten: z.B. "Geh auf ausbildung.de und suche '[Berufsname]' in [Standort] – speichere 3-5 Betriebe" – NICHT generisch!]
       </div>
     </div>
     
     <div class="step-item">
       <span class="step-number">2</span>
       <div class="step-content">
         <strong>Diese Woche:</strong> [KONKRET: z.B. "Schreibe [konkrete Firma aus Region/Branche] direkt an und frage nach Schnupperpraktikum – eine E-Mail reicht!" – NICHT generisch!]
       </div>
     </div>
     
     <div class="step-item">
       <span class="step-number">3</span>
       <div class="step-content">
         <strong>Nächster Monat:</strong> [KONKRET: z.B. "Erstelle DEINEN Lebenslauf auf canva.com (kostenlos) und schreibe DEIN erstes Anschreiben für [Karriereweg 1]" – NICHT generisch!]
       </div>
     </div>
     
     <div class="step-item">
       <span class="step-number">4</span>
       <div class="step-content">
         <strong>In 3-6 Monaten:</strong> [KONKRET: z.B. "Bewerbungsfristen für Ausbildung laufen meist Oktober–Januar – bis dahin 5-10 Bewerbungen rausschicken. Für Studium: NC-Check auf hochschulstart.de" – NICHT generisch!]
       </div>
     </div>
     
     <div class="step-item">
       <span class="step-number">5</span>
       <div class="step-content">
         <strong>Langfristig:</strong> [KONKRET: z.B. "Nach DEINEM Abschluss als [Karriereweg 1]: Weiterbildung zum [Karriere-Turbo aus oben] = +[X]€ Gehalt/Monat" – NICHT generisch!]
       </div>
     </div>
   </div>

**WICHTIG: ALLE SEKTIONEN IN EIGENE CONTAINER!**
- Top 3 Karrierewege: Jeweils <div class="career-path-card">
- Alternative Karrierewege: <div class="section-container">
- Weiterbildungs-Tipps: <div class="section-container">
- Nächste Schritte: <div class="section-container">
- Uni-Empfehlungen: <div class="section-container"> (falls relevant)

**FORMATIERUNG:**
- Nutze <div class="career-path-card"> für JEDEN Karriereweg
- Nutze <div class="badge-container"> für Badges am Anfang
- Nutze <div class="info-box"> für wichtige Infos
- Nutze <div class="success-box"> für Karriere-Turbo
- Nutze <table class="salary-table"> für Ausbildungsvergütung/Gehälter!
- Strukturiere mit <h3> und <h4>
- Nutze <div class="step-item"> für Schritte
- Sprich IMMER mit "DU"!

**BEISPIEL-STRUKTUR FÜR AUSBILDUNG:**

<div class="career-path-card">
  <h3>🔧 [Berufsbezeichnung]</h3>
  
  <div class="badge-container">
    <span class="career-badge duration-badge">3 Jahre</span>
    <span class="career-badge education-badge">Realschulabschluss</span>
  </div>
  
  <h4>Der Weg dorthin:</h4>
  <div class="info-box">
    [Beschreibung der Ausbildung]
  </div>
  
  <h4>Die harten Fakten:</h4>
  <table class="salary-table">
    <tr>
      <th>Ausbildungsjahr</th>
      <th>Vergütung</th>
    </tr>
    <tr>
      <td>1. Lehrjahr</td>
      <td>ca. 850 €</td>
    </tr>
    <tr>
      <td>2. Lehrjahr</td>
      <td>ca. 950 €</td>
    </tr>
    <tr>
      <td>3. Lehrjahr</td>
      <td>ca. 1.100 €</td>
    </tr>
    <tr class="highlight-row">
      <td>Einstiegsgehalt</td>
      <td>2.800-3.200 €</td>
    </tr>
    <tr class="highlight-row">
      <td>Nach 5 Jahren</td>
      <td>3.500-4.000 €</td>
    </tr>
  </table>
  
  <h4>💪 Karriere-Turbo:</h4>
  <p><strong>Weiterbildung:</strong> [Z.B. Meister, Techniker]</p>
  <p><strong>Gehaltssprung:</strong> [Z.B. von 3.500 € auf 5.000 €]</p>
  <p><strong>Dauer:</strong> [Z.B. 2 Jahre berufsbegleitend]</p>
  
  <h4>📍 Freie Stellen ${formData.location === 'Deutschlandweit' ? 'deutschlandweit' : `in ${formData.location}`}:</h4>
  <div class="job-search-buttons">
    ${formData.location === 'Deutschlandweit' ? `
    <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+ausbildung&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">
      🔍 Deutschlandweite Ausbildungsplätze
    </a>
    <a href="https://www.ausbildung.de/suche?what=[BERUFSBEZEICHNUNG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">
      📋 Auf Ausbildung.de suchen
    </a>
    <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]+ausbildung" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">
      💼 Auf Indeed suchen
    </a>
    ` : `
    <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+ausbildung+${encodeURIComponent(formData.location)}&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">
      🔍 Ausbildungsplätze finden
    </a>
    <a href="https://www.ausbildung.de/suche?what=[BERUFSBEZEICHNUNG]&where=${encodeURIComponent(formData.location)}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">
      📋 Auf Ausbildung.de suchen
    </a>
    <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]+ausbildung&l=${encodeURIComponent(formData.location)}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">
      💼 Auf Indeed suchen
    </a>
    `}
  </div>
  
  <h4>📋 Steckbrief – Was auf DICH zukommt:</h4>
  <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
    <p><strong>🏫 Lernorte & Aufteilung:</strong> [Genau beschreiben: Wie viele Tage Betrieb, wie viele Tage Berufsschule – z.B. "3 Tage Betrieb + 2 Tage Berufsschule" oder "Blockunterricht: 6 Wochen Betrieb, dann 2 Wochen Schule"]</p>
    <p><strong>📚 Fächer in der Berufsschule:</strong> [MINDESTENS 10-12 konkrete Fächer aufzählen die in diesem Beruf unterrichtet werden – allgemeine Fächer UND berufsspezifische Fächer vollständig nennen]</p>
    <p><strong>🔧 Praxis im Ausbildungsbetrieb:</strong> [Konkret beschreiben was man im Betrieb macht, welche Aufgaben man übernimmt, welche Tools/Maschinen/Software man lernt, wie die Einarbeitung läuft]</p>
    <p><strong>📅 Was passiert in welchem Ausbildungsjahr:</strong> [1. Jahr: Was lernt man? 2. Jahr: Was kommt dazu? 3. Jahr: Spezialisierung + Prüfungsvorbereitung – konkret beschreiben]</p>
    <p><strong>📝 Prüfungen im Detail:</strong> [Zwischenprüfung: wann, wie, was wird geprüft – Abschlussprüfung: schriftlicher Teil (Fächer, Dauer), praktischer Teil (Aufgaben, Dauer) – alles konkret erklären]</p>
    <p><strong>📄 Bewerbung – vollständige Checkliste:</strong> [Alle Unterlagen: Lebenslauf, Anschreiben, Zeugnisse der letzten 2 Jahre, ggf. Portfolio/Arbeitsproben – Wo bewerben (Online/Post/direkt), wann Bewerbungsstart, typische Auswahlverfahren wie Tests oder Vorstellungsgespräche]</p>
    <p><strong>⏰ Ein typischer Ausbildungstag:</strong> [Konkreten Beispieltag von morgens bis abends beschreiben – wann beginnt die Arbeit, was macht man vormittags/nachmittags, wie ist der Feierabend]</p>
    <p><strong>💪 Was wirklich auf DICH zukommt:</strong> [Sehr ehrliche & detaillierte Einschätzung: Was ist besonders fordernd, was macht am meisten Spaß, was überrascht viele Azubis, typische Herausforderungen im 1. Jahr, wie ist das Arbeitsklima]</p>
    <p><strong>✅ Voraussetzungen & Bewerbungstipps:</strong> [Welcher Schulabschluss mindestens nötig, welche Schulnoten wichtig sind, welche Hobbys oder Vorerfahrungen helfen, konkrete Tipps um die Bewerbungschancen zu erhöhen]</p>
    <p><strong>🎓 Das kannst DU danach:</strong> [Welche konkreten Fähigkeiten, Kenntnisse und Zertifikate hat man nach der Ausbildung – was kann man sofort im Job einsetzen, welche Türen öffnen sich]</p>
  </div>

  <h4>🔮 Zukunft & Jobmarkt-Trend</h4>
  <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
    <p><strong>📈 Zukunftssicherheit:</strong> [z.B. "🟢 SEHR SICHER – Absolventen sind bis 2035 stark gefragt" ODER "🟡 SICHER – zukunftsfähig, aber Spezialisierung empfohlen"]</p>
    <p><strong>🌍 Branchentrend:</strong> [Wie entwickelt sich die Branche? z.B. "Wachstumsbranche +20% bis 2030 – besonders in IT, Gesundheit und Green Energy"]</p>
    <p><strong>🤖 KI & Automatisierungs-Einfluss:</strong> [Wird die Ausbildung / der Studiengang / der Beruf durch KI bedroht, verändert oder gestärkt?]</p>
    <p><strong>🏆 Sektoren mit größtem Bedarf:</strong> [Wo werden Absolventen am meisten gesucht?]</p>
    <p><strong>📊 Arbeitsmarkt-Fakten:</strong> [Konkrete Zahlen, z.B. "Derzeit 150.000 offene Stellen" ODER "Arbeitslosenquote unter 2%"]</p>
    <p><strong>💡 Zukunfts-Tipp:</strong> [Was zusätzlich lernen um noch gefragter zu sein?]</p>
  </div>
  
  Bewertungsskala:
  🟢 SEHR SICHER | 🟡 SICHER | 🟠 MITTEL | 🔴 RISIKO
  

  <h4>🎯 Warum dieser Weg zu DIR passt:</h4>
  <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
    <p>[Konkrete Begründung warum GENAU dieser Beruf / diese Ausbildung / dieses Studium zur Person passt – mit direktem Bezug auf die angegebenen Stärken, Flow-Aktivitäten, Interessen und Prioritäten aus dem Fragebogen. Erkläre was die Person in diesem Beruf jeden Tag tun wird und warum das zu ihr passt.]</p>
  </div>

  <h4>🔀 3 ähnliche Alternativen die ebenfalls passen könnten:</h4>
  <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
    <p><strong>Alternative 1:</strong> [Berufsbezeichnung / Studiengang / Ausbildung] – [1-2 Sätze warum das eine gute Alternative ist und was der Unterschied ist]</p>
    <p><strong>Alternative 2:</strong> [Berufsbezeichnung / Studiengang / Ausbildung] – [1-2 Sätze warum das eine gute Alternative ist und was der Unterschied ist]</p>
    <p><strong>Alternative 3:</strong> [Berufsbezeichnung / Studiengang / Ausbildung] – [1-2 Sätze warum das eine gute Alternative ist und was der Unterschied ist]</p>
  </div>
</div>

**FÜR BERUFSTÄTIGE / JOBWECHSLER:**
Wenn Situation = "Berufstätig (will mich umorientieren)" oder "Arbeitslos/Arbeitssuchend" ODER education = "ausbildung", "bachelor", "master":
→ Zeige NORMALE JOBS, nicht Ausbildungen!
→ Job-Such-Buttons ohne "ausbildung" im Link:

<h4>📍 Freie Stellen ${formData.location === 'Deutschlandweit' ? 'deutschlandweit' : `in ${formData.location}`}:</h4>
<div class="job-search-buttons">
  ${formData.location === 'Deutschlandweit' ? `
  <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">
    🔍 Deutschlandweite Jobs
  </a>
  <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">
    💼 Auf Indeed suchen
  </a>
  <a href="https://www.stepstone.de/jobs/[BERUFSBEZEICHNUNG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">
    📋 Auf StepStone suchen
  </a>
  ` : `
  <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+${encodeURIComponent(formData.location)}&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">
    🔍 Jobs auf Google finden
  </a>
  <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]&l=${encodeURIComponent(formData.location)}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">
    💼 Auf Indeed suchen
  </a>
  <a href="https://www.stepstone.de/jobs/[BERUFSBEZEICHNUNG]/in-${encodeURIComponent(formData.location)}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">
    📋 Auf StepStone suchen
  </a>
  `}
</div>

**WICHTIG BEI DEN LINKS:**
- Ersetze [BERUFSBEZEICHNUNG] mit dem EXAKTEN Berufsnamen (z.B. "Industriekaufmann", "Software-Entwickler")
- Die Stadt ist bereits eingefügt: ${formData.location}
- Links öffnen sich in neuem Tab (target="_blank")
- Buttons sind styled und sehen professionell aus

**BEISPIEL-STRUKTUR FÜR STUDIUM:**

<div class="career-path-card">
  <h3>🎓 [Studiengang (B.Sc.)]</h3>
  
  <div class="badge-container">
    <span class="career-badge duration-badge">6 Semester</span>
    <span class="career-badge education-badge">Abitur</span>
    <span class="career-badge">NC 2,0-3,0</span>
  </div>
  
  <h4>Der Weg dorthin:</h4>
  <div class="info-box">
    [Beschreibung des Studiums]
  </div>
  
  <h4>Die harten Fakten:</h4>
  <table class="salary-table">
    <tr>
      <th>Phase</th>
      <th>Einkommen/Gehalt</th>
    </tr>
    <tr>
      <td>Finanzierung während Studium</td>
      <td>BAföG bis 934 € ODER Nebenjob 500-800 €</td>
    </tr>
    <tr class="highlight-row">
      <td>Einstiegsgehalt (Bachelor)</td>
      <td>45.000-55.000 €/Jahr</td>
    </tr>
    <tr class="highlight-row">
      <td>Nach 3-5 Jahren</td>
      <td>60.000-75.000 €/Jahr</td>
    </tr>
    <tr>
      <td>Mit Master (+2 Jahre)</td>
      <td>55.000-65.000 €/Jahr Einstieg</td>
    </tr>
  </table>
  
  <h4>💪 Karriere-Turbo:</h4>
  <p><strong>Weiterbildung:</strong> Master, MBA, Promotion</p>
  <p><strong>Gehaltssprung:</strong> [Z.B. +10.000-15.000 €/Jahr]</p>
  <p><strong>Dauer:</strong> [Z.B. 2 Jahre Master]</p>
  
  <h4>📍 Studiengänge finden ${formData.location === 'Deutschlandweit' ? 'deutschlandweit' : `in ${formData.location}`}:</h4>
  <div class="job-search-buttons">
    ${formData.location === 'Deutschlandweit' ? `
    <a href="https://www.hochschulkompass.de/studium/studiengangsuche/erweiterte-studiengangsuche.html?tx_szhrksearch_pi1%5Bsearch%5D=1&tx_szhrksearch_pi1%5BQUICK%5D=1&tx_szhrksearch_pi1%5Bstudtyp%5D=3&tx_szhrksearch_pi1%5Bfach%5D=[STUDIENGANG]" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">
      🎓 Hochschulkompass
    </a>
    <a href="https://www.studycheck.de/suche?q=[STUDIENGANG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">
      📚 StudyCheck
    </a>
    <a href="https://www.wegweiser-duales-studium.de/suche/?q=[STUDIENGANG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">
      💼 Duales Studium finden
    </a>
    ` : `
    <a href="https://www.hochschulkompass.de/studium/studiengangsuche/erweiterte-studiengangsuche.html?tx_szhrksearch_pi1%5Bsearch%5D=1&tx_szhrksearch_pi1%5BQUICK%5D=1&tx_szhrksearch_pi1%5Bstudtyp%5D=3&tx_szhrksearch_pi1%5Bfach%5D=[STUDIENGANG]&tx_szhrksearch_pi1%5Bort%5D=${encodeURIComponent(formData.location)}" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">
      🎓 Hochschulkompass
    </a>
    <a href="https://www.studycheck.de/suche?q=[STUDIENGANG]&location=${encodeURIComponent(formData.location)}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">
      📚 StudyCheck
    </a>
    <a href="https://www.wegweiser-duales-studium.de/suche/?q=[STUDIENGANG]+${encodeURIComponent(formData.location)}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">
      💼 Duales Studium finden
    </a>
    `}
  </div>
  
  <h4>📋 Steckbrief – Was auf DICH zukommt:</h4>
  <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
    <p><strong>🏛️ Studienform & Aufbau:</strong> [Präsenz / Dual / Online – was bedeutet das konkret im Alltag? Wie viele Semester, wie ist das Studium aufgebaut: Grundstudium, Hauptstudium, Praxissemester, Bachelorarbeit]</p>
    <p><strong>📚 Pflichtfächer im Grundstudium (1.-2. Semester):</strong> [MINDESTENS 8-10 konkrete Fächer nennen die in den ersten Semestern Pflicht sind – studiengangspezifisch und vollständig]</p>
    <p><strong>📚 Fächer im Hauptstudium (3.-5. Semester):</strong> [MINDESTENS 8-10 weitere konkrete Fächer nennen – Vertiefungen, Seminare, Projekte]</p>
    <p><strong>🎯 Spezialisierungen & Wahlpflichtfächer:</strong> [Welche Vertiefungsrichtungen gibt es? Ab wann kann man wählen, welche Richtungen sind besonders gefragt]</p>
    <p><strong>📅 Semesterplan – Was passiert wann:</strong> [Für jedes Semester kurz beschreiben was der Schwerpunkt ist, wann Praxissemester oder Auslandsaufenthalt möglich ist, wann die Bachelorarbeit beginnt]</p>
    <p><strong>📝 Prüfungen im Detail:</strong> [Wie viele Klausuren pro Semester, welche Fächer haben Hausarbeiten oder Referate, wie läuft die Bachelorarbeit ab: Thema, Länge, Bearbeitungszeit, Kolloquium]</p>
    <p><strong>📄 Bewerbung – vollständige Checkliste:</strong> [Alle Unterlagen: Abitur/Fachabitur, NC-Grenze konkret, wo und wie bewerben (Hochschulstart, direkt, Dialogorientiertes Serviceverfahren), Bewerbungsfristen, ggf. Motivationsschreiben oder Eignungstest oder Vorpraktikum]</p>
    <p><strong>⏰ Eine typische Studienwoche:</strong> [Konkreten Wochenablauf beschreiben – wie viele Stunden Vorlesungen, wie viel Selbststudium, Gruppenarbeiten, typische Lernphasen vor Prüfungen]</p>
    <p><strong>💪 Was wirklich auf DICH zukommt:</strong> [Sehr ehrliche & detaillierte Einschätzung: Welche Fächer sind besonders schwer, wie hoch ist der wöchentliche Workload, was überrascht viele Erstsemester, typische Hürden im Studium]</p>
    <p><strong>✅ Voraussetzungen & Tipps:</strong> [Welche Vorkenntnisse helfen, welche Stärken braucht man wirklich, konkrete Tipps für die Bewerbung und einen guten Studienstart]</p>
    <p><strong>🎓 Das kannst DU danach:</strong> [Welche konkreten Fähigkeiten, Kenntnisse und Abschlüsse hat man – welche Berufsfelder öffnen sich, was kann man sofort einsetzen]</p>
  </div>

  <h4>🔮 Zukunft & Jobmarkt-Trend</h4>
  <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
    <p><strong>📈 Zukunftssicherheit:</strong> [z.B. "🟢 SEHR SICHER – Absolventen sind bis 2035 stark gefragt" ODER "🟡 SICHER – zukunftsfähig, aber Spezialisierung empfohlen"]</p>
    <p><strong>🌍 Branchentrend:</strong> [Wie entwickelt sich die Branche? z.B. "Wachstumsbranche +20% bis 2030 – besonders in IT, Gesundheit und Green Energy"]</p>
    <p><strong>🤖 KI & Automatisierungs-Einfluss:</strong> [Wird die Ausbildung / der Studiengang / der Beruf durch KI bedroht, verändert oder gestärkt?]</p>
    <p><strong>🏆 Sektoren mit größtem Bedarf:</strong> [Wo werden Absolventen am meisten gesucht?]</p>
    <p><strong>📊 Arbeitsmarkt-Fakten:</strong> [Konkrete Zahlen, z.B. "Derzeit 150.000 offene Stellen" ODER "Arbeitslosenquote unter 2%"]</p>
    <p><strong>💡 Zukunfts-Tipp:</strong> [Was zusätzlich lernen um noch gefragter zu sein?]</p>
  </div>
  
  Bewertungsskala:
  🟢 SEHR SICHER | 🟡 SICHER | 🟠 MITTEL | 🔴 RISIKO
  

  <h4>🎯 Warum dieser Weg zu DIR passt:</h4>
  <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
    <p>[Konkrete Begründung warum GENAU dieser Beruf / diese Ausbildung / dieses Studium zur Person passt – mit direktem Bezug auf die angegebenen Stärken, Flow-Aktivitäten, Interessen und Prioritäten aus dem Fragebogen. Erkläre was die Person in diesem Beruf jeden Tag tun wird und warum das zu ihr passt.]</p>
  </div>

  <h4>🔀 3 ähnliche Alternativen die ebenfalls passen könnten:</h4>
  <div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
    <p><strong>Alternative 1:</strong> [Berufsbezeichnung / Studiengang / Ausbildung] – [1-2 Sätze warum das eine gute Alternative ist und was der Unterschied ist]</p>
    <p><strong>Alternative 2:</strong> [Berufsbezeichnung / Studiengang / Ausbildung] – [1-2 Sätze warum das eine gute Alternative ist und was der Unterschied ist]</p>
    <p><strong>Alternative 3:</strong> [Berufsbezeichnung / Studiengang / Ausbildung] – [1-2 Sätze warum das eine gute Alternative ist und was der Unterschied ist]</p>
  </div>
</div>

**FÜR STUDIERTE / ABSOLVENTEN (Bachelor/Master):**
Wenn education = "bachelor" oder "master":
→ Zeige JOB-ANGEBOTE für Absolventen!

<h4>📍 Jobs für [STUDIENGANG]-Absolventen ${formData.location === 'Deutschlandweit' ? 'deutschlandweit' : `in ${formData.location}`}:</h4>
<div class="job-search-buttons">
  ${formData.location === 'Deutschlandweit' ? `
  <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+jobs&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">
    🔍 Jobs auf Google finden
  </a>
  <a href="https://de.linkedin.com/jobs/search?keywords=[BERUFSBEZEICHNUNG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #0077b5;">
    💼 LinkedIn Jobs
  </a>
  <a href="https://www.stepstone.de/jobs/[BERUFSBEZEICHNUNG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">
    📋 StepStone
  </a>
  ` : `
  <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+${encodeURIComponent(formData.location)}&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">
    🔍 Jobs auf Google finden
  </a>
  <a href="https://de.linkedin.com/jobs/search?keywords=[BERUFSBEZEICHNUNG]&location=${encodeURIComponent(formData.location)}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #0077b5;">
    💼 LinkedIn Jobs
  </a>
  <a href="https://www.stepstone.de/jobs/[BERUFSBEZEICHNUNG]/in-${encodeURIComponent(formData.location)}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">
    📋 StepStone
  </a>
  `}
</div>

**WICHTIG BEI STUDIUM VS. AUSBILDUNG:**
- Bei Abitur/Fachabitur: Studiengänge-Suche Buttons (Hochschulkompass, StudyCheck, Duales Studium)
- Bei Bachelor/Master (fertig studiert): Job-Buttons für Absolventen
- Bei Schüler/Realschule/Hauptschule: Ausbildungsplatz-Buttons

NUTZE DIESE STRUKTUR FÜR ALLE 3 TOP-KARRIEREWEGE!

**🚨 ABSOLUT PFLICHT – GILT FÜR ALLE 3 KARRIEREWEGE OHNE AUSNAHME:**
Jeder einzelne Karriereweg (Karriereweg 1, 2 UND 3) MUSS am Ende diese 3 Blöcke enthalten – auch der letzte!

Block A) 🔮 Zukunft & Jobmarkt-Trend:
<h4>🔮 Zukunft & Jobmarkt-Trend</h4>
<div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
  <p><strong>📈 Zukunftssicherheit:</strong> [🟢/🟡/🟠/🔴 + Begründung]</p>
  <p><strong>🌍 Branchentrend:</strong> [Wie entwickelt sich die Branche bis 2030/2035?]</p>
  <p><strong>🤖 KI & Automatisierungs-Einfluss:</strong> [Bedroht, verändert oder gestärkt durch KI?]</p>
  <p><strong>🏆 Sektoren mit größtem Bedarf:</strong> [Wo wird man am meisten gesucht?]</p>
  <p><strong>📊 Arbeitsmarkt-Fakten:</strong> [Konkrete Zahlen – offene Stellen, Arbeitslosenquote etc.]</p>
  <p><strong>💡 Zukunfts-Tipp:</strong> [Was zusätzlich lernen um noch gefragter zu sein?]</p>
</div>

Block B) 🎯 Warum dieser Weg zu DIR passt:
<h4>🎯 Warum dieser Weg zu DIR passt:</h4>
<div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
  <p>[Konkrete Begründung mit direktem Bezug auf die Stärken, Flow-Aktivitäten, Interessen und Prioritäten der Person]</p>
</div>

Block C) 🔀 3 ähnliche Alternativen:
<h4>🔀 3 ähnliche Alternativen die ebenfalls passen könnten:</h4>
<div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
  <p><strong>Alternative 1:</strong> [Beruf/Studiengang/Ausbildung] – [Kurze Erklärung und Unterschied]</p>
  <p><strong>Alternative 2:</strong> [Beruf/Studiengang/Ausbildung] – [Kurze Erklärung und Unterschied]</p>
  <p><strong>Alternative 3:</strong> [Beruf/Studiengang/Ausbildung] – [Kurze Erklärung und Unterschied]</p>
</div>

❌ NIEMALS einen Karriereweg ohne diese 3 Blöcke abschließen!
✅ Karriereweg 1: Block A + B + C ← PFLICHT
✅ Karriereweg 2: Block A + B + C ← PFLICHT  
✅ Karriereweg 3: Block A + B + C ← PFLICHT (auch der letzte!)

${formData.praktikum === 'ja' ? `
**🎯 PRAKTIKUM GESUCHT – PFLICHTBLOCK FÜR ALLE 3 KARRIEREWEGE:**
Füge in JEDEN der 3 career-path-card Blöcke diesen Block ein, DIREKT VOR den Job-Such-Buttons (vor den ausbildung.de / Indeed / StepStone Buttons):

Füge bei den Job-Such-Buttons (ausbildung.de / Indeed / StepStone / Hochschulkompass) einen ZUSÄTZLICHEN vierten Button hinzu – nur diesen einen extra Praktikums-Button, die anderen Buttons bleiben normal:

  <a href="https://www.praktikum.de/search?q=[BERUFSBEZEICHNUNG]&location=${encodeURIComponent(formData.location || 'Deutschland')}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #f97316;">
    🎯 Praktikum finden
  </a>

✅ Praktikums-Button Karriereweg 1 ← PFLICHT (ersetze [BERUFSBEZEICHNUNG] mit exaktem Berufsnamen!)
✅ Praktikums-Button Karriereweg 2 ← PFLICHT
✅ Praktikums-Button Karriereweg 3 ← PFLICHT
` : ''}

Sei KONKRET und REALISTISCH! Keine schwammigen Aussagen! Berücksichtige STRIKT den Bildungsabschluss!`;

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
            max_tokens: 16000,
        });

        const analysis = completion.choices[0].message.content;

        // Store result
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
        
        // Call OpenAI with context
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Günstiger für Chat!
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
    console.log('🎨 Verbesserter Prompt (DU + Fahrplan)');
    console.log('=================================');
});

module.exports = app;
