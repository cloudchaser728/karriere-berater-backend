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
        res.json({ status: 'complete', analysis: analysis, partnerCode: partnerCode });
    } catch (error) {
        console.error('❌ Partner-Analyse Fehler:', error);
        res.status(500).json({ error: 'Analysis generation failed', message: error.message });
    }
});

// 2. ANALYZE WITH OPENAI GPT-4o
async function analyzeCareerWithAI(formData, sessionId) {
    try {
        console.log('Starting analysis for session:', sessionId);

        const prompt = `Du bist ein professioneller Karriere- und Studienberater. Analysiere folgende Informationen und erstelle eine detaillierte, personalisierte Karriereberatung auf Deutsch.

**WICHTIG: Sprich den User DURCHGEHEND mit "DU" an! Schreibe DEIN/DEINE/DIR groß! Keine "Sie"-Form! Gendern mit *in (Berater*in, Schüler*in etc.)**

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
**ABITUR → MINDESTENS 1-2 Empfehlungen MÜSSEN Studiengänge (Uni/FH) sein!**
- Duales Studium ist exzellente Option (Gehalt + Abschluss)
- NC angeben, BAföG/Finanzierung erwähnen
- Akademischen Weg als primäre Option zeigen
` : ''}
${formData.education === 'fachabitur' ? `
**FACHABITUR → FH-Studiengänge UND Ausbildungen zeigen!**
- NUR Fachhochschulen (KEINE Universitäten!)
- Duales Studium ideal
- Explizit erwähnen: "Mit Fachabitur an FH möglich"
` : ''}
${formData.education === 'realschule' ? `
**REALSCHULABSCHLUSS → Primär Ausbildungen!**
- Weg zum Studium nur über 2. Bildungsweg erklären
` : ''}
${formData.education === 'hauptschule' ? `
**HAUPTSCHULABSCHLUSS → Ausbildungsberufe im Fokus!**
- Weg: Ausbildung → Meister/Techniker zeigen
` : ''}
${formData.education === 'school' ? `
**NOCH IN DER SCHULE → Beide Wege zeigen: Ausbildung UND Studium**
` : ''}
${formData.education === 'bachelor' || formData.education === 'master' ? `
**BEREITS STUDIERT → Akademische Karrierewege und Weiterbildungen**
` : ''}

AUFGABE: Erstelle eine umfassende Karriereberatung. Für JEDEN der Top 3 Karrierewege MUSST du ALLE Sektionen liefern – insbesondere die NEU hinzugekommenen Sektionen "Zukunftsperspektive" und "Steckbrief".

---

**STRUKTUR FÜR JEDEN DER 3 KARRIEREWEGE:**

<div class="career-path-card">
  <h3>[Emoji] [Berufsbezeichnung]</h3>
  
  <div class="badge-container">
    <span class="career-badge duration-badge">[Dauer]</span>
    <span class="career-badge education-badge">[Abschluss]</span>
  </div>

  <h4>Der Weg dorthin:</h4>
  <div class="info-box">
    [Ausbildung/Studium/Quereinstieg – konkret beschreiben]
  </div>

  <h4>Die harten Fakten:</h4>
  <table class="salary-table">
    [Vergütung/Gehalt je nach Weg – IMMER konkrete Zahlen!]
  </table>

  <h4>💪 Karriere-Turbo:</h4>
  [Weiterbildung + konkreter Gehaltssprung mit Zahlen]

  <!-- ============================================
       NEU: ZUKUNFTSPERSPEKTIVE
       ============================================ -->
  <h4>🔭 Wie sicher ist dieser Beruf in der Zukunft?</h4>
  <div class="info-box" style="background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border-left: 4px solid #16a34a;">

    <p><strong>📈 Jobmarkt-Trend (2025–2035):</strong><br>
    [Konkrete Einschätzung ob der Beruf wächst, stagniert oder schrumpft. Mit Zahlen! Z.B.: "Die Nachfrage nach Fachinformatiker*innen wächst um ca. 25% bis 2030 – aktuell sind 150.000 IT-Stellen in Deutschland unbesetzt."]</p>

    <p><strong>🤖 KI & Automatisierungs-Risiko: [GERING / MITTEL / HOCH]</strong><br>
    [Klare Begründung warum das Risiko so eingeschätzt wird. Z.B.: "GERING – Kreative und soziale Aspekte dieses Berufs sind für KI schwer zu übernehmen. KI wird als Werkzeug eingesetzt, ersetzt aber nicht den Menschen."]</p>

    <p><strong>🚀 So entwickelt sich der Beruf:</strong><br>
    [Konkret beschreiben wie sich der Beruf in 5–10 Jahren verändert: neue Technologien, neue Anforderungen, neue Spezialisierungen. Z.B.: "Fachinformatiker*innen werden zunehmend KI-Tools einsetzen und Cloud-Kenntnisse benötigen. Neue Spezialisierungen wie 'AI-Integration' entstehen."]</p>

    <p><strong>🌍 Branchen mit dem größten Bedarf:</strong><br>
    [3–4 konkrete Wachstumsbranchen für diesen Beruf nennen]</p>

  </div>

  <!-- ============================================
       NEU: PERSÖNLICHER STECKBRIEF (DRUCKBAR ALS PDF)
       ============================================ -->
  <h4>📋 DEIN persönlicher Steckbrief</h4>
  <div class="steckbrief-box" style="background: white; border: 2px solid #1a4d2e; border-radius: 12px; padding: 24px; margin: 16px 0;">

    <div style="background: linear-gradient(135deg, #1a4d2e 0%, #2d6a4f 100%); color: white; padding: 16px 20px; border-radius: 8px; margin-bottom: 20px; text-align: center;">
      <h3 style="color: white; margin: 0; font-size: 1.4rem; border: none; padding: 0;">[Berufsbezeichnung]</h3>
      <p style="margin: 6px 0 0; opacity: 0.9; font-size: 0.9rem;">DEIN persönlicher Karriere-Steckbrief</p>
    </div>

    <table style="width: 100%; border-collapse: collapse; font-size: 0.95rem;">
      <tr style="background: #f8fafc;">
        <td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; width: 42%; border-bottom: 1px solid #e2e8f0;">📚 Bildungsweg</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[Ausbildung / Duales Studium / Studium (B.Sc.) / Quereinstieg]</td>
      </tr>
      <tr>
        <td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">⏱️ Dauer</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[X Jahre]</td>
      </tr>
      <tr style="background: #f8fafc;">
        <td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">🎓 Voraussetzung</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[Welcher Schulabschluss wird benötigt]</td>
      </tr>
      <tr>
        <td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">💰 Gehalt Einstieg</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[X.XXX – X.XXX €/Monat]</td>
      </tr>
      <tr style="background: #f8fafc;">
        <td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">📈 Gehalt nach 5 Jahren</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[X.XXX – X.XXX €/Monat]</td>
      </tr>
      <tr>
        <td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">🔭 Zukunftssicherheit</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[⭐⭐⭐⭐⭐ Sehr sicher / ⭐⭐⭐⭐ Sicher / ⭐⭐⭐ Mittel] – [1 Satz Begründung]</td>
      </tr>
      <tr style="background: #f8fafc;">
        <td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">🤖 KI-Risiko</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[🟢 Gering / 🟡 Mittel / 🔴 Hoch]</td>
      </tr>
      <tr>
        <td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">📋 Was kommt auf DICH zu?</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[3–4 konkrete, ehrliche Dinge die in Ausbildung/Studium/Job auf die Person zukommen. Z.B.: "Viel Theorie im 1. Jahr, danach Betriebspraxis, IHK-Prüfung am Ende, frühe Verantwortung"]</td>
      </tr>
      <tr style="background: #f8fafc;">
        <td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">✅ Passt zu DIR weil</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[2–3 konkrete Punkte – bezogen auf die ANTWORTEN des Users! Nicht generisch!]</td>
      </tr>
      <tr>
        <td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e; border-bottom: 1px solid #e2e8f0;">⚠️ Herausforderungen</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0;">[1–2 ehrliche Herausforderungen – nicht schönreden!]</td>
      </tr>
      <tr style="background: #f8fafc;">
        <td style="padding: 10px 14px; font-weight: 600; color: #1a4d2e;">🎯 DEIN erster Schritt</td>
        <td style="padding: 10px 14px;">[Ein einziger, sehr konkreter nächster Schritt – spezifisch, nicht "informiere dich"]</td>
      </tr>
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
    <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+ausbildung&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🔍 Deutschlandweite Stellen</a>
    <a href="https://www.ausbildung.de/suche?what=[BERUFSBEZEICHNUNG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📋 Ausbildung.de</a>
    <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Indeed</a>
    ` : `
    <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+ausbildung+${encodeURIComponent(formData.location)}&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🔍 Stellen in ${formData.location}</a>
    <a href="https://www.ausbildung.de/suche?what=[BERUFSBEZEICHNUNG]&where=${encodeURIComponent(formData.location)}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📋 Ausbildung.de</a>
    <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]&l=${encodeURIComponent(formData.location)}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Indeed</a>
    `}
  </div>

  <h4>Warum dieser Beruf zu DIR passt:</h4>
  <p>[Begründung basierend auf den Antworten des Users – konkret auf SEINE Stärken/Interessen eingehen]</p>
</div>

---

**WICHTIG – LINKS RICHTIG BEFÜLLEN:**
- [BERUFSBEZEICHNUNG] IMMER durch den echten Berufsnamen ersetzen (z.B. "Fachinformatiker", "Krankenpfleger")
- [STUDIENGANG] durch echten Studiengangsnamen ersetzen (z.B. "Betriebswirtschaftslehre")
- Der Standort ist bereits automatisch eingefügt: ${formData.location}

**FÜR STUDIUM (Abitur/Fachabitur)** → Studiengang-Buttons statt Ausbildungs-Buttons:
<a href="https://www.hochschulkompass.de/studium/studiengangsuche/erweiterte-studiengangsuche.html?tx_szhrksearch_pi1[fach]=[STUDIENGANG]" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🎓 Hochschulkompass</a>
<a href="https://www.studycheck.de/suche?q=[STUDIENGANG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📚 StudyCheck</a>
<a href="https://www.wegweiser-duales-studium.de/suche/?q=[STUDIENGANG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Duales Studium</a>

**FÜR BERUFSTÄTIGE/ABSOLVENTEN** → Job-Buttons:
<a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+${encodeURIComponent(formData.location)}&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🔍 Jobs finden</a>
<a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]&l=${encodeURIComponent(formData.location)}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Indeed</a>
<a href="https://www.stepstone.de/jobs/[BERUFSBEZEICHNUNG]/in-${encodeURIComponent(formData.location)}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📋 StepStone</a>

---

**NACH DEN TOP 3 KARRIEREWEGEN DIESE SEKTIONEN ANFÜGEN:**

${formData.education === 'abitur' || formData.education === 'fachabitur' || formData.education === 'school' ? `
<div class="section-container">
  <h3>🏫 Uni/Hochschul-Empfehlungen</h3>
  [3–5 konkrete Hochschulen mit NC-Angaben und Städten]
  ${formData.education === 'fachabitur' ? '[NUR Fachhochschulen! Keine Unis!]' : '[Unis und FHs]'}
</div>
` : ''}

<div class="section-container">
  <h3>🔀 Alternative Karrierewege</h3>
  [3 weitere passende Berufe mit Kurzbeschreibung, Dauer, Einstiegsvoraussetzung]
</div>

<div class="section-container">
  <h3>📚 Weiterbildungs-Tipps</h3>
  <h4>Kostenlose Kurse:</h4>
  [Coursera, YouTube, etc. – konkret benennen]
  <h4>Bezahlte Optionen:</h4>
  [Udemy, LinkedIn Learning – mit Preisen]
  <h4>Zertifikate:</h4>
  [Relevante Zertifikate für die empfohlenen Berufe]
</div>

<div class="section-container">
  <h3>🎯 DEINE nächsten Schritte</h3>
  <div class="step-item"><span class="step-number">1</span><div class="step-content"><strong>Sofort (heute):</strong> [Sehr konkreter erster Schritt]</div></div>
  <div class="step-item"><span class="step-number">2</span><div class="step-content"><strong>Diese Woche:</strong> [Konkreter zweiter Schritt]</div></div>
  <div class="step-item"><span class="step-number">3</span><div class="step-content"><strong>Nächsten Monat:</strong> [Konkreter dritter Schritt]</div></div>
  <div class="step-item"><span class="step-number">4</span><div class="step-content"><strong>In 6 Monaten:</strong> [Meilenstein]</div></div>
  <div class="step-item"><span class="step-number">5</span><div class="step-content"><strong>Langfristig:</strong> [Karriereziel]</div></div>
</div>

---

**WICHTIGE REGELN:**
- IMMER "DU" verwenden, DEIN/DEINE/DIR groß schreiben
- Gendern mit *in (Fachinformatiker*in, Berater*in)
- Alle Zahlen KONKRET und REALISTISCH (keine Bandbreiten wie "2.000-5.000 €")
- Den Bildungsabschluss STRIKT beachten – keine unmöglichen Empfehlungen!
- Jeden career-path-card VOLLSTÄNDIG ausfüllen – KEIN Platzhalter leer lassen
- Die Zukunftsperspektive und den Steckbrief für JEDEN der 3 Berufe liefern`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "Du bist ein erfahrener Karriere- und Studienberater mit 15+ Jahren Erfahrung. Du gibst konkrete, umsetzbare Empfehlungen. Sprich IMMER mit DU an – nie mit Sie! Schreibe DEIN/DEINE/DIR groß. Gendern mit *in. Du bist ehrlich – auch über Herausforderungen. Fülle JEDEN Platzhalter in der Vorlage mit echten, spezifischen Informationen. Lasse KEINEN Platzhalter leer."
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
            return res.status(202).json({ status: 'processing', message: 'Analyse läuft noch...' });
        }
        res.json({ status: 'complete', analysis: result.analysis });
    } catch (error) {
        console.error('Get Analysis Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// CHATBOT ENDPOINT
app.post('/api/chatbot', async (req, res) => {
    try {
        const { question, analysisContext, sessionId } = req.body;
        console.log('💬 Chatbot Question:', question);
        
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `Du bist ein freundlicher Karriereberater. 
                    
Der User hat gerade diese Karriere-Analyse bekommen:
${analysisContext}

Deine Aufgabe:
- Beantworte Fragen zur Analyse konkret und präzise
- Nutze die Informationen aus der Analyse
- Gib praktische, umsetzbare Tipps
- Sei ermutigend und motivierend
- Verwende "Du"-Anrede, schreibe DEIN/DEINE groß
- Halte Antworten auf 3–5 Sätze
- Füge wenn passend Job-Links oder Weiterbildungs-Tipps hinzu`
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
        res.status(500).json({ error: 'Entschuldigung, da ist ein Fehler aufgetreten.' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log('=================================');
    console.log('✅ SERVER LÄUFT auf Port', PORT);
    console.log('🆕 Partner-Endpoint aktiv!');
    console.log('🤖 Chatbot-Endpoint aktiv!');
    console.log('🔭 Zukunftsperspektive NEU aktiv!');
    console.log('📋 Steckbrief NEU aktiv!');
    console.log('=================================');
});

module.exports = app;
