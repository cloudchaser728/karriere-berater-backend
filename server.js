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
**DU HAST ABITUR** - WICHTIG:
- MINDESTENS 1-2 deiner Top 3 Empfehlungen MÜSSEN Studiengänge (Uni/FH) sein!
- Duales Studium ist eine exzellente Option (Gehalt + Abschluss)
- Ausbildung nur als Alternative, nicht als Hauptempfehlung
- Für Studiengänge: NC angeben, BAföG/Finanzierung erwähnen
- Zeige den akademischen Weg als primäre Option!
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

**STRUKTUR:**

1. **DEIN PROFIL**
   - Kurze Zusammenfassung deiner Arbeitsweise und Flow-State
   - Was macht dich einzigartig?

2. **DEINE TOP 3 KARRIEREWEGE**
   
   **WICHTIG: Berücksichtige den Bildungsabschluss strikt!**
   
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

3. **KONKRETE NÄCHSTE SCHRITTE**
   
   Gib einen klaren 5-Schritte-Plan:
   - Schritt 1: [Sofort machbar, z.B. "Informiere dich auf berufenet.de über..."]
   - Schritt 2: [Praktische Erfahrung, z.B. "Mach ein Praktikum bei..."]
   - Schritt 3: [Bewerbung/Einschreibung]
   - Schritt 4: [Start der Ausbildung/des Studiums]
   - Schritt 5: [Langfristig: Weiterbildung]

${formData.education === 'abitur' || formData.education === 'school' ? `
4. **UNI/HOCHSCHUL-EMPFEHLUNGEN**
   - 3-5 konkrete Unis/FHs in Deutschland für deine Studiengänge
   - NC-Anforderungen (z.B. "TU München: NC ca. 1,8 | Uni Köln: NC ca. 2,5")
   - Alternative Wege wenn NC nicht reicht (Wartesemester, Auswahlverfahren, private FHs)
   - Duale Hochschulen in deiner Nähe
` : ''}

5. **ALTERNATIVE KARRIEREWEGE**
   - 2-3 weitere Optionen die zu dir passen könnten
   - Kurz erklärt mit Einstiegsweg
   - AUCH HIER: Bildungsabschluss beachten!

6. **WEITERBILDUNGS-TIPPS**
   - Konkrete Online-Kurse oder Zertifikate
   - Kostenlose und bezahlte Optionen
   - Plattformen: Coursera, Udemy, LinkedIn Learning

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
  
  <div class="success-box">
    <h4>💪 Karriere-Turbo:</h4>
    <p>[Weiterbildungen und Gehaltssprünge]</p>
  </div>
  
  <h4>Warum zu dir passt:</h4>
  <p>[Begründung]</p>
</div>

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
  
  <div class="success-box">
    <h4>💪 Karriere-Turbo:</h4>
    <p>[Master/MBA und Gehaltssprünge]</p>
  </div>
</div>

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
            max_tokens: 4000,
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

// Start server
app.listen(PORT, () => {
    console.log('=================================');
    console.log('✅ SERVER LÄUFT auf Port', PORT);
    console.log('🆕 Partner-Endpoint aktiv!');
    console.log('🎨 Verbesserter Prompt (DU + Fahrplan)');
    console.log('=================================');
});

module.exports = app;
