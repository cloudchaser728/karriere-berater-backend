require('dotenv').config();

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use('/webhook', express.raw({type: 'application/json'}));
app.use(express.json());
app.use(express.static('public'));

// Anthropic Client
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
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
            payment_method_types: ['card'],
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
            success_url: process.env.SUCCESS_URL + '?session_id={CHECKOUT_SESSION_ID}',
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

// 2. ANALYZE WITH CLAUDE
async function analyzeCareerWithAI(formData, sessionId) {
    try {
        console.log('Starting analysis for session:', sessionId);

        const prompt = `Du bist ein professioneller Karriere- und Studienberater. Analysiere folgende Informationen und erstelle eine detaillierte, personalisierte Karriereberatung auf Deutsch:

PERSÖNLICHE DATEN:
- Alter: ${formData.age}
- Aktuelle Situation: ${formData.situation}
- Studium/Ausbildung Präferenz: ${formData.path_preference || 'Keine Präferenz'}
- Interessen: ${formData.interests ? (Array.isArray(formData.interests) ? formData.interests.join(', ') : formData.interests) : 'Keine angegeben'}
- Stärken: ${formData.strengths}
- Priorität im Job: ${formData.priority}
- Traumjob-Beschreibung: ${formData.dream_job}
- Bildung: ${formData.education}

AUFGABE:
Erstelle eine umfassende Karriere- und Studienberatung mit folgender Struktur:

${formData.situation === 'abitur' || formData.situation === 'student' ? `
1. EMPFOHLENE STUDIENGÄNGE ODER AUSBILDUNGEN (3-5 konkrete Optionen)
   - Liste spezifische Studiengänge oder Ausbildungsberufe auf
   - Erkläre, warum diese zum Profil passen
   - Erwähne NC-Anforderungen wenn relevant

2. UNI/HOCHSCHUL-EMPFEHLUNGEN
   - Nenne 3-5 konkrete Unis/FHs in Deutschland
   - Erwähne besondere Stärken der Hochschulen

3. ALTERNATIVE WEGE
   - Was wenn NC nicht reicht?
   - Duales Studium als Option?
` : `
1. EMPFOHLENE KARRIEREWEGE (3-5 konkrete Berufe)
   - Liste spezifische Berufe auf
   - Sei konkret (nicht "IT-Branche" sondern "Software-Entwickler", "UX Designer")
`}

${formData.situation === 'abitur' || formData.situation === 'student' ? '4.' : '2.'} BEGRÜNDUNG
   - Erkläre detailliert warum diese Empfehlungen passen
   - Beziehe dich auf Stärken und Interessen

${formData.situation === 'abitur' || formData.situation === 'student' ? '5.' : '3.'} KONKRETE NÄCHSTE SCHRITTE (5-7 Schritte)
   - Gib einen klaren, umsetzbaren Aktionsplan
   - Beginne mit sofort machbaren Schritten

${formData.situation === 'abitur' || formData.situation === 'student' ? '6.' : '4.'} WEITERBILDUNGS-EMPFEHLUNGEN
   - Konkrete Kurse, Plattformen, Zertifikate
   - Kostenlose und bezahlte Optionen

${formData.situation === 'abitur' || formData.situation === 'student' ? '7.' : '5.'} GEHALTS-PERSPEKTIVEN & JOBAUSSICHTEN
   - Realistische Einstiegsgehälter in Deutschland
   - Entwicklung nach 3-5 Jahren
   - Jobmarkt-Situation

Formatiere die Antwort in strukturiertem HTML mit <h3> für Überschriften und <p>, <ul>, <li> für Inhalte. Sei spezifisch, konkret und realistisch!`;

        const message = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4000,
            messages: [{
                role: 'user',
                content: prompt
            }]
        });

        const analysis = message.content[0].text;

        // Store result
        analysisResults.set(sessionId, {
            analysis: analysis,
            timestamp: new Date(),
            formData: formData
        });

        console.log('Analysis complete for session:', sessionId);

        return analysis;
    } catch (error) {
        console.error('Claude API Error:', error);
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
    console.log('=================================');
});

module.exports = app;
