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

// Root route
app.get('/', (req, res) => {
    res.send('KI Karriereberater Backend läuft! 🚀');
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

        const prompt = `Du bist ein professioneller Karriere- und Studienberater. Analysiere folgende Informationen und erstelle eine detaillierte, personalisierte Karriereberatung auf Deutsch.

**WICHTIG: Sprich den User DURCHGEHEND mit "DU" an! Keine "Sie"-Form!**

PERSÖNLICHE DATEN:
- Alter: ${formData.age}
- Aktuelle Situation: ${Array.isArray(formData.situation) ? formData.situation.join(', ') : formData.situation}
- **STANDORT: ${formData.location}** ← WICHTIG FÜR JOB-LINKS!
- Flow-Aktivität (Was dir leicht fällt): ${formData.flow_activity}
- Anti-Job (Was du NICHT willst): ${Array.isArray(formData.anti_job) ? formData.anti_job.join(', ') : formData.anti_job}
- Interessen: ${Array.isArray(formData.interests) ? formData.interests.join(', ') : formData.interests}
- Stärken: ${formData.strengths}
- Arbeitsstil: ${Array.isArray(formData.work_style) ? formData.work_style.join(', ') : formData.work_style}
- Digital/Physisch: ${Array.isArray(formData.work_type) ? formData.work_type.join(', ') : formData.work_type}
- Energie-Quellen: ${Array.isArray(formData.energy) ? formData.energy.join(', ') : formData.energy}
- Prioritäten: ${Array.isArray(formData.priority) ? formData.priority.join(', ') : formData.priority}
- Risikobereitschaft: ${Array.isArray(formData.risk) ? formData.risk.join(', ') : formData.risk}
- Routine/Abwechslung: ${Array.isArray(formData.routine) ? formData.routine.join(', ') : formData.routine}
- **BILDUNG: ${formData.education}** ← KRITISCH FÜR EMPFEHLUNGEN!

**🎓 BILDUNGS-FILTER (STRIKT BEACHTEN!):**

${formData.education === 'abitur' ? `
**DU HAST ABITUR (Allgemeine Hochschulreife)** - WICHTIG:
- MINDESTENS 1-2 deiner Top 3 Empfehlungen MÜSSEN Studiengänge (Uni/FH) sein!
- Duales Studium ist eine exzellente Option (Gehalt + Abschluss)
- Ausbildung nur als Alternative, nicht als Hauptempfehlung
- Für Studiengänge: NC angeben, BAföG/Finanzierung erwähnen
- Zeige den akademischen Weg als primäre Option!
- Du kannst an ALLEN Universitäten und Fachhochschulen studieren!
` : ''}

${formData.education === 'fachabitur' ? `
**DU HAST FACHABITUR (Fachhochschulreife)** - WICHTIG:
- Zeige SOWOHL Ausbildungen ALS AUCH FH-Studiengänge!
- Du kannst an FACHHOCHSCHULEN studieren (NICHT an Universitäten!)
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
- Beispiel: "Nach der Ausbildung kannst du dein Fachabitur nachholen und dann studieren"
- Duales Studium ist NICHT direkt möglich (erst nach Ausbildung + Fachabitur)
` : ''}

${formData.education === 'hauptschule' ? `
**DU HAST HAUPTSCHULABSCHLUSS** - WICHTIG:
- Fokus auf Ausbildungsberufe
- Zeige den Weg auf: Ausbildung → Weiterbildung zum Meister/Techniker
- Erwähne: "Mit guten Leistungen in der Ausbildung kannst du später dein Abitur nachholen"
` : ''}

${formData.education === 'school' ? `
**DU BIST NOCH IN DER SCHULE** - WICHTIG:
- Frage dich: Welcher Abschluss wird angestrebt? (Abi, Real, Haupt?)
- Zeige BEIDE Wege: Ausbildung UND Studium
- Erkläre die Unterschiede
` : ''}

${formData.education === 'bachelor' || formData.education === 'master' ? `
**DU HAST SCHON STUDIERT** - WICHTIG:
- Fokus auf Berufe die ein Studium erfordern/bevorzugen
- Karrierewechsel innerhalb akademischer Berufe
- Weiterbildungen auf Master/MBA-Level
` : ''}

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
   - Kurze Zusammenfassung deiner Arbeitsweise und Flow-State
   - Was macht dich einzigartig?

2. **DEINE TOP 3 KARRIEREWEGE**
   
   **WICHTIG: Berücksichtige den Bildungsabschluss strikt!**
   
   **BEISPIELE FÜR PASSENDE EMPFEHLUNGEN:**
   - Interesse "Gesundheit" → Medizin (Staatsexamen), Zahnmedizin, Psychologie
   - Interesse "Recht/Regeln" → Jura (Staatsexamen), Rechtswissenschaften
   - Interesse "Technik" → Maschinenbau, Elektrotechnik, Informatik
   - Interesse "Menschen" → Psychologie, Soziale Arbeit, Lehramt
   - Interesse "Business" → BWL, VWL, Wirtschaftsinformatik
   
   Für JEDEN Beruf MUSST du folgendes liefern:
   
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
   
   **Warum dieser Beruf zu dir passt:**
   - Konkrete Bezüge zu Stärken und Interessen
   - Warum ist es genau das Richtige für DICH?

**NACH DEN TOP 3 KARRIEREWEGEN KOMMEN DIE WEITEREN SEKTIONEN**

${formData.education === 'abitur' || formData.education === 'fachabitur' || formData.education === 'school' ? `
4. **UNI/HOCHSCHUL-EMPFEHLUNGEN**
   - ${formData.education === 'fachabitur' ? '3-5 konkrete FACHHOCHSCHULEN in Deutschland (KEINE Unis!)' : '3-5 konkrete Unis/FHs in Deutschland für deine Studiengänge'}
   - NC-Anforderungen (z.B. "FH Münster: NC ca. 2,5 | FH Köln: NC ca. 2,8")
   - ${formData.education === 'fachabitur' ? 'Erwähne explizit: Mit Fachabitur an FH studieren' : 'Alternative Wege wenn NC nicht reicht (Wartesemester, Auswahlverfahren, private FHs)'}
   - Duale Hochschulen in deiner Nähe
` : ''}

5. **ALTERNATIVE KARRIEREWEGE**
   
   Nutze <div class="section-container"> für diese Sektion:
   
   <div class="section-container">
     <h3>🔀 Alternative Karrierewege</h3>
     
     <h4>1. [Berufsbezeichnung]</h4>
     <p>[Kurze Beschreibung]</p>
     <p><strong>Dauer:</strong> [X Jahre]</p>
     <p><strong>Einstieg:</strong> [Abitur/Realschule/etc.]</p>
     
     <h4>2. [Berufsbezeichnung]</h4>
     <p>[Kurze Beschreibung]</p>
     <p><strong>Dauer:</strong> [X Jahre]</p>
     
     <h4>3. [Berufsbezeichnung]</h4>
     <p>[Kurze Beschreibung]</p>
     <p><strong>Dauer:</strong> [X Jahre]</p>
   </div>

6. **WEITERBILDUNGS-TIPPS**
   
   Nutze <div class="section-container"> für diese Sektion:
   
   <div class="section-container">
     <h3>📚 Weiterbildungs-Tipps</h3>
     
     <h4>Kostenlose Kurse:</h4>
     <ul>
       <li><strong>Coursera:</strong> [Konkrete Kursthemen]</li>
       <li><strong>YouTube:</strong> [Relevante Kanäle]</li>
     </ul>
     
     <h4>Bezahlte Optionen:</h4>
     <ul>
       <li><strong>Udemy:</strong> [Konkrete Kurse, ca. 10-50 €]</li>
       <li><strong>LinkedIn Learning:</strong> [Relevante Themen]</li>
     </ul>
     
     <h4>Zertifikate:</h4>
     <ul>
       <li>[Relevante Zertifikate für den Beruf]</li>
     </ul>
   </div>

7. **KONKRETE NÄCHSTE SCHRITTE**
   
   Nutze <div class="section-container"> für diese Sektion:
   
   <div class="section-container">
     <h3>🎯 Deine nächsten Schritte</h3>
     
     <div class="step-item">
       <span class="step-number">1</span>
       <div class="step-content">
         <strong>Sofort machbar:</strong> [Z.B. Informiere dich auf berufenet.de]
       </div>
     </div>
     
     <div class="step-item">
       <span class="step-number">2</span>
       <div class="step-content">
         <strong>Diese Woche:</strong> [Z.B. Praktikum suchen]
       </div>
     </div>
     
     <div class="step-item">
       <span class="step-number">3</span>
       <div class="step-content">
         <strong>Nächster Monat:</strong> [Z.B. Bewerbungen schreiben]
       </div>
     </div>
     
     <div class="step-item">
       <span class="step-number">4</span>
       <div class="step-content">
         <strong>In 6 Monaten:</strong> [Z.B. Start Ausbildung/Studium]
       </div>
     </div>
     
     <div class="step-item">
       <span class="step-number">5</span>
       <div class="step-content">
         <strong>Langfristig:</strong> [Z.B. Weiterbildung planen]
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
  
  <h4>🔭 Wie sicher ist dieser Beruf in der Zukunft?</h4>
  <div class="info-box" style="background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border-left: 4px solid #16a34a;">
    <p><strong>📈 Jobmarkt-Trend (2025–2035):</strong><br>
    [Konkrete Einschätzung ob der Beruf wächst, stagniert oder schrumpft – mit Zahlen! Z.B.: "Der Bedarf an Fachinformatiker*innen wächst um ca. 25% bis 2030 – aktuell 150.000 offene Stellen in Deutschland."]</p>
    <p><strong>🤖 KI & Automatisierungs-Risiko: [GERING / MITTEL / HOCH]</strong><br>
    [Klare Begründung. Z.B.: "GERING – Kreative und soziale Aspekte dieses Berufs sind schwer zu automatisieren. KI wird als Werkzeug eingesetzt, ersetzt aber nicht den Menschen."]</p>
    <p><strong>🚀 So entwickelt sich der Beruf in 5–10 Jahren:</strong><br>
    [Neue Technologien, neue Anforderungen, neue Spezialisierungen die entstehen werden]</p>
    <p><strong>🌍 Branchen mit dem größten Bedarf:</strong><br>
    [3–4 konkrete Wachstumsbranchen für diesen Beruf nennen]</p>
  </div>

  <h4>📋 DEIN persönlicher Steckbrief</h4>
  <div style="background: white; border: 2px solid #1a4d2e; border-radius: 12px; padding: 24px; margin: 16px 0;">
    <div style="background: linear-gradient(135deg, #1a4d2e 0%, #2d6a4f 100%); color: white; padding: 16px 20px; border-radius: 8px; margin-bottom: 20px; text-align: center;">
      <h3 style="color: white; margin: 0; font-size: 1.3rem; border: none; padding: 0;">[Berufsbezeichnung]</h3>
      <p style="margin: 6px 0 0; opacity: 0.9; font-size: 0.9rem;">DEIN persönlicher Karriere-Steckbrief</p>
    </div>
    <table style="width: 100%; border-collapse: collapse; font-size: 0.95rem;">
      <tr style="background: #f8fafc;"><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; width: 42%; border-bottom: 1px solid #e2e8f0;">📚 Bildungsweg</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[Ausbildung / Duales Studium / Studium / Quereinstieg]</td></tr>
      <tr><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">⏱️ Dauer</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[X Jahre]</td></tr>
      <tr style="background: #f8fafc;"><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">🎓 Voraussetzung</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[Welcher Schulabschluss wird benötigt]</td></tr>
      <tr><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">💰 Gehalt Einstieg</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[X.XXX – X.XXX €/Monat]</td></tr>
      <tr style="background: #f8fafc;"><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">📈 Gehalt nach 5 Jahren</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[X.XXX – X.XXX €/Monat]</td></tr>
      <tr><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">🔭 Zukunftssicherheit</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[⭐⭐⭐⭐⭐ Sehr sicher / ⭐⭐⭐⭐ Sicher / ⭐⭐⭐ Mittel] – [1 Satz Begründung]</td></tr>
      <tr style="background: #f8fafc;"><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">🤖 KI-Risiko</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[🟢 Gering / 🟡 Mittel / 🔴 Hoch]</td></tr>
      <tr><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">📋 Was kommt auf DICH zu?</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[3–4 konkrete ehrliche Dinge. Z.B.: "Viel Theorie im 1. Jahr, danach Betriebspraxis, IHK-Prüfung am Ende, frühe Verantwortung"]</td></tr>
      <tr style="background: #f8fafc;"><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">✅ Passt zu DIR weil</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[2–3 Punkte direkt bezogen auf die Antworten des Users – nicht generisch!]</td></tr>
      <tr><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">⚠️ Herausforderungen</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[1–2 ehrliche Herausforderungen – nicht schönreden!]</td></tr>
      <tr style="background: #f8fafc;"><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e;">🎯 DEIN erster Schritt</td><td style="padding: 10px 14px;">[Ein einziger, sehr konkreter nächster Schritt]</td></tr>
    </table>
    <div style="margin-top: 16px; text-align: center;">
      <button onclick="window.print()" style="background: linear-gradient(135deg, #1a4d2e 0%, #2d6a4f 100%); color: white; border: none; padding: 12px 28px; border-radius: 8px; font-size: 0.95rem; font-weight: 600; cursor: pointer;">
        📄 Steckbrief als PDF speichern
      </button>
    </div>
  </div>
  
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
  
  <h4>Warum zu dir passt:</h4>
  <p>[Begründung]</p>
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
  
  <h4>🔭 Wie sicher ist dieser Beruf in der Zukunft?</h4>
  <div class="info-box" style="background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border-left: 4px solid #16a34a;">
    <p><strong>📈 Jobmarkt-Trend (2025–2035):</strong><br>
    [Konkrete Einschätzung ob der Beruf wächst, stagniert oder schrumpft – mit Zahlen! Z.B.: "Der Bedarf an Fachinformatiker*innen wächst um ca. 25% bis 2030 – aktuell 150.000 offene Stellen in Deutschland."]</p>
    <p><strong>🤖 KI & Automatisierungs-Risiko: [GERING / MITTEL / HOCH]</strong><br>
    [Klare Begründung. Z.B.: "GERING – Kreative und soziale Aspekte dieses Berufs sind schwer zu automatisieren. KI wird als Werkzeug eingesetzt, ersetzt aber nicht den Menschen."]</p>
    <p><strong>🚀 So entwickelt sich der Beruf in 5–10 Jahren:</strong><br>
    [Neue Technologien, neue Anforderungen, neue Spezialisierungen die entstehen werden]</p>
    <p><strong>🌍 Branchen mit dem größten Bedarf:</strong><br>
    [3–4 konkrete Wachstumsbranchen für diesen Beruf nennen]</p>
  </div>

  <h4>📋 DEIN persönlicher Steckbrief</h4>
  <div style="background: white; border: 2px solid #1a4d2e; border-radius: 12px; padding: 24px; margin: 16px 0;">
    <div style="background: linear-gradient(135deg, #1a4d2e 0%, #2d6a4f 100%); color: white; padding: 16px 20px; border-radius: 8px; margin-bottom: 20px; text-align: center;">
      <h3 style="color: white; margin: 0; font-size: 1.3rem; border: none; padding: 0;">[Berufsbezeichnung]</h3>
      <p style="margin: 6px 0 0; opacity: 0.9; font-size: 0.9rem;">DEIN persönlicher Karriere-Steckbrief</p>
    </div>
    <table style="width: 100%; border-collapse: collapse; font-size: 0.95rem;">
      <tr style="background: #f8fafc;"><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; width: 42%; border-bottom: 1px solid #e2e8f0;">📚 Bildungsweg</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[Ausbildung / Duales Studium / Studium / Quereinstieg]</td></tr>
      <tr><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">⏱️ Dauer</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[X Jahre]</td></tr>
      <tr style="background: #f8fafc;"><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">🎓 Voraussetzung</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[Welcher Schulabschluss wird benötigt]</td></tr>
      <tr><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">💰 Gehalt Einstieg</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[X.XXX – X.XXX €/Monat]</td></tr>
      <tr style="background: #f8fafc;"><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">📈 Gehalt nach 5 Jahren</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[X.XXX – X.XXX €/Monat]</td></tr>
      <tr><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">🔭 Zukunftssicherheit</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[⭐⭐⭐⭐⭐ Sehr sicher / ⭐⭐⭐⭐ Sicher / ⭐⭐⭐ Mittel] – [1 Satz Begründung]</td></tr>
      <tr style="background: #f8fafc;"><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">🤖 KI-Risiko</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[🟢 Gering / 🟡 Mittel / 🔴 Hoch]</td></tr>
      <tr><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">📋 Was kommt auf DICH zu?</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[3–4 konkrete ehrliche Dinge. Z.B.: "Viel Theorie im 1. Jahr, danach Betriebspraxis, IHK-Prüfung am Ende, frühe Verantwortung"]</td></tr>
      <tr style="background: #f8fafc;"><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">✅ Passt zu DIR weil</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[2–3 Punkte direkt bezogen auf die Antworten des Users – nicht generisch!]</td></tr>
      <tr><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">⚠️ Herausforderungen</td><td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[1–2 ehrliche Herausforderungen – nicht schönreden!]</td></tr>
      <tr style="background: #f8fafc;"><td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e;">🎯 DEIN erster Schritt</td><td style="padding: 10px 14px;">[Ein einziger, sehr konkreter nächster Schritt]</td></tr>
    </table>
    <div style="margin-top: 16px; text-align: center;">
      <button onclick="window.print()" style="background: linear-gradient(135deg, #1a4d2e 0%, #2d6a4f 100%); color: white; border: none; padding: 12px 28px; border-radius: 8px; font-size: 0.95rem; font-weight: 600; cursor: pointer;">
        📄 Steckbrief als PDF speichern
      </button>
    </div>
  </div>
  
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
  
  <h4>Warum zu dir passt:</h4>
  <p>[Begründung]</p>
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

Sei KONKRET und REALISTISCH! Keine schwammigen Aussagen! Berücksichtige STRIKT den Bildungsabschluss!`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "Du bist ein erfahrener Karriere- und Studienberater mit 15+ Jahren Erfahrung. Du gibst konkrete, umsetzbare Empfehlungen und sprichst die Leute IMMER mit DU an - nie mit Sie! Du bist wie ein guter Freund der hilft."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.7,
            max_tokens: 5500,
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
                    content: `Du bist ein freundlicher Karriereberater. 
                    
Der User hat gerade diese Karriere-Analyse bekommen:
\${analysisContext}

Deine Aufgabe:
- Beantworte Fragen zur Analyse konkret und präzise
- Nutze die Informationen aus der Analyse
- Gib praktische, umsetzbare Tipps
- Sei ermutigend und motivierend
- Verwende "Du"-Anrede
- Halte Antworten auf 3-5 Sätze (nicht zu lang!)
- Füge wenn passend Job-Links oder Weiterbildungs-Tipps hinzu

Beispiel gute Antwort:
"Die Ausbildung zum Industriekaufmann dauert 3 Jahre. In Köln gibt es viele große Unternehmen wie Ford, Bayer oder Lanxess, die regelmäßig Azubis suchen. Du verdienst im ersten Jahr ca. 850€ und nach der Ausbildung 2.800-3.200€. Schau dir am besten die Links in deiner Analyse an - da findest du aktuelle Stellen!"

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
    console.log('🔭 Zukunftsperspektive NEU aktiv!');
    console.log('📋 Steckbrief-PDF NEU aktiv!');
    console.log('=================================');
});

module.exports = app;