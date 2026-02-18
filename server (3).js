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
- Bildung: ${formData.education}

AUFGABE:
Erstelle eine umfassende Karriereberatung mit KONKRETEM FAHRPLAN für jeden Beruf.

**STRUKTUR:**

1. **DEIN PROFIL**
   - Kurze Zusammenfassung deiner Arbeitsweise und Flow-State
   - Was macht dich einzigartig?

2. **DEINE TOP 3 KARRIEREWEGE**
   
   Für JEDEN Beruf MUSST du folgendes liefern:
   
   **[Berufsbezeichnung]** (z.B. "Fachinformatiker/in für Anwendungsentwicklung")
   
   **Der Weg dorthin:**
   - Studium ODER Ausbildung? (Sei spezifisch!)
   - Wenn Studium: Welches Fach? Uni oder FH? Bachelor reicht oder Master nötig?
   - Wenn Ausbildung: Exakte Berufsbezeichnung, Dauer (z.B. "3 Jahre")
   - Duales Studium möglich? Wenn ja, welches?
   - Voraussetzungen: Abitur, Realschulabschluss, Hauptschulabschluss?
   
   **Die harten Fakten:**
   - Dauer der Ausbildung/des Studiums
   - Ausbildungsvergütung (falls Ausbildung):
     * 1. Jahr: ca. XXX €
     * 2. Jahr: ca. XXX €
     * 3. Jahr: ca. XXX €
   - Einstiegsgehalt nach Abschluss
   - Gehalt nach 3-5 Jahren
   
   **Karriere-Turbo:**
   - Welche Weiterbildungen sind möglich? (z.B. Meister, Techniker, Master)
   - Was bringt das finanziell? (Gehaltssprung angeben!)
   
   **Warum dieser Beruf zu dir passt:**
   - Konkrete Bezüge zu deinen Stärken und Interessen

3. **KONKRETE NÄCHSTE SCHRITTE**
   
   Gib einen klaren 5-Schritte-Plan:
   - Schritt 1: [Sofort machbar, z.B. "Informiere dich auf berufenet.de über..."]
   - Schritt 2: [Praktische Erfahrung, z.B. "Mach ein Praktikum bei..."]
   - Schritt 3: [Bewerbung/Einschreibung]
   - Schritt 4: [Start der Ausbildung/des Studiums]
   - Schritt 5: [Langfristig: Weiterbildung]

${formData.situation === 'abitur' || formData.situation === 'student' ? `
4. **UNI/HOCHSCHUL-EMPFEHLUNGEN**
   - 3-5 konkrete Unis/FHs in Deutschland
   - NC-Anforderungen wenn relevant
   - Alternative Wege wenn NC nicht reicht
` : ''}

5. **ALTERNATIVE KARRIEREWEGE**
   - 2-3 weitere Optionen die zu dir passen könnten
   - Kurz erklärt mit Einstiegsweg

6. **WEITERBILDUNGS-TIPPS**
   - Konkrete Online-Kurse oder Zertifikate
   - Kostenlose und bezahlte Optionen

**FORMATIERUNG:**
- Nutze <div class="career-badge"> für Badges (z.B. Gehalt, Dauer)
- Nutze <div class="info-box"> für wichtige Infos
- Strukturiere mit <h3> und <h4>
- Nutze Listen <ul> nur wo sinnvoll
- Sprich IMMER mit "DU"!

Sei KONKRET und REALISTISCH! Keine schwammigen Aussagen!`;

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
