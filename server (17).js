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

// Einmal-Codes – nach Nutzung gesperrt
const oneTimeCodes = new Map([
    ['jakob', { used: false, usedAt: null }]
]);

// Root route - serve HTML file from public folder
// Retry helper für OpenAI Rate Limits (429)
async function callWithRetry(fn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (err.status === 429 && i < maxRetries - 1) {
                const waitMs = (err.headers?.['retry-after-ms'] ? parseInt(err.headers['retry-after-ms']) : 5000) + 1000;
                console.log(`Rate limit hit, waiting ${waitMs}ms before retry ${i + 1}...`);
                await new Promise(r => setTimeout(r, waitMs));
            } else {
                throw err;
            }
        }
    }
}

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
            payment_method_types: ['card'],
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

        // Einmal-Code prüfen
        if (oneTimeCodes.has(partnerCode)) {
            const codeData = oneTimeCodes.get(partnerCode);
            if (codeData.used) {
                console.log(`❌ Einmal-Code bereits verwendet: ${partnerCode} (genutzt am ${codeData.usedAt})`);
                return res.status(403).json({ 
                    error: 'Code bereits verwendet',
                    message: 'Dieser Code wurde bereits eingelöst und ist nicht mehr gültig.'
                });
            }
            // Code als verwendet markieren
            oneTimeCodes.set(partnerCode, { used: true, usedAt: new Date().toISOString() });
            console.log(`✅ Einmal-Code eingelöst: ${partnerCode}`);
        }
        
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


        // Dynamische Berufsliste je nach Bildungsabschluss
        const edu = formData.education || '';
        const bwz = formData.bildungsweg_ziel || '';
        let berufsliste = '';
        if (bwz === 'uni' || edu === 'abitur' || edu === 'abitur_ziel') {
            berufsliste = '═══════════════════════════════════════════════\n🟣 UNI-STUDIENGÄNGE (NUR mit Abitur)\n═══════════════════════════════════════════════\n\n💻 TECHNOLOGIE:\nInformatik, Computer Science, Technische Informatik, Angewandte Informatik\nSoftware Engineering, Cyber Security, Data Science, KI, Bioinformatik\nQuanteninformatik, Embedded Systems, Forensische Informatik, Computervisualistik\nHuman-Computer Interaction, IT-Recht & Management, Geoinformatik\n\n🎨 KREATIVITÄT & DESIGN:\nKommunikationsdesign, Architektur, Landschaftsarchitektur, Freie Kunst\nProduktdesign, Industriedesign, Grafikdesign, Modedesign, Textildesign\nInteraktionsdesign (UI/UX), Fotografie/Fotodesign, Film & Fernsehen (Regie/Schnitt)\nSzenografie, Illustrationsdesign, Schmuckdesign, Sound Design, Musikproduktion\nAusstellungsdesign, Verpackungsdesign, Designmanagement\n\n👥 PÄDAGOGIK & SOZIALES:\nPsychologie, Erziehungswissenschaften, Soziale Arbeit, Kindheitspädagogik\nLehramt (Grundschule|Sonderpädagogik|Gymnasium|Berufsschule)\nHeilpädagogik, Rehabilitationspädagogik, Inklusionspädagogik, Gerontologie\nMusiktherapie, Kunsttherapie, Friedens- & Konfliktforschung\nErwachsenenbildung, E-Learning & Medienpädagogik, Sozialwirtschaft\n\n💰 WIRTSCHAFT & FINANZEN:\nBWL, VWL, Wirtschaftswissenschaften, International Business\nFinance & Banking, Wirtschaftsprüfung & Steuern, Wirtschaftsrecht\nWirtschaftsmathematik, Finanzmathematik, Quantitative Finance\nLogistikmanagement, Entrepreneurship, Public Administration\n\n🏥 GESUNDHEIT & MEDIZIN:\nHumanmedizin, Zahnmedizin, Pharmazie, Tiermedizin (Veterinärmedizin)\nPsychologie (Klinisch), Molekulare Medizin, Biomedizin, Neurowissenschaften\nMedizinische Biotechnologie, Biomedizinische Technik, Sportmedizin\nErnährungswissenschaften (Ökotrophologie), Diätetik, Osteopathie\nPflegewissenschaft, Public Health, Notfallmanagement\n\n🔧 INGENIEURWESEN:\nMaschinenbau, Mechatronik, Elektrotechnik, Fahrzeugtechnik\nBauingenieurwesen, Werkstoffwissenschaften, Verfahrenstechnik\nLuft- & Raumfahrttechnik, Schiffbau & Meerestechnik, Bergbau\nRestaurierungswissenschaften, Denkmalpflege, Bauphysik, Schweißtechnik\nKeramik-, Glas- & Baustofftechnik, Feinwerktechnik\n\n🌿 NATUR & UMWELT:\nBiologie, Biowissenschaften, Chemie, Physik, Geowissenschaften\nUmweltwissenschaften, Ökologie, Meeresbiologie, Meteorologie\nAgrarwissenschaften, Gartenbauwissenschaft, Forstwirtschaft\nLandschaftsökologie, Naturschutz, Hydrologie, Bodenkunde\nWildtiermanagement, Botanik, Zoologie, Planetologie\n\n🛡️ SICHERHEIT & SCHUTZ:\nPolizeivollzugsdienst (Höherer Dienst), Kriminalistik, Forensische Wissenschaften\nRechtswissenschaft/Jura, Cyber-Kriminalistik, Strategische Studien\nInternational Security, Krisenmanagement, Bevölkerungsschutz\nFinanzkriminalität & Geldwäscheprävention, Digitale Forensik\n\n✈️ LUFT- & RAUMFAHRT:\nLuft- & Raumfahrttechnik, Flugzeugbau, Astrotechnik, Satellitentechnik\nAstrophysik, Astronomie, Aerodynamik, Raumfahrtsysteme\nWeltraumrecht, Weltraumökonomie, Navigation & Geodäsie\nAerospace Engineering, Safety Management Aviation, Luftfahrthygiene\n';
        } else if (bwz === 'fh' || edu === 'fachabitur' || edu === 'fachabitur_ziel') {
            berufsliste = '═══════════════════════════════════════════════\n🔵 DUALE STUDIENGÄNGE / FH (NUR Fachabitur)\n═══════════════════════════════════════════════\n\n💻 TECHNOLOGIE:\nWirtschaftsinformatik, Software Engineering, Cyber Security, Data Science, KI, IT-Management\nCloud Computing, Mobile Computing, IoT, Medieninformatik, Technische Informatik\nIT-Forensik, IT-Security, Robotik, Automatisierungsinformatik, Computational Engineering\nUX/UI Design & Informatik, Medizininformatik, Geoinformatik, Game Engineering, Industrie 4.0\n\n🎨 KREATIVITÄT & DESIGN:\nMediendesign, Kommunikationsdesign, UX/UI Design, Produktdesign, Industriedesign\nGame Design, Motion Design, Grafikdesign & Branding, Visuelle Kommunikation\nInnenarchitektur, Architektur (Bauleitung), Modedesign, Textilmanagement\nDigitale Medien & Animation, Virtual Reality Design, Medienmanagement, Webdesign\nFoto- & Videodesign, Content Creation & Online Marketing, Nachhaltiges Designmanagement\n\n👥 ARBEIT MIT MENSCHEN:\nSoziale Arbeit (Jugendhilfe|Altenhilfe), Kindheitspädagogik, Heilpädagogik, Inklusionspädagogik\nSozialmanagement, Sozialpädagogik & Management, Bildungsmanagement, Gerontologie\nPersonalmanagement, Wirtschaftspsychologie (HR), Beratung & Coaching\nÖffentliche Verwaltung, Kommunaler Verwaltungsdienst, Sozialversicherungsmanagement\nGesundheits- & Sozialmanagement, Nonprofit Management, Mediation & Konfliktmanagement\n\n💰 WIRTSCHAFT & FINANZEN:\nBWL, Bankwesen, Versicherungswirtschaft, Controlling, International Business\nMarketing Management, Logistik & Supply Chain, Immobilienwirtschaft, Wirtschaftsrecht\nTourismusmanagement, Eventmanagement, Handelsmanagement, E-Commerce\nFinance & Asset Management, Nachhaltigkeitsmanagement (ESG), Energiewirtschaft\nHotel- & Gastronomiemanagement, Entrepreneurship, Public Management, Innovationsmanagement\n\n🏥 GESUNDHEIT & MEDIZIN:\nPflege B.Sc., Hebammenwissenschaft, Physiotherapie, Ergotherapie, Logopädie (alle Duales Modell)\nGesundheitsmanagement, Medizintechnik, Physician Assistant, Gesundheitspsychologie\nKrankenhausmanagement, Gesundheitsinformatik, Pflegepädagogik, Public Health\nPrävention & Gesundheitsförderung, E-Health Management, Rettungsingenieurwesen\n\n🔧 INGENIEURWESEN & HANDWERK:\nBauingenieurwesen, Maschinenbau, Mechatronik, Elektrotechnik, Wirtschaftsingenieurwesen\nFahrzeugtechnik, Energietechnik, Verfahrenstechnik, Automatisierungstechnik\nProduktionstechnik, Werkstofftechnik, Sicherheitstechnik, Facility Management\nBaumanagement, TGA, Vermessungstechnik, Umwelttechnik, Lebensmitteltechnologie\n\n🌿 NATUR & UMWELT:\nAgrarmanagement, Agrarwirtschaft, Forstwirtschaft, Erneuerbare Energien\nNaturschutz & Landschaftsplanung, Klimaschutzmanagement, Bioökonomie\nWasserwirtschaft, Abfall- & Kreislaufwirtschaft, Ökologische Landwirtschaft\nTiergesundheitsmanagement, Forstingenieurwesen, Umweltschutztechnik\n\n🛡️ SICHERHEIT & SCHUTZ:\nPolizeivollzugsdienst (g.D.), Sicherheitsmanagement, Kriminalistik & Kriminaltechnik\nCyber Security Management, Brandschutz & Sicherheitstechnik, Rettungsingenieurwesen\nZollvollzugsdienst (Gehobener Dienst), Gefahrenabwehr & Katastrophenschutz\nIT-Sicherheit & Forensik, Risiko- & Krisenmanagement, Arbeitssicherheit (HSE)\nInformationssicherheit, Wehrtechnik (Bundeswehr), Compliance & Wirtschaftsrecht\n\n✈️ LUFT- & RAUMFAHRT:\nLuft- & Raumfahrttechnik, Aviation Management, Luftverkehrsmanagement\nAirport Management, Avionik, Flugzeugbau & Instandhaltung, Antriebssysteme\nUnbemannte Systeme (Drohnen), Logistik & Luftfrachtmanagement\nSpace Systems Engineering, Wirtschaftsingenieurwesen Aviation, Sicherheit Luftfahrt\n';
        } else {
            berufsliste = '═══════════════════════════════════════════════\n🟢 AUSBILDUNGSBERUFE (NUR Realschule/Hauptschule)\n═══════════════════════════════════════════════\n\n💻 TECHNOLOGIE & COMPUTER:\nFachinformatiker/in (Anwendungsentwicklung|Systemintegration|Daten & Prozessanalyse|Digitale Vernetzung)\nKaufmann/-frau für (IT-Systemmanagement|Digitalisierungsmanagement|E-Commerce|audiovisuelle Medien)\nElektroniker/in für (Informations- & Systemtechnik|Automatisierungstechnik|Geräte & Systeme)\nIT-System-Elektroniker/in, Informationselektroniker/in, Systeminformatiker/in, MaTSE\nMikrotechnologe/in, Mediengestalter/in Digital+Print, Geomatiker/in, Vermessungstechniker/in\nMechatroniker/in, Physiklaborant/in, Film-/Videoeditor/in, Fachkraft Veranstaltungstechnik\nKaufmann/-frau für Marketingkommunikation, Fachkraft Medien- & Informationsdienste\n\n🎨 KREATIVITÄT & DESIGN:\nMediengestalter/in (Bild & Ton|Digital & Print), Fotograf/in, Gestalter/in visuelles Marketing\nGoldschmied/in, Silberschmied/in, Graveur/in, Edelsteinfasser/in, Uhrmacher/in\nTischler/in (Möbeldesign), Holzbildhauer/in, Steinmetz/in & Steinbildhauer/in\nRaumausstatter/in, Schilder- & Lichtreklamehersteller/in, Technischer Produktdesigner/in\nModeschneider/in, Maßschneider/in, Textil- & Modegestalter/in, Sattler/in, Schuhfertiger/in\nBuchbinder/in, Keramiker/in, Glasveredler/in, Musikinstrumentenbauer/in, Florist/in\nMaskenbildner/in, Bühnenmaler/in & Bühnenplastiker/in\n\n👥 ARBEIT MIT MENSCHEN:\nErzieher/in, Kinderpfleger/in, Sozialassistent/in, Heilerziehungspfleger/in\nPflegefachmann/-frau, Pflegefachassistent/in, Altenpflegehelfer/in\nMFA (Med. Fachangestellte/r), ZFA (Zahnmed. Fachangestellte/r)\nLogopäde/in, Ergotherapeut/in, Physiotherapeut/in, Diätassistent/in, Podologe/in\nSozialversicherungsfachangestellte/r, Verwaltungsfachangestellte/r\nKaufmann/-frau im Gesundheitswesen, PKA (Pharmazeutisch-kaufm. Angestellte/r)\nRettungssanitäter/in, Bestattungsfachkraft, Fachangestellte/r Bäderbetriebe\nSport- & Fitnesskaufmann/-frau, Kaufmann/-frau Tourismus & Freizeit\n\n💰 WIRTSCHAFT & FINANZEN:\nBankkaufmann/-frau, Industriekaufmann/-frau, Kaufmann/-frau Büromanagement\nKaufmann/-frau (Einzelhandel|Groß- & Außenhandel|Spedition & Logistik|Dialogmarketing)\nSteuerfachangestellte/r, Rechtsanwaltsfachangestellte/r, Notarfachangestellte/r\nImmobilienkaufmann/-frau, Automobilkaufmann/-frau, Investmentfondskaufmann/-frau\nVeranstaltungskaufmann/-frau, Hotelkaufmann/-frau, Tourismuskaufmann/-frau\nLuftverkehrskaufmann/-frau, Kaufmann/-frau Versicherungen & Finanzanlagen\nFachkraft Lagerlogistik, Fachlagerist/in, Personaldienstleistungskaufmann/-frau\nBuchhändler/in, Drogerist/in, Patentanwaltsfachangestellte/r\n\n🏥 GESUNDHEIT & MEDIZIN:\nPflegefachmann/-frau, MFA, ZFA, Notfallsanitäter/in\nPTA (Pharm.-techn. Assistent/in), PKA, MTR (Radiologie), MTL (Labor)\nOTA (OP-techn. Assistent/in), ATA (Anästhesie-techn. Assistent/in)\nHörakustiker/in, Augenoptiker/in, Zahntechniker/in, Orthopädietechnik-Mechaniker/in\nMasseur/in & med. Bademeister/in, Chirurgiemechaniker/in, Orthoptist/in\nFachkraft Medizinprodukteaufbereitung, TFA (Tiermed. Fachangestellte/r)\nKaufmann/-frau im Gesundheitswesen, Desinfektor/in\n\n🔧 HANDWERK:\nKfz-Mechatroniker/in, Mechatroniker/in, Karosserie- & Fahrzeugbaumechaniker/in\nAnlagenmechaniker/in (SHK|Industrie), Elektroniker/in (Energie & Gebäude|Betriebstechnik)\nTischler/in, Maurer/in, Zimmerer/in, Dachdecker/in, Metallbauer/in\nWerkzeugmechaniker/in, Zerspanungsmechaniker/in, Feinwerkmechaniker/in\nIndustriemechaniker/in, Konstruktionsmechaniker/in, Gießereimechaniker/in\nMaler/in & Lackierer/in, Stuckateur/in, Fliesen-/Platten-/Mosaikleger/in\nBeton- & Stahlbetonbauer/in, Oberflächenbeschichter/in, Kälteanlagenbauer/in\nVerfahrensmechaniker/in Kunststoff/Kautschuk, Bootsbauer/in\n\n🌿 NATUR, TIERE & UMWELT:\nGärtner/in (Garten- & Landschaftsbau|Zierpflanzenbau), Landwirt/in, Forstwirt/in\nTierpfleger/in, TFA, Pferdewirt/in, Fischwirt/in, Winzer/in, Revierjäger/in\nPflanzentechnologe/in, Fachkraft Agrarservice, Biologielaborant/in, Chemielaborant/in\nFachkraft (Wasserversorgung|Abwasser|Kreislauf- & Abfallwirtschaft)\nMilchtechnologe/in, Molkereifachmann/-frau, Baumpfleger/in, Brenner/in\n\n🛡️ SICHERHEIT & SCHUTZ:\nPolizeivollzugsdienst mittlerer Dienst (Landes- & Bundespolizei)\nFachkraft für Schutz & Sicherheit, Servicekraft Schutz & Sicherheit\nBrandmeisteranwärter/in (Feuerwehr), Werkfeuerwehrmann/-frau\nJustizfachangestellte/r, Justizvollzugsfacharbeiter/in, Zollbeamte/r (Mittlerer Dienst)\nRettungssanitäter/in, Luftsicherheitsassistent/in, Alarm- & Sicherheitstechniker/in\nElektroniker/in Überwachungssysteme, Bundeswehr Soldat auf Zeit\n\n✈️ LUFT- & RAUMFAHRT:\nFluggerätmechaniker/in (Fertigung|Instandhaltung|Triebwerk), Avioniker/in\nLuftverkehrskaufmann/-frau, Flugbegleiter/in, Fachkraft Bodenabfertigung\nTriebwerkmechaniker/in, Flugzeuglackierer/in, Mechatroniker/in Luftfahrt\nLuftsicherheitskontrollkraft, Luftfahrttechniker/in, Fluglotse/in\n';
        }

        const prompt = `DU bist ein professioneller Karriere- und Studienberater. Analysiere folgende Informationen und erstelle eine detaillierte, personalisierte Karriereberatung auf Deutsch.

🚨 REGEL 0 – PLATZHALTER VERBOTEN:
Dieser Prompt enthält Vorlagen mit Platzhaltern in eckigen Klammern wie [BERUFSBEZEICHNUNG], [Karriereweg 1], [STUDIENGANG], [X], [Konkret] etc.
ALLE diese Platzhalter MÜSSEN durch echte, konkrete Daten ersetzt werden!
❌ NIEMALS einen Platzhalter in eckigen Klammern [ ] in der Ausgabe stehen lassen!
❌ NIEMALS "[Karriereweg 1]" schreiben – immer den echten Berufsnamen!
❌ NIEMALS "[BERUFSBEZEICHNUNG]" in Links lassen – immer den echten Berufsnamen URL-kodiert einsetzen!
❌ NIEMALS "[Konkret]" oder "[X]" stehen lassen – immer echte Zahlen und Namen!
✅ Vor der Ausgabe intern prüfen: Sind noch eckige Klammern [ ] im Text? Wenn ja → ersetzen!


📋 GENEHMIGTE BERUFSLISTEN – NUR AUS DER PASSENDEN LISTE WÄHLEN!
→ ABITUR: NUR 🟣 Uni-Studiengänge
→ FACHABITUR: NUR 🔵 Duale Studiengänge/FH
→ REALSCHULE/HAUPTSCHULE: NUR 🟢 Ausbildungsberufe

${berufsliste}

🚨 WICHTIGSTE REGEL DES GESAMTEN PROMPTS:
SCHRITT 1: Suche zuerst IMMER in der untenstehenden Liste nach passenden Berufen!
SCHRITT 2: Nur wenn nach ernsthafter Suche KEIN einziger Beruf aus der Liste passt → darfst du einen anderen wählen.
SCHRITT 3: Wenn du abweichst → der Beruf MUSS offiziell in Deutschland existieren, als Ausbildung/Studium anerkannt sein und du musst sicher sein dass er real ist.

❌ VERBOTEN: Berufe erfinden, englische Jobtitel ohne deutsche Entsprechung, vage Rollenbezeichnungen
❌ VERBOTEN: Direkt einen eigenen Beruf wählen OHNE zuerst die Liste zu durchsuchen
✅ PFLICHT: Liste zuerst durchsuchen → dann entscheiden

═══════════════════════════════════════════════
🛡️ SICHERHEIT & SCHUTZ
═══════════════════════════════════════════════
Polizei (Bund & Länder):
- Polizeimeister-Anwärter (Ausbildung, Mittlerer Dienst)
- Polizeikommissar-Anwärter (Duales Studium, Gehobener Dienst)
- Kriminalkommissar-Anwärter (Duales Studium, Direkteinstieg Kripo/BKA)
- Polizeirat-Anwärter (Studium, Höherer Dienst)
- Cyber-Kriminalist (Duales Studium oder IT-Studium)

Bundeswehr:
- Soldat in der Mannschaftslaufbahn
- Unteroffizier im Fachdienst
- Feldwebelanwärter (Führungskraft Truppen-/Fachdienst)
- Offizieranwärter (Studium Bundeswehr-Universität)
- Sanitätsoffizier-Anwärter (Medizin/Zahnmedizin über Bundeswehr)

Zoll & Justiz:
- Finanzwirt beim Zoll (Ausbildung, Mittlerer Dienst)
- Diplom-Finanzwirt beim Zoll (Duales Studium, Gehobener Dienst)
- Justizvollzugsfachangestellter (Ausbildung)
- Vollzugs- und Verwaltungsinspektor (Duales Studium JVA)
- Gerichtsvollzieher-Anwärter

Rettung & Brandschutz:
- Notfallsanitäter (Ausbildung)
- Brandmeister-Anwärter (Ausbildung, Mittlerer Dienst)
- Brandoberinspektor-Anwärter (Duales Studium, Gehobener Dienst)
- Fachkraft für Schutz und Sicherheit (Ausbildung)
- Luftsicherheitsassistent (Ausbildung, Flughafen)

═══════════════════════════════════════════════
🔨 HANDWERK
═══════════════════════════════════════════════
- Anlagenmechaniker SHK
- Fachkraft für Wasserversorgungstechnik
- Fachkraft für Abwassertechnik (Sanitär, Heizung, Klima)
- Elektroniker für Energie- und Gebäudetechnik
- Elektroniker für Betriebstechnik
- Elektroniker für Automatisierungstechnik
- Elektroniker für Geräte und Systeme
- Mechatroniker
- Tischler / Schreiner
- Maurer
- Zimmerer
- Dachdecker
- Maler und Lackierer
- Kfz-Mechatroniker
- Metallbauer (Konstruktionstechnik)
- Feinwerkmechaniker
- Zerspanungsmechaniker
- Werkzeugmechaniker
- Konstruktionsmechaniker
- Chemikant
- Oberflächenbeschichter
- Verfahrensmechaniker für Kunststoff- und Kautschuktechnik
- Textillaborant
- Baustoffprüfer
- Papiertechnologe
- Packmitteltechnologe
- Mechatroniker für Kältetechnik
- Mikrotechnologe
- Hörakustiker
- Augenoptiker
- Orthopädietechnik-Mechaniker
- Zahntechniker
- Bäcker
- Konditor
- Fleischer / Metzger
- Goldschmied
- Büchsenmacher
- Edelsteinschleifer
- Holzbildhauer
- Sattler
- Segelmacher
- Leichtflugzeugbauer
- Bestattungsfachkraft
- Raumausstatter
- Friseur
- Parkettleger
- Fliesen-, Platten- und Mosaikleger
- Stuckateur
- Straßenbauer
- Land- und Baumaschinenmechatroniker
- Karosserie- und Fahrzeugbaumechaniker
- Informationselektroniker

═══════════════════════════════════════════════
💻 TECHNOLOGIE & LUFT-/RAUMFAHRT
═══════════════════════════════════════════════
IT & Computer:
- Fachinformatiker für Systemintegration
- Fachinformatiker für Anwendungsentwicklung
- Fachinformatiker Anwendungsentwicklung
- Fachinformatiker für Systemintegration
- Fachinformatiker für Anwendungsentwicklung
- Fachinformatiker Systemintegration
- Fachinformatiker für Systemintegration
- Fachinformatiker für Anwendungsentwicklung
- Fachinformatiker Daten- und Prozessanalyse
- Fachinformatiker für Systemintegration
- Fachinformatiker für Anwendungsentwicklung
- Fachinformatiker Digitale Vernetzung
- Mathematisch-technischer Softwareentwickler (MaTSE)
- Duales Studium Informatik (B.Sc.)
- Duales Studium Wirtschaftsinformatik (B.Sc.)
- Duales Studium IT-Sicherheit (B.Sc.)
- Duales Studium Data Science (B.Sc.)
- IT-System-Kaufmann
- Kaufmann für Digitalisierungsmanagement
- Elektroniker für Informations- und Systemtechnik
- Systeminformatiker

Luft- & Raumfahrt:
- Fluggerätmechaniker (Fertigungs- oder Instandhaltungstechnik)
- Fluggerätelektroniker
- Fluglotse (DFS-Ausbildung)
- Verkehrspilot (Flugschule/Airline)
- Duales Studium Luft- und Raumfahrttechnik (B.Eng.)
- Duales Studium Luftverkehrsmanagement (B.A.)
- Werkstoffprüfer (Metalltechnik)
- Industriemechaniker (Luftfahrt-Fokus)

═══════════════════════════════════════════════
🎨 KREATIVITÄT & DESIGN
═══════════════════════════════════════════════
- Mediengestalter Digital und Print
- Mediengestalter Bild und Ton
- Gestalter für immersive Medien (VR/AR)
- Technischer Produktdesigner
- Grafikdesigner
- Game Designer
- 3D-Artist / Visual Effects Artist
- Fotograf
- Duales Studium Mediendesign (B.A.)
- Duales Studium Architektur (B.A.)
- Innenarchitekt
- Modedesigner
- Maßschneider
- Bühnenmaler und Bühnenplastiker
- Maskenbildner
- Gestalter für visuelles Marketing
- Kaufmann für Marketingkommunikation
- Bauzeichner
- Cutter / Film- und Videoeditor
- Motion Designer
- Webdesigner
- Interface Designer
- Produktdesigner
- Veranstaltungskaufmann
- Florist
- Duales Studium Digitale Medien (B.A.)

═══════════════════════════════════════════════
👥 ARBEIT MIT MENSCHEN (Pädagogik & Soziales)
═══════════════════════════════════════════════
- Erzieher (Fachschule)
- Sozialpädagogischer Assistent / Kinderpfleger
- Sozialarbeiter (Studium/Duales Studium)
- Heilerziehungspfleger
- Pflegefachmann / Pflegefachfrau
- Logopäde
- Physiotherapeut
- Ergotherapeut
- Duales Studium Soziale Arbeit (B.A.)
- Duales Studium Kindheitspädagogik (B.A.)
- Duales Studium Pflege (B.Sc.)
- Fachangestellter für Arbeitsmarktdienstleistungen (Arbeitsagentur)
- Duales Studium Arbeitsmarktmanagement (B.A.)
- Lehramt (Grundschule/Sekundarstufe)
- Sonderpädagoge
- Kaufmann im Gesundheitswesen
- Sozialversicherungsfachangestellter
- Hebamme (Duales Studium)
- Sport- und Fitnesskaufmann
- Duales Studium Fitnessökonomie (B.A.)
- Duales Studium Gesundheitsmanagement (B.A.)
- Psychologe (Studium)

═══════════════════════════════════════════════
💰 WIRTSCHAFT & FINANZEN
═══════════════════════════════════════════════
- Bankkaufmann
- Duales Studium Banking and Finance (B.A.)
- Industriekaufmann
- Kaufmann für Versicherungen und Finanzanlagen
- Duales Studium Versicherungswirtschaft (B.A.)
- Immobilienkaufmann
- Duales Studium Immobilienmanagement (B.A.)
- Kaufmann für Groß- und Außenhandelsmanagement
- Kaufmann im Groß- und Außenhandelsmanagement
- Verkäufer
- Kaufmann im Einzelhandel
- Kaufmann im E-Commerce
- Duales Studium BWL-Handel (B.A.)
- Steuerfachangestellter
- Duales Studium Steuern und Prüfungswesen (B.A.)
- Kaufmann für Büromanagement
- Automobilkaufmann
- Duales Studium Controlling / Finanzmanagement (B.A.)
- Finanzwirt (Finanzamt)
- Kaufmann für Spedition und Logistikdienstleistung
- Duales Studium Logistikmanagement (B.A.)
- Personaldienstleistungskaufmann
- Kaufmann für Tourismus und Freizeit
- Duales Studium Tourismusmanagement (B.A.)
- Eventmanager (Duales Studium)
- Duales Studium Wirtschaftspsychologie (B.Sc.)
- Duales Studium International Business (B.A.)
- Sozialversicherungsfachangestellter
- Investmentfondskaufmann
- Kaufmann für IT-System-Management
- Kaufmann für Digitalisierungsmanagement

═══════════════════════════════════════════════
🏥 GESUNDHEIT & MEDIZIN
═══════════════════════════════════════════════
- Pflegefachmann / Pflegefachfrau
- Medizinischer Fachangestellter (MFA)
- Zahnmedizinischer Fachangestellter (ZFA)
- Pharmazeutisch-technischer Assistent (PTA)
- Pharmazeutisch-kaufmännischer Angestellter (PKA)
- Medizinischer Technologe für Laboratoriumsanalytik (MTL)
- Medizinischer Technologe für Radiologie (MTR)
- Anästhesietechnischer Assistent (ATA)
- Operationstechnischer Assistent (OTA)
- Chirurgiemechaniker
- Notfallsanitäter
- Physiotherapeut
- Ergotherapeut
- Logopäde
- Hebamme (Duales Studium)
- Duales Studium Medizintechnik (B.Eng.)
- Duales Studium Gesundheitsökonomie (B.A.)
- Orthopädietechnik-Mechaniker
- Zahntechniker
- Hörakustiker
- Augenoptiker
- Diätassistent
- Masseur und medizinischer Bademeister
- Podologe
- Duales Studium Physician Assistant (B.Sc.)
- Tierärztlicher Fachangestellter
- Pharmakant
- Biologielaborant
- Chemielaborant
- Duales Studium Ergotherapie (B.Sc.)
- Duales Studium Logopädie (B.Sc.)

═══════════════════════════════════════════════
🌿 NATUR, TIERE & UMWELT
═══════════════════════════════════════════════
- Tierpfleger (Zoo / Forschung / Heim)
- Tiermedizinischer Fachangestellter
- Forstwirt
- Gärtner (Garten- und Landschaftsbau)
- Gärtner (Zierpflanzen / Baumschule / Gemüse)
- Landwirt
- Pferdewirt
- Fischwirt
- Revierjäger
- Winzer
- Biologielaborant
- Biologisch-technischer Assistent (BTA)
- Umwelttechnologe für Wasserversorgung
- Umwelttechnologe für Abwasserbewirtschaftung
- Umwelttechnologe für Kreislauf- und Abfallwirtschaft
- Umweltschutztechnischer Assistent (UTA)
- Duales Studium Umweltingenieurwesen (B.Eng.)
- Duales Studium Nachhaltiges Management (B.A.)
- Duales Studium Agrarmanagement (B.A.)
- Duales Studium Landschaftsarchitektur (B.Eng.)
- Forstinspektor-Anwärter (Duales Studium, Gehobener Dienst)
- Geomatiker
- Milchtechnologe
- Pflanzentechnologe
- Fachkraft für Agrarservice
- Wasserbauer
- Florist
- Duales Studium Forstwirtschaft (B.Sc.)
- Duales Studium Ökotrophologie (B.Sc.)

═══════════════════════════════════════════════
⚽ SPORT & FITNESS
═══════════════════════════════════════════════
- Sport- und Fitnesskaufmann (Ausbildung)
- Fitnesstrainer inkl. Lizenz A/B/Personal Trainer (Ausbildung)
- Fachkraft für Bäderbetriebe / Schwimmmeister (Ausbildung)
- Fahrradmonteur / Zweiradmechatroniker Fahrradtechnik (Ausbildung)
- Gymnstiklehrer (Schulische Ausbildung)
- Tanzpädagoge (Ausbildung)
- Yogalehrer / Pilates-Trainer (Zertifizierte Ausbildung)
- Kaufmann für Sportartikelmarketing (Ausbildung)
- Skilehrer / Snowboardlehrer (Staatlich geprüfte Ausbildung)
- Golflehrer / Pro (Ausbildung PGA)
- Bergführer (Staatliche Ausbildung)
- Klettertrainer (Ausbildung)
- Outdoor- und Erlebnispädagoge (Ausbildung)
- Physiotherapeut mit Sport-Fokus (Ausbildung)
- Fitnessökonom (Duales Studium B.A.)
- Sportökonom (Duales Studium B.A.)
- Pferdesportmanager (Duales Studium)
- Präventions- und Gesundheitsmanager (Duales Studium)
- Duales Studium Sportbusiness Management (B.A.)
- Duales Studium Fitnesswissenschaft (B.A.)
- Duales Studium Coaching & Training (B.A.)
- Vereinsmanager (Duales Studium)
- Eventmanager für Sportveranstaltungen (Duales Studium)
- Sportmanager (Studium / Duales Studium)
- Angewandte Sportwissenschaft (Studium B.Sc.)
- Lehramt Sport (Studium Gymnasium/Real/Grundschule)
- Sporttherapeut (Studium / Weiterbildung nach Physio)
- Sportjournalist (Studium / Volontariat)
- Rehabilitationspädagoge (Studium)
- Athletiktrainer (Studium / Spezialisierung)
- Sportpsychologe (Studium Psychologie + Master Sport)
- Leistungsdiagnostiker (Studium Sportwissenschaft)
- E-Sports Manager (Studium / Spezialisierung)
- Fußballkaufmann (Spezialisiertes Studium)
- Ernährungsberater Sport-Fokus (Ausbildung / Studium)
- Berufssportler (Nachwuchsleistungszentrum / Kader)
- Sportausbilder Bundeswehr (Feldwebel / Offizier Laufbahn)

═══════════════════════════════════════════════
🍽️ GASTRONOMIE & HOTELLERIE
═══════════════════════════════════════════════
- Koch / Köchin (Ausbildung)
- Fachkraft für Gastronomie (2-jährige Ausbildung)
- Fachkraft Küche (2-jährige Ausbildung)
- Konditor (Ausbildung)
- Fachverkäufer im Lebensmittelhandwerk Bäckerei/Konditorei (Ausbildung)
- Hotelfachmann (Ausbildung)
- Fachmann für Systemgastronomie (Ausbildung)
- Kaufmann für Hotelmanagement (Ausbildung)
- Restaurant- und Veranstaltungsgastronom (Ausbildung)
- Fachmann für Restaurants und Eventcatering (Ausbildung)
- Hauswirtschafter (Ausbildung)
- Rezeptionsfachkraft / Front Office Manager (Ausbildung Hotelfach)
- Flugbegleiter / Stewardess (Ausbildung Airline)
- Check-in Agent / Servicekaufmann Luftverkehr (Ausbildung)
- Veranstaltungskaufmann (Ausbildung)
- Weintechnologe (Ausbildung)
- Brauer und Mälzer (Ausbildung)
- Fachkraft für Speiseeis (Ausbildung)
- Assistent für Ernährung und Versorgung (Ausbildung)
- Eventgastronom (Ausbildung)
- Barista / Café-Fachkraft (Ausbildung / Spezialisierung)
- Tourismuskaufmann Privat- und Geschäftsreisen (Ausbildung)
- Duales Studium Hotelmanagement (B.A.)
- Duales Studium Tourismusmanagement (B.A.)
- Duales Studium Culinary Management (B.A.)
- Duales Studium Food Management (B.A.)
- Duales Studium Hospitality Management (B.A.)
- Duales Studium International Tourism Management (B.A.)
- Hotelbetriebswirt (Fachschule nach Ausbildung)
- Catering-Manager (Studium / Duales Studium)
- Revenue Manager (Studium / Duales Studium)
- Sommelier (Spezialisierung nach Ausbildung)
- Pâtissier (Spezialisierter Konditor / Koch)
- Küchenchef-Anwärter / Kochmeister (Meisterausbildung)

═══════════════════════════════════════════════
🚚 LOGISTIK, TRANSPORT & VERKEHR
═══════════════════════════════════════════════
- Fachkraft für Lagerlogistik (Ausbildung)
- Fachlagerist (2-jährige Ausbildung)
- Berufskraftfahrer LKW (Ausbildung)
- Berufskraftfahrer Personenverkehr / Busfahrer (Ausbildung)
- Eisenbahner im Betriebsdienst / Lokführer (Ausbildung)
- Eisenbahner in der Zugverkehrssteuerung / Fahrdienstleiter (Ausbildung)
- Kaufmann für Verkehrsservice Bahn/ÖPNV (Ausbildung)
- Fachkraft für Kurier-, Express- und Postdienstleistungen KEP (Ausbildung)
- Kaufmann für Kurier-, Express- und Postdienstleistungen (Ausbildung)
- Kaufmann für Spedition und Logistikdienstleistung (Ausbildung)
- Schiffsmechaniker (Ausbildung)
- Binnenschiffer (Ausbildung)
- Fachkraft für Hafenlogistik (Ausbildung)
- Cargo-Agent / Luftfrachtkaufmann (Ausbildung)
- Fachkraft für Möbel-, Küchen- und Umzugsservice (Ausbildung)
- Terminal-Operator Hafen/Schiene (Ausbildung)
- Servicefahrer (Ausbildung)
- Duales Studium Logistikmanagement (B.A.)
- Duales Studium Supply Chain Management (B.Sc.)
- Duales Studium Transport-Wirtschaft-Logistik (B.A.)
- Duales Studium Mobilitätsmanagement (B.A.)
- Duales Studium Luftverkehrsmanagement (B.A.)
- Duales Studium Nautik / Seefahrtstudium (B.Sc.)
- Duales Studium Bahnsystemingenieurwesen (B.Eng.)
- Duales Studium Aviation Management (B.A.)
- Verkehrsplaner (Studium / Duales Studium)
- Disponent (Einstieg über Speditionskaufmann)
- Fuhrparkmanager (Einstieg über Kaufmann Spedition / Logistik)
- Lagerleiter (Einstieg über Fachkraft Lagerlogistik + Meister)

═══════════════════════════════════════════════
🏛️ VERWALTUNG, MEDIEN & KOMMUNIKATION
═══════════════════════════════════════════════
Öffentlicher Dienst & Verwaltung:
- Verwaltungsfachangestellter
- Patentanwaltsfachangestellter (Ausbildung)
- Verwaltungswirt / Beamter Mittlerer Dienst (Vorbereitungsdienst)
- Justizfachangestellter (Ausbildung bei Gericht)
- Notarfachangestellter (Ausbildung)
- Rechtsanwaltsfachangestellter (Ausbildung)
- Steuerfachangestellter (Ausbildung)
- Fachangestellter für Medien- und Informationsdienste
- Dolmetscher / Übersetzer (Staatlich geprüft) Archiv/Bib (Ausbildung)
- Sozialversicherungsfachangestellter (Ausbildung)
- Stadtsekretär-Anwärter Mittlerer Dienst Kommune (Vorbereitungsdienst)
- Diplom-Verwaltungswirt / Beamter Gehobener Dienst (Duales Studium)
- Stadtinspektor-Anwärter Gehobener Dienst Kommune (Duales Studium)
- Duales Studium Öffentliche Verwaltung / Public Administration (B.A.)
- Verwaltungsinformatiker (Duales Studium B.Sc.)
- Duales Studium Management Soziale Sicherheit (B.A.)
- Duales Studium Steuern und Prüfungswesen (B.A.)

Medien & Kommunikation:
- Medienkaufmann Digital und Print (Ausbildung)
- Kaufmann für audiovisuelle Medien (Ausbildung)
- Mediengestalter Digital und Print (Ausbildung)
- Mediengestalter Bild und Ton (Ausbildung)
- Medientechnologe Druck (Ausbildung)
- Medientechnologe Siebdruck (Ausbildung)
- Medientechnologe Druckverarbeitung (Ausbildung)
- Fotomedienfachmann (Ausbildung)
- Kaufmann für Marketingkommunikation (Ausbildung)
- Fachangestellter für Markt- und Sozialforschung (Ausbildung)
- Veranstaltungskaufmann (Ausbildung)
- PR-Kaufmann / Fachreferent PR (Ausbildung / Studium)
- Social Media Manager (Duales Studium Marketing / Weiterbildung)
- Duales Studium Medienmanagement (B.A.)
- Duales Studium Kommunikationswissenschaft (B.A.)
- Duales Studium Marketing & Digitale Medien (B.A.)
- Duales Studium Corporate Communication (B.A.)
- Duales Studium Wirtschaftskommunikation (B.A.)
- Online Marketing Manager (Duales Studium / Spezialisierung)
- Journalist (Studium + Volontariat / Journalistenschule)
- Redakteur Online/Print/TV (Studium + Volontariat)
- Public Relations Manager (Studium / Duales Studium)
- Content Creator / Strategist (Studium / Marketingkommunikation)
- Copywriter / Werbetexter (Studium / Portfolio)
- Fachjournalist (Spezialisierung im Studium)


🔒 BERUFSLISTEN-ABSCHLUSS-CHECK:
Bevor du einen Beruf empfiehlst – stelle dir diese Frage:
→ "Steht dieser Beruf in meiner genehmigten Liste?"
→ JA → empfehlen ✅
→ NEIN → nochmal suchen. Wirklich nicht drin? → Nur dann selbst wählen, aber MUSS real und offiziell existieren.

🚨 ABSOLUT WICHTIG – NUR HTML AUSGEBEN:
- Antworte AUSSCHLIESSLICH mit fertigem HTML-Code!
- KEIN Markdown! Kein ##, kein ###, kein ---, kein **, kein *
- KEINE Markdown-Überschriften! Nur <h3> und <h4> HTML-Tags!
- KEINE Trennlinien mit ---! Nutze die vorgegebenen HTML-Container!
- Alle Abschnitte in <div class="career-path-card"> oder <div class="section-container">
- Das HTML wird direkt in eine Webseite eingebettet – Markdown würde alles zerstören!

**WICHTIG: Sprich den User DURCHGEHEND mit "DU" an! Keine "Sie"-Form!**

**PERSÖNLICHKEIT BESCHREIBEND EINBAUEN:**
NIEMALS Begriffe wie "Macher", "Denker", "Planer", "Teamplayer", "Kreativer", "Kommunikator" direkt verwenden – das klingt wie eine KI-Kategorie!
Stattdessen die Eigenschaften der Person natürlich beschreiben:
FALSCH: "Als Macher und Denker wirst DU..."
FALSCH: "Als Planer mit Struktur..."
RICHTIG: "DU bist jemand der anpackt und gleichzeitig tief nachdenkt"
RICHTIG: "Deine Fähigkeit, Probleme zu analysieren und sofort umzusetzen, ist selten"
RICHTIG: "DU arbeitest am liebsten strukturiert und hast immer einen Plan"
Die Persönlichkeit soll spürbar sein – durch lebendige Beschreibungen, nicht durch Labels!

PERSÖNLICHE DATEN:
- Alter: ${formData.age}
- Aktuelle Situation: ${Array.isArray(formData.situation) ? formData.situation.join(', ') : formData.situation}
${formData.situation === 'ausbildung' ? `- **AZUBI-KONTEXT:**
  - Ausbildungsberuf: ${formData.ausbildung_beruf || 'k.A.'}
  - Was gefällt nicht: ${Array.isArray(formData.ausbildung_negativ) ? formData.ausbildung_negativ.join(', ') : formData.ausbildung_negativ || 'k.A.'}
  - Was danach geplant: ${formData.ausbildung_danach || 'k.A.'}
  → WICHTIG: Empfehle Wege die auf der Ausbildung aufbauen ODER einen Neustart ermöglichen!
  → KEINE reinen Schüler-Ausbildungsempfehlungen – diese Person ist bereits in Ausbildung!` : ''}
${formData.situation === 'quereinsteiger' ? `- **QUEREINSTEIGER-KONTEXT:**
  - Bisheriger Bereich: ${formData.quer_berufsbereich || 'k.A.'}
  - Was hat nicht gepasst: ${Array.isArray(formData.quer_negativ) ? formData.quer_negativ.join(', ') : formData.quer_negativ || 'k.A.'}
  - Mitgebrachte Qualifikationen: ${Array.isArray(formData.quer_qualifikation) ? formData.quer_qualifikation.join(', ') : formData.quer_qualifikation || 'k.A.'}
  - Gewünschte Richtung: ${formData.quer_richtung === 'idee' ? formData.quer_richtung_freitext : formData.quer_richtung || 'offen'}
  → WICHTIG: Empfehle realistische Umstieg-Wege! Berücksichtige vorhandene Qualifikationen!
  → Zeige konkrete Umschulungen, Weiterbildungen oder Quereinstieg-Möglichkeiten!
  → Empfehle Indeed/Arbeitsagentur statt Azubiyo für Stellensuche!` : ''}
${formData.situation === 'working' ? `- **BERUFSTÄTIG-KONTEXT:**
  - Bisheriger Bereich: ${Array.isArray(formData.berufsbereich) ? formData.berufsbereich.join(', ') : formData.berufsbereich || 'k.A.'}
  - Qualifikationen: ${Array.isArray(formData.qualifikation) ? formData.qualifikation.join(', ') : formData.qualifikation || 'k.A.'}
  - Wechselgrund: ${formData.wechselgrund || 'k.A.'}
  → Wechselgrund IMMER beachten:
    - gehalt/aufstieg → Aufstieg im gleichen Bereich, bessere Position, Spezialisierung
    - sinn/neues → komplett neue Berufe passend zu den gewählten Interessen empfehlen
    - stress/koerper → ähnliche Richtung aber anderes Umfeld, weniger belastende Tätigkeit
  → Was die Person NICHT will (Anti-Job) und was ihr WICHTIG ist (Prioritäten) IMMER berücksichtigen!
  → Realistische Umstieg-Wege zeigen – Weiterbildungen, Umschulungen, Direkteinstieg
  → Indeed/LinkedIn Links statt Azubiyo!` : ''}
${formData.situation === 'unemployed' ? `- **ARBEITSSUCHEND-KONTEXT:**
  - Berufserfahrung vorhanden: ${formData.arbeitssuchend_erfahrung || 'k.A.'}
  - Bisheriger Bereich: ${formData.arbeitssuchend_bereich || 'k.A.'}
  - Qualifikationen: ${Array.isArray(formData.arbeitssuchend_qualifikation) ? formData.arbeitssuchend_qualifikation.join(', ') : formData.arbeitssuchend_qualifikation || 'k.A.'}
  - Priorität bei nächster Stelle: ${Array.isArray(formData.arbeitssuchend_ziel) ? formData.arbeitssuchend_ziel.join(', ') : formData.arbeitssuchend_ziel || 'k.A.'}
  → WICHTIG: Empfehle Jobs die schnell erreichbar sind! Kein langer Ausbildungsweg wenn schnell_einstieg gewählt!
  → Verlinke Indeed und Arbeitsagentur für Stellensuche – KEIN Azubiyo!` : ''}
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

🚨🚨🚨 INTERESSEN = FUNDAMENT DER GESAMTEN ANALYSE 🚨🚨🚨
Die gewählten Interessen (Was interessiert DICH am meisten?) sind die WICHTIGSTE Grundlage für alle 3 Karrierewege!
REGEL: ALLE 3 Karrierewege MÜSSEN aus den gewählten Interessen kommen!
❌ VERBOTEN: Einen Beruf empfehlen der NICHT zu den gewählten Interessen passt!
❌ VERBOTEN: Technik-Interesse → Polizei empfehlen (wenn Sicherheit NICHT gewählt wurde)
❌ VERBOTEN: Sicherheit-Interesse → Fachinformatiker empfehlen (wenn Technik NICHT gewählt wurde)
✅ PFLICHT: Wenn nur "Sicherheit & Schutz" gewählt → ALLE 3 Karrierewege aus dem Sicherheitsbereich!
✅ PFLICHT: Wenn nur "Technologie" gewählt → ALLE 3 aus IT/Tech!
✅ PFLICHT: Wenn mehrere Interessen gewählt → Kombinieren aber NUR aus diesen Bereichen!
Die anderen Fragen (Rolle, Arbeitsstil, Energie etc.) dienen nur zur FEINABSTIMMUNG – sie dürfen NIEMALS die Interessen überschreiben!

REGEL: Anti-Job und Interessen IMMER intelligent kombinieren!
- Interessen (Hauptkategorien): ${Array.isArray(formData.interests) ? formData.interests.join(', ') : formData.interests}
${formData.tech_art ? `- Technologie-Spezifisch: ${Array.isArray(formData.tech_art) ? formData.tech_art.join(', ') : formData.tech_art}` : ''}
${formData.kreativ_art ? `- Kreativität-Spezifisch: ${Array.isArray(formData.kreativ_art) ? formData.kreativ_art.join(', ') : formData.kreativ_art}` : ''}
${formData.business_art ? `- Wirtschaft-Spezifisch: ${Array.isArray(formData.business_art) ? formData.business_art.join(', ') : formData.business_art}` : ''}
${formData.health_art ? `- Gesundheit-Spezifisch: ${Array.isArray(formData.health_art) ? formData.health_art.join(', ') : formData.health_art}` : ''}
${formData.handwerk_art ? `- Handwerk-Spezifisch: ${Array.isArray(formData.handwerk_art) ? formData.handwerk_art.join(', ') : formData.handwerk_art}` : ''}
${formData.menschen_art ? `- Menschen-Spezifisch: ${Array.isArray(formData.menschen_art) ? formData.menschen_art.join(', ') : formData.menschen_art}` : ''}
${formData.natur_art ? `- Natur-Spezifisch: ${Array.isArray(formData.natur_art) ? formData.natur_art.join(', ') : formData.natur_art}` : ''}
${formData.security_art ? `- **SICHERHEIT-SPEZIFISCH: ${Array.isArray(formData.security_art) ? formData.security_art.join(', ') : formData.security_art}** ← DIREKTE BERUFE IM ÖFFENTLICHEN DIENST! (polizei=Polizeibeamter, bundeswehr=Zeitsoldat/Berufssoldat, feuerwehr=Berufsfeuerwehr, zoll=Zollbeamter, rettung=Notfallsanitäter)` : ''}
${formData.aviation_art ? `- **LUFTFAHRT-SPEZIFISCH: ${Array.isArray(formData.aviation_art) ? formData.aviation_art.join(', ') : formData.aviation_art}** ← DIREKTE LUFTFAHRTBERUFE! (pilot=Verkehrspilot/Militärpilot, technik=Fluggerätemechaniker, flugsicherung=Fluglotse, raumfahrt=Luft- und Raumfahrttechniker, militar=Militärpilot/Luftwaffenoffizier)` : ''}

🚨 KOMBINATIONS-REGEL FÜR UNTERPUNKTE:
- Die Unterpunkte sind die PRÄZISEN Interessen – diese MÜSSEN direkt in konkrete Berufe übersetzt werden!
- NIEMALS allgemeine Berufe empfehlen wenn spezifische Unterpunkte vorhanden sind!
- Beispiel: security=polizei + interests=business → Zollbeamter (kombiniert beides!) ODER Karriereweg 1: Landespolizist + Karriereweg 2: Steuerfachangestellter
- Beispiel: security=feuerwehr + health=notfall → Berufsfeuerwehr + Notfallsanitäter als separate Karrierewege
- 🚫 ABSOLUT VERBOTEN wenn security_art gesetzt: Eventmanager, Sicherheitsbeauftragter, Hausmeister, Ordnungsdienst, Wachmann, Sicherheitsmitarbeiter, Ausbildung bei Sicherheitsunternehmen, privater Sicherheitsdienst, Securitas, KÖTTER, Detektiv – NIEMALS private Sicherheitsfirmen empfehlen!
- ✅ PFLICHT wenn security_art gesetzt: NUR Berufe im öffentlichen Dienst / staatliche Institutionen:
  * polizei → Polizeibeamter (Bund oder Land), Kriminalbeamter, Polizeivollzugsbeamter
  * bundeswehr → Laufbahn Mannschaft, Laufbahn Feldwebel, Laufbahn Offizier (abhängig vom Schulabschluss: Mannschaft=kein Abi nötig, Feldwebel=Mittlere Reife+, Offizier=Abitur) – WICHTIG: Als konkreten Schritt immer Termin beim Karrierecenter der Bundeswehr empfehlen (bundeswehr-karriere.de/karrierecenter) – NIEMALS einfach "Zeitsoldat" schreiben!
  * feuerwehr → Berufsfeuerwehrmann/-frau, Brandmeister, Feuerwehrtechniker
  * zoll → Zollbeamter, Zollfahnder, Hauptzollamtsinspektor
  * rettung → Notfallsanitäter, Rettungsassistent, Feuerwehr-Sanitäter
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


═══════════════════════════════════════════════
🟣 UNI-STUDIENGÄNGE (nur mit Abitur)
═══════════════════════════════════════════════
- Humanmedizin (Staatsexamen)
- Rechtswissenschaft / Jura (Staatsexamen)
- Zahnmedizin (Staatsexamen)
- Pharmazie (Staatsexamen)
- Lehramt an Gymnasien (Staatsexamen)
- Informatik (B.Sc./M.Sc.)
- Psychologie (B.Sc./M.Sc.)
- Wirtschaftsinformatik (B.Sc.)
- Wirtschaftsingenieurwesen (B.Sc.)
- Betriebswirtschaftslehre / BWL (B.Sc.)
- Maschinenbau (B.Sc.)
- Elektrotechnik & Informationstechnik (B.Sc.)
- Wirtschaftswissenschaften (B.Sc.)
- Mathematik (B.Sc.)
- Physik (B.Sc.)
- Bauingenieurwesen (B.Sc.)
- Biologie (B.Sc.)
- Politikwissenschaft (B.A.)
- Soziologie (B.A.)
- Erziehungswissenschaft / Pädagogik (B.A.)
- Architektur (B.Sc.)
- Data Science (B.Sc./M.Sc.)
- Volkswirtschaftslehre / VWL (B.Sc.)
- Luft- und Raumfahrttechnik (B.Sc.)
- Chemie (B.Sc.)
- Biotechnologie (B.Sc.)
- Wirtschaftspsychologie (B.Sc.)
- Kommunikationswissenschaft (B.A.)
- Philosophie (B.A.)
- Germanistik (B.A.)
- Anglistik / Amerikanistik (B.A.)
- Geschichte (B.A.)
- Medizintechnik (B.Sc.)
- Mechatronik (B.Sc.)
- Internationale Beziehungen (B.A.)
- Molekulare Medizin (B.Sc.)
- Geowissenschaften (B.Sc.)
- Agrarwissenschaften (B.Sc.)
- Umweltwissenschaften (B.Sc.)
- Cyber Security (B.Sc.)
- Nanotechnologie (B.Sc.)
- Künstliche Intelligenz (B.Sc./M.Sc.)
- Human Resources Management (B.A.)
- Marketing Management (B.A.)
- Finanzmathematik (B.Sc.)
- Neurowissenschaften (B.Sc.)
- Sportwissenschaft (B.Sc.)
- Kulturwissenschaften (B.A.)
- Medienwissenschaften (B.A.)
- Sonderpädagogik (Staatsexamen/B.A.)
- Tiermedizin (Staatsexamen)
- Bioinformatik (B.Sc.)
- Verfahrenstechnik (B.Sc.)
- Wirtschaftsrecht (B.A.)
- Theater-, Film- und Fernsehwissenschaft (B.A.)
- Religionswissenschaft / Theologie (B.A.)
- Archäologie (B.A.)
- Renewable Energy Systems (B.Sc.)
- Computational Engineering (B.Sc.)

═══════════════════════════════════════════════
🔵 FH-STUDIENGÄNGE (mit Fachabitur oder Abitur)
═══════════════════════════════════════════════
- Soziale Arbeit (B.A.)
- Betriebswirtschaftslehre / BWL praxisorientiert (B.A.)
- Wirtschaftsinformatik mit Projektsemester (B.Sc.)
- Maschinenbau anwendungsorientiert (B.Eng.)
- Wirtschaftsingenieurwesen (B.Eng.)
- Angewandte Informatik (B.Sc.)
- Bauingenieurwesen / Baumanagement (B.Eng.)
- Elektrotechnik / Automatisierungstechnik (B.Eng.)
- Wirtschaftspsychologie Anwendung HR/Marketing (B.Sc.)
- Kindheitspädagogik (B.A.)
- Pflegewissenschaft / Pflegemanagement (B.Sc.)
- Physiotherapie akademisiert (B.Sc.)
- Logistik & Supply Chain Management (B.Sc.)
- Digital Business (B.A.)
- Mediendesign (B.A.)
- Tourismusmanagement (B.A.)
- Immobilienwirtschaft (B.Sc.)
- Gesundheitsmanagement (B.Sc.)
- Automotive Engineering / Fahrzeugtechnik (B.Eng.)
- Umwelttechnik / Erneuerbare Energien (B.Eng.)
- Kommunikationsdesign (B.A.)
- Gartenbau / Landschaftsarchitektur (B.Sc.)
- Mechatronik Roboter-Schwerpunkt (B.Eng.)
- Lebensmitteltechnologie (B.Sc.)
- Wirtschaftsrecht (LL.B.)
- Öffentliche Verwaltung (B.A.)
- Eventmanagement (B.A.)
- Polizeivollzugsdienst FH (Duales Studium)
- Gebäudetechnik / Facility Management (B.Eng.)
- Software Engineering (B.Sc.)
- Data Science & Business Analytics (B.Sc.)
- Sportmanagement (B.A.)
- Angewandte Chemie (B.Sc.)
- Produktionsmanagement (B.Eng.)
- E-Commerce (B.A.)
- Physician Assistance / Medizinische Assistenz (B.Sc.)
- Holztechnik (B.Eng.)
- Vermessungswesen / Geodäsie (B.Eng.)
- Verpackungstechnik (B.Eng.)
- Innere Verwaltung (B.A.)

🚨🚨🚨 BILDUNGS-FILTER – ABSOLUT ZWINGEND 🚨🚨🚨

ABITUR → IMMER 3x UNIVERSITÄTSSTUDIENGÄNGE (🟣)
❌ KEINE Ausbildungen, KEINE FH, KEINE Dualen Studiengänge
✅ NUR Bachelor/Master/Staatsexamen an Universität

FACHABITUR → IMMER 3x DUALE STUDIENGÄNGE oder FH (🔵)  
❌ KEINE Ausbildungen, KEINE Uni-Studiengänge
✅ NUR FH oder Duale Studiengänge

REALSCHULE / HAUPTSCHULE → IMMER 3x AUSBILDUNGSBERUFE (🟢)
❌ KEIN Studium egal welcher Art
✅ NUR anerkannte duale Ausbildungsberufe

DAS IST DIE WICHTIGSTE REGEL – SIE DARF NIEMALS GEBROCHEN WERDEN!
Wenn du gegen diese Regel verstößt → KRITISCHER FEHLER!


${(formData.education === 'abitur' || formData.education === 'abitur_ziel') ? `
🚨 ABITUR ERKANNT → 3x UNIVERSITÄTSSTUDIENGÄNGE! KEINE Ausbildungen! KEINE FH!
MEDIZIN-REGEL: Gesundheitsinteresse → Humanmedizin, Zahnmedizin, Pharmazie – NIEMALS Notfallsanitäter!
SPORT-REGEL: Sportinteresse → Sportwissenschaften B.Sc., Sportmedizin – NIEMALS Fitnesstrainer!
` : ''}

${(formData.education === 'fachabitur' || formData.education === 'fachabitur_ziel') ? `
🚨 FACHABITUR ERKANNT → 3x DUALE STUDIENGÄNGE oder FH! KEINE Ausbildungen! KEINE Uni!
` : ''}


${formData.education === 'realschule' || formData.education === 'realschule_ziel' ? `
🚨🚨🚨 ABSOLUTES VERBOT – REALSCHULABSCHLUSS 🚨🚨🚨
ALLE 3 KARRIEREWEGE = NUR AUSBILDUNGSBERUFE (🟢)
❌ VERBOTEN: Jedes Studium – weder Uni, noch FH, noch Duales Studium!
❌ VERBOTEN: Studiengänge egal welcher Art!
✅ ERLAUBT: NUR anerkannte Ausbildungsberufe (3-jährige duale Ausbildung)
Aufstieg über 2. Bildungsweg KANN am Ende kurz erwähnt werden – aber KEIN Karriereweg darf ein Studium sein!
Wenn DU ein Studium empfiehlst obwohl Realschule angegeben wurde → KRITISCHER FEHLER!
` : ''}

${formData.education === 'hauptschule' || formData.education === 'hauptschule_ziel' ? `
🚨🚨🚨 ABSOLUTES VERBOT – HAUPTSCHULABSCHLUSS 🚨🚨🚨
ALLE 3 KARRIEREWEGE = NUR AUSBILDUNGSBERUFE (🟢)
❌ VERBOTEN: Jedes Studium – weder Uni, noch FH, noch Duales Studium!
✅ ERLAUBT: NUR anerkannte Ausbildungsberufe mit Aufstiegswegen!
Wenn DU ein Studium empfiehlst obwohl Hauptschule angegeben wurde → KRITISCHER FEHLER!
` : ''}

${(formData.education === 'school' || formData.situation === 'school') && (formData.schul_situation === 'klasse5_10' || formData.education === 'hauptschule_ziel' || formData.education === 'realschule_ziel') && formData.education !== 'abitur_ziel' && formData.education !== 'fachabitur_ziel' ? `
🚨🚨🚨 ABSOLUTES VERBOT – SCHÜLER KLASSE 5-10 OHNE ABI-ZIEL 🚨🚨🚨
ALLE 3 KARRIEREWEGE = NUR AUSBILDUNGSBERUFE!
❌ VERBOTEN: Jedes Studium!
` : ''}

${(formData.education === 'fachabitur_ziel') ? `
🚨 FACHABITUR-ZIEL ERKANNT → KW1, KW2 und KW3 = NUR Duale Studiengänge oder FH! KEINE Ausbildungen! KEINE Uni!
` : (formData.education === 'abitur_ziel') ? `
🚨 ABITUR-ZIEL ERKANNT → KW1, KW2 und KW3 = NUR Universitätsstudiengänge! KEINE Ausbildungen! KEINE FH!
` : ((formData.education === 'school' || formData.situation === 'school') && formData.schul_situation === 'oberstufe') ? `
🚨 OBERSTUFE ERKANNT → Mindestens 2 von 3 Karrierewege = Studiengänge!
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
   - Wichtige Eigenschaften und Stärken in WEISSEN GROSSBUCHSTABEN hervorheben: <strong style="color: #ffffff; text-transform: uppercase; letter-spacing: 0.5px;">ANALYTISCH</strong>
   - NIEMALS Begriffe wie MACHER, DENKER, PLANER, TEAMPLAYER als Labels verwenden!
   - Stattdessen die Eigenschaft beschreiben: z.B. ANALYTISCH, STRUKTURIERT, KREATIV, ZIELSTREBIG
   - Normaler Fließtext bleibt weiß (#ffffff)
   - Orange (#f77f00) NUR für den Titel und den abschließenden Hinweis-Satz
   - NIEMALS dunkelgrün für Hervorhebungen – das ist auf grünem Hintergrund nicht lesbar!]
    [HIER 4-6 Sätze die BEWEISEN dass die KI den User wirklich kennt. PFLICHTREGELN:
    
    1. NIEMALS generisch! Nicht "Du bist kreativ" – das könnte für jeden stehen!
    2. MINDESTENS 2 konkrete Antworten aus dem Fragebogen direkt verknüpfen und erklären warum die Kombination besonders ist
    3. Eigenschaften BESCHREIBEND einbauen – NIEMALS als Labels wie "Macher" oder "Denker"!
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
     <a href="https://www.azubiyo.de/stellenmarkt/?q=[BERUFSBEZEICHNUNG]&ort=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #7c3aed;">🎓 Azubiyo</a>
   </div>

   WENN ÖFFENTLICHER DIENST (Verwaltung, Zoll, Polizei, Bundeswehr, Bundesbehörden):
   <h4>📍 Stellen im öffentlichen Dienst in ${location}:</h4>
   <div class="job-search-buttons">
     <a href="https://www.bund.de/DE/Service/Stellen/stellen_node.html" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🇩🇪 Bund.de – Bundesstellen</a>
     <a href="https://www.arbeitsagentur.de/jobsuche/suche?was=[BERUFSBEZEICHNUNG]&wo=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #1a4d2e;">🏛️ Arbeitsagentur</a>
     <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+öffentlicher+Dienst+${locationEncoded}&ibp=htl;jobs" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">🔍 Google Jobs</a>
     <a href="https://www.ausbildung.de/berufe/suche/?q=[BERUFSBEZEICHNUNG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #64748b;">📋 Ausbildung.de – Berufsprofil</a>
   </div>

   WENN STUDIUM:
   <h4>📍 Studiengänge finden in ${location}:</h4>
   <div class="job-search-buttons">
     <a href="https://www.google.com/search?q=[STUDIENGANG]+Studium+${location}" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🎓 Google – Studiengang suchen</a>
     <a href="https://www.studycheck.de/suche?q=[STUDIENGANG]&location=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📚 StudyCheck</a>
     <a href="https://www.google.com/search?q=[STUDIENGANG]+Studium+Deutschland+Hochschule+site:hochschulkompass.de" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #7c3aed;">🏛️ Hochschulkompass</a>
     <a href="https://www.google.com/search?q=[STUDIENGANG]+duales+Studium+${location}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Duales Studium</a>
     <a href="https://www.ausbildung.de/duales-studium/suche/?q=[STUDIENGANG]&where=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #7c3aed;">🔵 Freie Duale Plätze – ausbildung.de</a>
     <a href="https://www.hochschulstart.de" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #c0392b;">🎓 Freie FH-Plätze – hochschulstart.de</a>
     <a href="https://www.arbeitsagentur.de/jobsuche/suche?was=[STUDIENGANG]&wo=${locationEncoded}&angebotsart=4" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #1a4d2e;">🏛️ Arbeitsagentur – Studium</a>
     <a href="https://www.hochschulstart.de" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #c0392b;">🎓 Freie Studienplätze – hochschulstart.de</a>
   </div>

   WENN BERUFSTÄTIGE/ABSOLVENTEN:
   <h4>📍 Jobs in ${location}:</h4>
   <div class="job-search-buttons">
     <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+${locationEncoded}&ibp=htl;jobs" target="_blank" class="btn btn-accent" style="margin: 10px 5px; display: inline-block;">🔍 Google Jobs</a>
     <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]&l=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #10b981;">💼 Indeed</a>
     <a href="https://www.stepstone.de/jobs/[BERUFSBEZEICHNUNG]/in-${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #3b82f6;">📋 StepStone</a>
     <a href="https://www.arbeitsagentur.de/jobsuche/suche?was=[BERUFSBEZEICHNUNG]&wo=${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #1a4d2e;">🏛️ Arbeitsagentur</a>
     <a href="https://www.ausbildung.de/berufe/suche/?q=[BERUFSBEZEICHNUNG]" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #64748b;">📋 Ausbildung.de – Berufsprofil</a>
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

   🚨 PFLICHT: Ersetze [Karriereweg 1], [Karriereweg 2], [Karriereweg 3] mit den EXAKTEN Berufsbezeichnungen!
   ❌ NIEMALS "Praktikum suchen" empfehlen – das ist bereits im Formular abgefragt!
   ❌ NIEMALS generische Tipps – immer 100% auf den konkreten Beruf zugeschnitten!

   🎯 WELCHE TIPPS FÜR WELCHEN BERUF – STRIKT EINHALTEN:

   GRUPPE 1 – Staatsberufe (Polizei, Bundeswehr, Zoll, Feuerwehr, JVA, Bundeswehr, Bundespolizei):
   → KEIN Udemy, KEINE Online-Kurse – das ist nutzlos für diese Berufe!
   → Stattdessen NUR:
      • Einstellungstest üben: Welche Tests (Sport, Wissen, Psycho) für genau diesen Beruf
      • Sporttest vorbereiten: Konkrete Anforderungen (z.B. "12-Minuten-Lauf, Liegestütze, Schwimmen")
      • Bewerbungsfrist + offizieller Bewerbungslink (z.B. bewerbung.polizei.[bundesland].de)
      • Erste-Hilfe-Schein falls gefordert

   GRUPPE 2 – IT / Daten / Technik / Informatik:
   → Hier macht Udemy/Coursera wirklich Sinn!
   → Stattdessen:
      • Kostenlos: z.B. "CS50" auf edX, "Python" auf codecademy.com, YouTube-Kanal mit echtem Namen
      • Udemy: konkreter Kursname + Preis (z.B. "Python Bootcamp" ca. 15€)
      • Zertifikat: z.B. IHK, Google, Microsoft, Cisco – je nach Beruf

   GRUPPE 3 – Kreativ / Design / Medien / Film:
   → Portfolio aufbauen ist wichtiger als Kurse!
   → Stattdessen:
      • Kostenloses Tool zum Üben (z.B. Canva, DaVinci Resolve, Blender, GIMP)
      • Eine konkrete Übungsaufgabe (z.B. "Erstelle 3 Logos für fiktive Firmen")
      • Wo Portfolio zeigen: Behance, Instagram, eigene Website

   GRUPPE 4 – Handwerk / Pflege / Gastro / Ausbildungsberufe:
   → Vor der Ausbildung kaum sinnvolle Kurse – ehrlich sein!
   → Stattdessen:
      • Eine konkrete Fähigkeit die hilft (z.B. "Erste-Hilfe-Schein für Pflege", "Führerschein Klasse B für Handwerk")
      • Wo man sich schlau machen kann (z.B. "YouTube-Kanal [Name] zeigt den Arbeitsalltag als [Beruf]")
      • Physische Vorbereitung falls nötig (z.B. Handwerk: Kondition, Gastro: Stressresistenz)

   GRUPPE 5 – BWL / Wirtschaft / Kaufmännisch:
   → Praktische Office-Skills helfen wirklich!
   → Stattdessen:
      • Excel Grundlagen (GoodandCo YouTube kostenlos, oder Udemy ca. 15€)
      • Bewerbungsmappe professionell gestalten (Canva kostenlos)
      • Branchenkenntnis: z.B. Wirtschaftsnachrichten lesen, Handelsblatt App

   GRUPPE 6 – Studium / Uni / NC-Fächer (Medizin, Jura, Psychologie):
   → Hier zählt nur der NC – ehrlich kommunizieren!
   → Stattdessen:
      • Abi-Vorbereitung: Welche Fächer besonders wichtig sind für den NC
      • Studienplatzbewerbung: Hochschulstart.de, Direktbewerbung, Wartesemester
      • Alternative falls NC nicht reicht: Ausland, Private Uni, anderer Studiengang

   <div class="section-container">
     <h3 style="text-transform: uppercase; font-weight: 900;">📚 Nächste Schritte & Tipps für DEINE Karrierewege</h3>
     
     <h4 style="text-transform: uppercase; font-weight: 700;">[EXAKTER BERUFSNAME KARRIEREWEG 1]:</h4>
     <ul>
       <li><strong>[Passender Label je Gruppe – z.B. "Einstellungstest" / "Kostenlos üben" / "Tool" / "Skill"]:</strong> [Konkreter Tipp NUR für diesen Beruf]</li>
       <li><strong>[Passender Label]:</strong> [Konkreter Tipp]</li>
       <li><strong>[Passender Label]:</strong> [Konkreter Tipp]</li>
     </ul>
     
     <h4 style="text-transform: uppercase; font-weight: 700;">[EXAKTER BERUFSNAME KARRIEREWEG 2]:</h4>
     <ul>
       <li><strong>[Passender Label je Gruppe]:</strong> [Konkreter Tipp NUR für diesen Beruf]</li>
       <li><strong>[Passender Label]:</strong> [Konkreter Tipp]</li>
       <li><strong>[Passender Label]:</strong> [Konkreter Tipp]</li>
     </ul>
     
     <h4 style="text-transform: uppercase; font-weight: 700;">[EXAKTER BERUFSNAME KARRIEREWEG 3]:</h4>
     <ul>
       <li><strong>[Passender Label je Gruppe]:</strong> [Konkreter Tipp NUR für diesen Beruf]</li>
       <li><strong>[Passender Label]:</strong> [Konkreter Tipp]</li>
       <li><strong>[Passender Label]:</strong> [Konkreter Tipp]</li>
     </ul>
   </div>
   
   ❌ NIEMALS Platzhalter stehen lassen!
   ❌ NIEMALS "Praktikum suchen" schreiben – bereits im Formular!
   ✅ Gruppe erkennen → passende Tipps wählen → echte Namen/Links/Kurse einsetzen!

5. **5-STUFEN-ERFOLGSPLAN** (immer auf Karriereweg 1 bezogen!)

   ❌ NIEMALS "Praktikum suchen" – bereits im Formular!
   ❌ NIEMALS "Initiativ-E-Mail an Behörde" – Behörden haben feste Portale!
   ❌ NIEMALS ausbildung.de für Staatsberufe!
   ❌ NIEMALS YouTube-Kanäle erfinden die nicht existieren!
   ✅ IMMER auf Karriereweg 1 beziehen – konkret, motivierend, mit echten Namen!

   FORMAT: Nutze diesen Coach-Stil (kein trockenes To-Do!):
   • Jeder Schritt hat einen motivierenden Titel
   • Zeitangabe in Klammern + realistische Dauer
   • Ziel des Schritts in einem Satz
   • Konkreter Tipp mit echten Firmen/Links/Tools

   🎯 GRUPPE ERKENNEN → PASSENDE SCHRITTE:

   ═══════════════════════════════
   GRUPPE 1 – STAATSBERUFE (Polizei, Zoll, Feuerwehr, Bundeswehr, JVA):
   ═══════════════════════════════
   Schritt 1 – "Der Quick-Win" (Heute – 5 Min.)
     Ziel: Erstmal sehen ob der Vibe passt.
     → Such auf YouTube "Tag bei der [Beruf]" oder "[Beruf] Ausbildung Alltag" – schau 5 Min und entscheide: Bock drauf?
   Schritt 2 – "Der Reality-Check" (Diese Woche – 15 Min.)
     Ziel: Anforderungen kennen bevor man bewirbt.
     → Öffne das offizielle Portal (Polizei: polizei.nrw/karriere | Zoll: bewerbung.zoll.de | Bundeswehr: bundeswehr-karriere.de) und schau dir die Einstellungsvoraussetzungen an. Welche Tests warten auf DICH?
   Schritt 3 – "Das Insider-Manöver" (Nächste 2 Wochen)
     Ziel: Sporttest-Angst nehmen.
     → Konkrete körperliche Anforderungen für DIESEN Beruf nennen. Starte heute mit einem einfachen Trainingsplan – 3x pro Woche reicht am Anfang.
   Schritt 4 – "Die Bewerbungs-Abkürzung" (Nächster Monat)
     Ziel: Bewerbung ohne Chaos.
     → Bewerbungsfrist checken (oft 1 Jahr im Voraus!). Unterlagen: Schulzeugnis, Lichtbild, Führungszeugnis. Erste-Hilfe-Schein holen falls gefordert.
   Schritt 5 – "Der Zukunfts-Check" (Langfristig)
     Ziel: Motivation durch Perspektive.
     → Konkreter Laufbahnaufstieg + Gehaltssprung für DIESEN Beruf nennen (z.B. mittlerer → gehobener Dienst berufsbegleitend).

   ═══════════════════════════════
   GRUPPE 2 – PRIVATE AUSBILDUNGSBERUFE (Handwerk, Pflege, Gastro, Kaufmännisch, IT):
   ═══════════════════════════════
   Schritt 1 – "Der Quick-Win" (Heute – 5 Min.)
     Ziel: Erstmal sehen ob der Vibe passt.
     → Such auf YouTube "[Beruf] Azubi Alltag" oder "[Beruf] Ausbildung Tag" – schau 5 Min rein. Sieht das nach einem Alltag aus auf den DU Bock hast?
   Schritt 2 – "Der Reality-Check" (Diese Woche – 15 Min.)
     Ziel: Die Hürde "Lebenslauf" umgehen.
     → Geh auf Azubiyo oder Ausbildung.de, erstelle ein Mini-Profil (nur Name, Schule, Interessen) und aktiviere den Job-Alarm für ${location}. So kommen die Stellen zu DIR!
   Schritt 3 – "Das Insider-Manöver" (Nächste 2 Wochen)
     Ziel: Fuß in die Tür ohne Bewerbungsstress.
     → Such dir eine echte Firma in ${location} (z.B. [ECHTE FIRMA]) und schreib eine 2-Zeiler E-Mail: "Bieten Sie ein 1-tägiges Schnupperpraktikum an?" Ein Tag zuschauen bringt mehr als 10 Stunden googeln.
   Schritt 4 – "Die Bewerbungs-Abkürzung" (Nächste 2-3 Wochen – NICHT ein ganzer Monat!)
     Ziel: Bewerbung in 1 Woche fertig.
     → Nutze Canva für den Lebenslauf (kostenlos, Vorlage "Modern") + lass dir von ChatGPT eine Anschreiben-Struktur erstellen: "Ich bin [Alter], mag [Interessen], schreibe ein Anschreiben für [Beruf] bei [Firma]." Dann nur noch anpassen und abschicken!
   Schritt 5 – "Der Zukunfts-Check" (Langfristig)
     Ziel: Motivation durch echte Zahlen.
     → Konkreter Aufstiegsweg + Gehaltssprung nennen (z.B. Meister/Techniker + Aufstiegs-BAföG vom Staat). Einstiegsgehalt X€ → nach Weiterbildung Y€.

   ═══════════════════════════════
   GRUPPE 3 – DUALES STUDIUM (FH, BA, DHBW):
   ═══════════════════════════════
   Schritt 1 – "Der Quick-Win" (Heute – 5 Min.)
     Ziel: Verstehen was duales Studium wirklich bedeutet.
     → Such auf YouTube "Duales Studium [Fachrichtung] Erfahrung" – ein Erfahrungsvideo eines echten Studenten zeigt mehr als jede Website.
   Schritt 2 – "Der Reality-Check" (Diese Woche – 15 Min.)
     Ziel: Richtige FH + richtiges Unternehmen finden.
     → Geh auf ausbildungsplatz.de/duales-studium und such "[Studiengang] ${location}". 2-3 echte Unternehmen in ${location} nennen die diesen Studiengang anbieten.
   Schritt 3 – "Das Insider-Manöver" (Nächste 2 Wochen)
     Ziel: Beim dualen Studium zuerst Firma, dann FH.
     → Bewirb dich ZUERST beim Unternehmen – die melden dich dann an der FH an. Fristen: oft Oktober-Januar für September-Start!
   Schritt 4 – "Die Bewerbungs-Abkürzung" (Nächste 2-3 Wochen)
     Ziel: Assessment Center nicht fürchten.
     → Was erwartet DICH im Auswahlverfahren für DIESEN Studiengang? Konkrete Tipps zur Vorbereitung.
   Schritt 5 – "Der Zukunfts-Check" (Langfristig)
     Ziel: Master + Gehaltssprung im Blick.
     → Master nach Bachelor + konkretes Einstiegsgehalt + Aufstiegsperspektive nennen.

   ═══════════════════════════════
   GRUPPE 4 – UNI-STUDIUM / NC-FÄCHER:
   ═══════════════════════════════
   Schritt 1 – "Der Quick-Win" (Heute – 5 Min.)
     Ziel: NC-Realität checken.
     → Geh auf hochschulstart.de oder uni-assist.de und schau den aktuellen NC für DIESEN Studiengang. Realistisch einschätzen: Passt DEIN Abi dazu?
   Schritt 2 – "Der Reality-Check" (Diese Woche – 15 Min.)
     Ziel: Abi-Strategie festlegen.
     → Welche Fächer zählen besonders für den NC in DIESEM Studiengang? Jetzt noch beeinflussbar?
   Schritt 3 – "Das Insider-Manöver" (Nächste 2 Wochen)
     Ziel: Plan B absichern.
     → Falls NC knapp: Wartesemester, Auslandsstudium, private Uni oder verwandter Studiengang als konkreter Plan B.
   Schritt 4 – "Die Bewerbungs-Abkürzung" (Nächster Monat)
     Ziel: Bewerbung rechtzeitig abschicken.
     → Fristen: 15. Januar (Wintersemester) und 15. Juli (Sommersemester). Über hochschulstart.de ODER direkt bei Uni bewerben.
   Schritt 5 – "Der Zukunfts-Check" (Langfristig)
     Ziel: Spezialisierung + Gehalt im Blick.
     → Konkrete Fachrichtung nach Studium + realistisches Einstiegsgehalt nennen.

   🚨 PFLICHT: Der 5-Stufen-Plan bezieht sich IMMER auf KARRIEREWEG 1 – nicht auf Karriereweg 2 oder 3!

   <div class="section-container">
     <h3>🎯 DEIN 5-Stufen-Erfolgsplan – [KARRIEREWEG 1 NAME einsetzen]</h3>
     <div class="step-item">
       <span class="step-number">1</span>
       <div class="step-content"><strong>⚡ Der "Quick-Win" (Heute – 5 Min.):</strong> [Konkreter Text für KW1]
       <div style="margin-top:8px;">
         <a href="https://www.youtube.com/results?search_query=[BERUFSBEZEICHNUNG KW1]+Ausbildung+Erfahrung" target="_blank" class="btn" style="font-size:0.78rem; padding:5px 10px; margin:3px 8px 3px 0; display:inline-block; background:#ff0000;">▶ YouTube</a>
         <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG KW1]+Berufsalltag+Erfahrungen" target="_blank" class="btn btn-accent" style="font-size:0.78rem; padding:5px 10px; margin:3px 0 3px 8px; display:inline-block;">🔍 Berufsbild</a>
       </div></div>
     </div>
     <div class="step-item">
       <span class="step-number">2</span>
       <div class="step-content"><strong>🔍 Der "Reality-Check" (Diese Woche – 15 Min.):</strong> [Konkreter Text für KW1]
       <div style="margin-top:8px;">
         ${(edu === 'abitur' || edu === 'abitur_ziel') ? `
         <a href="https://www.studycheck.de/suche?q=[BERUFSBEZEICHNUNG KW1]&location=${locationEncoded}" target="_blank" class="btn" style="font-size:0.78rem; padding:5px 10px; margin:3px; display:inline-block; background:#3b82f6;">📚 StudyCheck</a>
         <a href="https://www.hochschulstart.de" target="_blank" class="btn" style="font-size:0.78rem; padding:5px 10px; margin:3px; display:inline-block; background:#c0392b;">🎓 Freie Studienplätze</a>
         ` : (edu === 'fachabitur' || edu === 'fachabitur_ziel') ? `
         <a href="https://www.ausbildung.de/duales-studium/suche/?q=[BERUFSBEZEICHNUNG KW1]&where=${locationEncoded}" target="_blank" class="btn" style="font-size:0.78rem; padding:5px 10px; margin:3px; display:inline-block; background:#7c3aed;">🔵 Duale Stellen</a>
         <a href="https://www.studycheck.de/suche?q=[BERUFSBEZEICHNUNG KW1]&location=${locationEncoded}" target="_blank" class="btn" style="font-size:0.78rem; padding:5px 10px; margin:3px; display:inline-block; background:#3b82f6;">📚 StudyCheck</a>
         ` : `
         <a href="https://www.azubiyo.de/stellenmarkt/?q=[BERUFSBEZEICHNUNG KW1]&ort=${locationEncoded}" target="_blank" class="btn" style="font-size:0.78rem; padding:5px 10px; margin:3px; display:inline-block; background:#7c3aed;">🎓 Stellen auf Azubiyo</a>
         `}
       </div></div>
     </div>
     <div class="step-item">
       <span class="step-number">3</span>
       <div class="step-content"><strong>🎯 Das "Insider-Manöver" (Nächste 1-2 Wochen):</strong> [Gruppe von KW1 → Fuß in die Tür, echte Firma/Institution für KW1 nennen]
       <div style="margin-top:8px;">
         <a href="https://www.google.com/search?q=Praktikum+[BERUFSBEZEICHNUNG KW1]+${location}" target="_blank" class="btn" style="font-size:0.78rem; padding:5px 10px; margin:3px; display:inline-block; background:#f77f00;">🔍 Praktikum suchen</a>
       </div></div>
     </div>
     <div class="step-item">
       <span class="step-number">4</span>
       <div class="step-content"><strong>🚀 Die "Bewerbungs-Abkürzung" (Nächste 2-3 Wochen):</strong> [Gruppe von KW1 → Bewerbung schnell + schlau für KW1, NICHT "nächsten Monat"!]
       <div style="margin-top:8px;">
         <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG KW1]+Bewerbung+Tipps+${location}" target="_blank" class="btn btn-accent" style="font-size:0.78rem; padding:5px 10px; margin:3px; display:inline-block;">📝 Bewerbungstipps</a>
       </div></div>
     </div>
     <div class="step-item">
       <span class="step-number">5</span>
       <div class="step-content"><strong>💰 Der "Zukunfts-Check" (Langfristig):</strong> [Gruppe von KW1 → konkreter Aufstieg + echte Gehaltszahlen für KW1]
       <div style="margin-top:8px;">
         <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG KW1]+Karriere+Aufstieg+Gehalt" target="_blank" class="btn" style="font-size:0.78rem; padding:5px 10px; margin:3px; display:inline-block; background:#1a4d2e;">📈 Karrieremöglichkeiten</a>
       </div></div>
     </div>
   </div>

**FORMATIERUNG:**
- <div class="career-path-card"> für JEDEN Karriereweg
- <div class="badge-container"> für Badges
- <div class="info-box"> für wichtige Infos
- <table class="salary-table"> für Gehälter
- <h3> und <h4> für Überschriften
- Sprich IMMER mit "DU"!
- ABSOLUTES VERBOT: KEINE Emojis in der gesamten Analyse! Kein einziges Emoji – weder in Überschriften, noch in Fließtext, noch in Listen, noch im 5-Stufen-Plan!

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

Block C) 🔀 2 ähnliche Alternativen:
<h4>🔀 2 ähnliche Alternativen die ebenfalls passen könnten:</h4>
<div class="info-box" style="background: white; border-left: 4px solid #1e1e1e;">
  <p><strong>Alternative 1:</strong> [Beruf] – [Warum + Unterschied]</p>
  <p><strong>Alternative 2:</strong> [Beruf] – [Warum + Unterschied]</p>
</div>

🚨 KEINE ERFUNDENEN BERUFSBEZEICHNUNGEN – HALLUZINATION VERBOTEN!
Die KI darf AUSSCHLIESSLICH Berufe nennen die in Deutschland wirklich existieren und offiziell anerkannt sind!

VERBOTEN – Beispiele für erfundene/falsche Berufsbezeichnungen:
❌ "Zollbetriebswirt" → gibt es nicht! → Richtig: "Zöllner / Zollbeamter (mittlerer/gehobener Dienst)"
❌ "Sicherheitstechniker" als Ausbildungsberuf → gibt es nicht! → Richtig: "Fachkraft für Schutz und Sicherheit"
❌ "IT-Kaufmann" → gibt es nicht! → Richtig: "Kaufmann/-frau für IT-System-Management"
❌ "Sozialmanager" als Ausbildung → gibt es nicht so!
❌ "Digitalkaufmann" → gibt es nicht!

REGEL: Wenn du dir bei einer Berufsbezeichnung nicht 100% sicher bist → wähle einen anderen Beruf den du SICHER kennst!
Lieber einen bekannten soliden Beruf empfehlen als einen erfundenen!
Offizielle Berufsbezeichnungen immer genauso schreiben wie sie in der Ausbildungsordnung oder im Beamtenrecht stehen!

🚨 GLOBALE DUPLIKAT-REGEL – GILT FÜR DIE GESAMTE ANALYSE:
Führe intern eine Liste aller bereits genannten Berufe – sowohl Hauptkarrierewege ALS AUCH Alternativen!

VERBOTEN: Ein Beruf der bereits als Hauptkariereweg ODER als Alternative genannt wurde, darf NIRGENDWO nochmal auftauchen!

Beispiel:
- Karriereweg 1: Landespolizist → Alternativen: Bundespolizist, Feuerwehrmann, Zöllner
- Karriereweg 2: NICHT Zöllner, NICHT Bundespolizist, NICHT Feuerwehrmann als Hauptweg!
- Karriereweg 2 Alternativen: NICHT Landespolizist, NICHT Feuerwehrmann, NICHT Zöllner!
- Karriereweg 3: Wieder andere Berufe die noch nicht vorkamen

Beachte: Auch ähnliche Berufe aus derselben Branche sollten über alle 3 Karrierewege verteilt sein – nicht alle Polizei/Sicherheits-Berufe in einen Karriereweg stopfen!

Interne Checkliste vor jeder Alternativen-Nennung:
✓ Kam dieser Beruf schon als Karriereweg 1, 2 oder 3 vor? → Anderen wählen!
✓ Kam dieser Beruf schon als Alternative bei Karriereweg 1 oder 2 vor? → Anderen wählen!
✓ Sind alle 12 Berufe (3 Hauptwege + 9 Alternativen) einzigartig? → Ja? Dann weiter!

✅ Karriereweg 1: Gehaltstabelle + Buttons + Block A + B + C ← PFLICHT
✅ Karriereweg 2: Gehaltstabelle + Buttons + Block A + B + C ← PFLICHT (alle Berufe NEU – keine Duplikate!)
✅ Karriereweg 3: Gehaltstabelle + Buttons + Block A + B + C ← PFLICHT (alle Berufe NEU – keine Duplikate!)

${formData.praktikum === 'ja' ? `
**PRAKTIKUM GESUCHT – Füge bei JEDEM Karriereweg diesen Button hinzu:**
<a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+Praktikum+${locationEncoded}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #f97316;">🎯 Praktikum finden</a>
<a href="https://www.google.com/search?q=Praktikum+${location}" target="_blank" class="btn" style="margin: 10px 5px; display: inline-block; background: #7c3aed;">🔍 Praktikum suchen</a>
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

        const systemMessage = `DU bist ein Experten-Karriereberater mit 15+ Jahren Erfahrung. Nimm DIR Zeit zum Nachdenken bevor DU antwortest – eine schlechte Empfehlung kann den Lebensweg eines jungen Menschen negativ beeinflussen. Deine Analyse muss durchdacht, individuell und präzise sein.

ABSOLUTES VERBOT: Verwende KEINE Emojis in der gesamten Ausgabe. Kein einziges Emoji – weder in Ueberschriften, noch in Fliestext, noch in Tabellen, noch in Listen, noch im 5-Stufen-Plan. Null Emojis.

🎯 WUNSCHBERUF / FASZINATIONS-BERUF:
${formData.wunschberuf ? `
Der User hat angegeben dass ihn folgender Beruf fasziniert: "${formData.wunschberuf}"

PFLICHT-REGELN ZUM WUNSCHBERUF:
1. Erwähne den Wunschberuf IMMER namentlich in der Analyse – der User muss sich gehört fühlen!
2. WENN der Wunschberuf zum Holland-Code + Noten + Bildungsabschluss passt → empfehle ihn als Karriereweg 1
3. WENN der Wunschberuf nicht direkt erreichbar ist (z.B. schlechte Noten für Piloten-Ausbildung) → erkläre es ehrlich UND zeige einen konkreten Weg wie man trotzdem in die Nähe kommt:
   Format: "Dein Wunsch ist [Beruf]. Mit deinem aktuellen [Noten/Abschluss] ist der direkte Weg schwierig weil [konkreter Grund]. ABER: Über [alternativer Einstieg] kannst du trotzdem [Ziel] erreichen."
4. NIEMALS den Wunschberuf einfach ignorieren oder totschweigen!
5. Wenn der Wunschberuf absolut unrealistisch ist → sage es direkt aber konstruktiv mit einem echten Alternativweg
` : ''}

DENKPROZESS – HOLLAND-MODELL ANWENDEN (intern, bevor DU schreibst):

Schritt 1: HOLLAND-CODE aus den Antworten ableiten
Ordne die Angaben des Users den 6 Holland-Typen zu:
- R (Realistic/Handwerklich): Körperlich, Technik, Draußen, Maschinen, Hands-on
- I (Investigative/Forschend): Analysieren, Verstehen, Wissenschaft, Problemlösen, Denken
- A (Artistic/Künstlerisch): Kreativität, Gestalten, Musik, Design, freies Arbeiten
- S (Social/Sozial): Menschen helfen, Teamwork, Kommunikation, Erziehung, Pflege
- E (Enterprising/Unternehmerisch): Führen, Verkaufen, Überzeugen, Ziele erreichen, Risiko
- C (Conventional/Ordnend): Struktur, Zahlen, Ordnung, Regeln, Verwaltung, Präzision

Schritt 2: TOP 2-3 Holland-Typen bestimmen
Aus Flow-Aktivität + Interessen + Stärken + Persönlichkeitsrolle den dominanten Holland-Code ableiten.
Beispiel: Macher + Technik-Interesse + Hands-on = R+E Code → Mechatroniker, Elektriker, Technischer Betriebswirt

Schritt 3: NUR Berufe wählen die zum Holland-Code passen
- NIEMALS einen Beruf empfehlen der dem Holland-Code widerspricht!
- Ein reiner R-Typ bekommt KEINEN reinen C-Beruf (Büro/Verwaltung)
- Ein reiner S-Typ bekommt KEINEN reinen R-Beruf (Maschinen/körperlich) ohne soziale Komponente
- Die 3 Karrierewege können verschiedene Holland-Kombinationen sein – aber alle müssen zum Profil passen

Schritt 4: AUS DER GANZEN BANDBREITE WÄHLEN – nicht nur Standard-Berufe!
Die KI kennt tausende Berufe. Nutze diese Vielfalt:
✅ Technisch/R: Mechatroniker, Elektroniker, Anlagenmechaniker, Zerspanungsmechaniker, Fluggerätemechaniker, Schiffsbauer, Feinoptiker, Uhrmacher, Modellbauer
✅ IT/I+R: Fachinformatiker Systemintegration, IT-Security, UX Designer, Data Analyst, Mediengestalter, Web-Entwickler
✅ Gesundheit/S+I: Ergotherapeut, Logopäde, Zahntechniker, Rettungssanitäter, Orthoptist, Diätassistent, Audiologieassistent
✅ Handwerk/R+A: Goldschmied, Raumausstatter, Parkettleger, Estrichleger, Bootsbauer, Glasapparatebauer
✅ Kreativ/A: Fotograf, Film-/Toningenieur, Bühnenbildner, Mediengestalter, Buchbinder, Keramiker
✅ Natur/R+I: Tierpfleger, Forstwirt, Landschaftsgärtner, Winzer, Biologielaborant, Fischwirt
✅ Sozial/S: Heilerziehungspfleger, Kindheitspädagoge, Sportlehrer, Sozialassistent
✅ Wirtschaft/E+C: Immobilienkaufmann, Veranstaltungskaufmann, Außenhandelskaufmann, Sportfachmann, Schifffahrtskaufmann
✅ Öffentlich/R+C+E: Landespolizist, Bundespolizist, Berufsfeuerwehr, Zöllner, Bundeswehr (Zeitsoldat/Berufssoldat), THW, Justizvollzugsbeamter, Verwaltungsbeamter

   🚨 POLIZEI – BILDUNGSWEG EXAKT BEACHTEN (PFLICHT!):

   REALSCHULABSCHLUSS (mittlere Reife):
   → NUR Bundespolizei mittlerer Dienst ODER Landespolizei mittlerer Dienst möglich
   → Viele Bundesländer bieten die FOR (Fachoberschulreife Polizei) an:
     Schritt 1: 2 Jahre FOR → Fachoberschulreife mit Polizei-Schwerpunkt
     Schritt 2: 3-jähriges duales Studium → Bachelor of Arts, Polizeikommissar (gehobener Dienst)
     Gesamtdauer: 5 Jahre bis zum vollwertigen Polizeibeamten gehobener Dienst
   → Formulierung in der Analyse: "Als Realschüler gibt es zwei Wege zur Polizei: Direkt in den mittleren Dienst bei Bundes- oder Landespolizei – oder DU machst die FOR (2 Jahre Fachoberschulreife Polizei) und danach das 3-jährige Studium zum Polizeikommissar (Bachelor)."

   FACHABITUR / FACHOBERSCHULREIFE:
   → Landespolizei gehobener Dienst – 3-jähriges duales Studium, Bachelor of Arts
   → Bundespolizei gehobener Dienst
   → Zollverwaltung gehobener Dienst

   ABITUR:
   → Alle Polizeilaufbahnen möglich inkl. höherer Dienst
   → Bundespolizei, Landespolizei, BKA, LKA
   → Mit Master auch Führungslaufbahn höherer Dienst

   HAUPTSCHULABSCHLUSS:
   → Bundeswehr Zeitsoldat möglich
   → Berufsfeuerwehr je nach Bundesland
   → NIEMALS direkt Polizei empfehlen ohne Hinweis auf fehlende Voraussetzungen!

   IMMER: "Landespolizist" oder "Bundespolizist" schreiben – NIEMALS nur "Polizist"!
   IMMER: Laufbahn nennen (mittlerer Dienst / gehobener Dienst)!

   🚨 ÖFFENTLICHER DIENST – AKTIV PRÜFEN WENN FOLGENDE TRIGGER ZUTREFFEN:
   Schaue die Antworten des Users durch und prüfe ob MINDESTENS 2 dieser Trigger zutreffen:
   
   TRIGGER-LISTE:
   - Priorität: "Sicherheit", "Stabilität", "sicherer Job", "Beamtenstatus"
   - Energie: "Teamarbeit", "Zusammenarbeit", "gemeinsam etwas erreichen"
   - Arbeitsstil: "strukturiert", "klare Regeln", "Hierarchie ok"
   - Flow-Aktivität: "helfen", "schützen", "organisieren", "körperlich aktiv"
   - Interessen: "Gesellschaft", "Sicherheit", "Sport", "Technik", "Fahrzeuge"
   - Persönlichkeitsrolle: "Macher", "Teamplayer", "Planer"
   - Work-Type: "draußen", "nicht am Schreibtisch", "körperlich"
   - Risikobereitschaft: "lieber sicher", "kein Risiko"
   
   WENN 2+ TRIGGER → Mindestens EINEN dieser Berufe in die Top 3 aufnehmen:
   Landespolizist (mittlerer/gehobener Dienst je nach Abschluss), Bundespolizist, Berufsfeuerwehr, Bundeswehr (Zeitsoldat/Berufssoldat), Zoll, THW, Justizvollzugsbeamter
   
   BEGRÜNDUNG IN DER ANALYSE: Erkläre konkret welche Antworten des Users auf diesen Weg hindeuten:
   Beispiel: "Dein Wunsch nach Stabilität und körperlicher Tätigkeit im Team macht den Polizeidienst zur perfekten Wahl – DU willst Ergebnisse sehen, arbeitest gerne draußen und schätzt klare Strukturen. Genau das bietet dir der öffentliche Dienst – plus unkündbare Stelle und Pension."
✅ Wissenschaft/I: Chemielaborant, Physiklaborant, Geomatiker, Vermessungstechniker, Meteorologieassistent

NUR wenn der Holland-Code eindeutig C oder E ist → dann auch klassische Kaufmann-Berufe möglich
Ansonsten: Kaufmann/-frau für Büromanagement, Bürokaufmann, Industriekaufmann NUR bei explizitem C-Profil!

AUSGABE-QUALITÄT:
- Jede Empfehlung muss logisch aus dem Holland-Code folgen – der User soll es nachvollziehen können
- Erkläre bei jedem Karriereweg WARUM der Holland-Code diesen Beruf ergibt
- Karriereweg 1 = stärkste Holland-Übereinstimmung
- Karriereweg 2 = zweite Holland-Kombination (andere Gewichtung)
- Karriereweg 3 = dritte valide Option – anderer Sektor aber gleicher Kern-Code
- Alle 3 müssen sich klar voneinander unterscheiden (verschiedene Branchen!)

ÜBERSCHRIFTEN – ZWINGEND GROSSGESCHRIEBEN UND FETT:
- Alle <h3> Tags: style="text-transform: uppercase; font-weight: 900; letter-spacing: 1px;"
- Alle <h4> Tags: style="text-transform: uppercase; font-weight: 700;"
- Beispiel: <h3 style="text-transform: uppercase; font-weight: 900; letter-spacing: 1px;">🔧 Industriekaufmann/-frau</h3>
- NIEMALS Überschriften ohne diese Styles schreiben!

SCHRIFTFORM-UNTERSCHIEDE für verschiedene Inhalte:
- Karriereweg-Titel (<h3>): GROSSBUCHSTABEN + fett + größer
- Abschnitts-Überschriften (<h4>): GROSSBUCHSTABEN + fett
- Wichtige Fakten (<strong>): fett
- Warnungen/Hürden: <span style="color: #e65100; font-weight: bold;">
- Positive Highlights: <span style="color: #1a4d2e; font-weight: bold;">
- Gehaltszahlen: <span style="color: #f77f00; font-weight: bold;">

AUSGABE-FORMAT:
- Gib NUR reines HTML zurück - NIEMALS Markdown!
- NIEMALS ## oder ### oder --- oder ** oder * verwenden!
- Alle Abschnitte in die vorgegebenen HTML-Container
- Kein Markdown, kein Plain-Text, nur sauberes HTML!`;

        // ── CALL 1: Profil + "Durchschaut"-Block + Karriereweg 1 & 2 ──
        console.log('📡 Call 1: Profil + Karriereweg 1 & 2...');

        // Bildungsweg-Regel dynamisch berechnen
        // bildungsweg_ziel überschreibt falls gesetzt
        const bwZiel = formData.bildungsweg_ziel || '';
        const bildungswegRegel = (bwZiel === 'ausbildung')
            ? 'BILDUNGSWEG-ZIEL: AUSBILDUNG → KW1, KW2 und KW3 = NUR Ausbildungsberufe (🟢)! Kein Studium!'
            : (bwZiel === 'uni')
            ? 'BILDUNGSWEG-ZIEL: UNI → KW1, KW2 und KW3 = NUR Uni-Studiengänge (🟣)! Ausbildungen VERBOTEN!'
            : (bwZiel === 'fh')
            ? 'BILDUNGSWEG-ZIEL: FH/DUAL → KW1, KW2 und KW3 = NUR Duale Studiengänge oder FH (🔵)! Ausbildungen VERBOTEN!'
            : (formData.education === 'abitur' || formData.education === 'abitur_ziel')
            ? 'ABITUR → KW1, KW2 und KW3 = NUR Uni-Studiengänge (🟣)! Ausbildungen VERBOTEN!'
            : (formData.education === 'fachabitur' || formData.education === 'fachabitur_ziel')
            ? 'FACHABITUR → KW1, KW2 und KW3 = NUR Duale Studiengänge oder FH (🔵)! Ausbildungsberufe VERBOTEN!'
            : (formData.education === 'realschule' || formData.education === 'realschule_ziel' || formData.education === 'hauptschule' || formData.education === 'hauptschule_ziel')
            ? 'REALSCHULE/HAUPTSCHULE → KW1, KW2 und KW3 = NUR Ausbildungsberufe (🟢)! Studium VERBOTEN!'
            : 'Bildungsabschluss beachten!';

        const prompt1 = prompt + `

🛑🛑🛑 BILDUNGSWEG-PFLICHTCHECK VOR AUSGABE 🛑🛑🛑
${bildungswegRegel}
BEVOR DU KW1 SCHREIBST: Passt der Beruf zum Bildungsweg? NEIN → anderen wählen!
BEVOR DU KW2 SCHREIBST: Passt der Beruf zum Bildungsweg? NEIN → anderen wählen!
🛑🛑🛑

🚨 JETZT NUR FOLGENDES AUSGEBEN (NICHT MEHR!):
1. DEIN PROFIL
2. "Was wir in DIR gesehen haben" Block
3. Karriereweg 1 (komplett mit Tabelle, Buttons, Steckbrief, Zukunftstrend, Warum, Alternativen)
4. Karriereweg 2 (komplett mit Tabelle, Buttons, Steckbrief, Zukunftstrend, Warum, Alternativen)

STOPP nach Karriereweg 2! Karriereweg 3, Weiterbildung und Nächste Schritte kommen im nächsten Schritt.`;

        const completion1 = await callWithRetry(() => openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: systemMessage },
                { role: "user", content: prompt1 }
            ],
            temperature: 0.1,
            max_tokens: 16000,
        }));

        const part1 = completion1.choices[0].message.content;
        console.log('✅ Call 1 fertig, starte Call 2...');

        // ── CALL 2: Karriereweg 3 + Uni-Empfehlungen + Weiterbildung + Nächste Schritte ──
        const prompt2 = prompt + `

⚠️ WICHTIG – BEREITS AUSGEGEBEN IN TEIL 1:
${part1}

🚨 DEINE AUFGABE FÜR TEIL 2 – NUR FOLGENDES AUSGEBEN:
1. Karriereweg 3: Wähle einen ANDEREN Beruf als die bereits oben genannten Karrierewege 1 und 2! Niemals denselben Beruf nochmal empfehlen! (komplett mit Tabelle, Buttons, Steckbrief, Zukunftstrend, Warum, Alternativen)
2. Uni/Hochschul-Empfehlungen (falls relevant für den Bildungsabschluss)
3. Weiterbildungs-Tipps für alle 3 Karrierewege (beziehe Karriereweg 1+2 aus Teil 1 mit ein)
4. Konkrete Nächste Schritte (5 Schritte mit lokalen Firmennamen aus ${location})

🛑🛑🛑 BILDUNGSWEG-PFLICHTCHECK – AUCH FÜR KW3 🛑🛑🛑
${bildungswegRegel}
BEVOR DU KW3 SCHREIBST: Ist es der richtige Typ? NEIN → anderen Beruf wählen!
🛑🛑🛑

NUR diese Sektionen ausgeben – Profil und Karriereweg 1 & 2 wurden bereits in Teil 1 ausgegeben und dürfen NICHT wiederholt werden!`;

        const completion2 = await callWithRetry(() => openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: systemMessage },
                { role: "user", content: prompt2 }
            ],
            temperature: 0.1,
            max_tokens: 16000,
        }));

        const part2 = completion2.choices[0].message.content;
        console.log('✅ Call 2 fertig, starte Review-Loop (Call 3)...');

        // ── CALL 3: REVIEW-LOOP – KI prüft die kombinierte Analyse ──
        const combinedDraft = part1 + '\n' + part2;

        const reviewPrompt = `Prüfe diese Karriereanalyse und gib NUR das korrigierte HTML zurück – keine Erklärungen.

NUTZERPROFIL:
- Bildungsabschluss: ${formData.education}
- Anti-Job: ${Array.isArray(formData.anti_job) ? formData.anti_job.join(', ') : formData.anti_job}
- Interessen: ${Array.isArray(formData.interests) ? formData.interests.join(', ') : formData.interests}
- Flow: ${formData.flow_activity || 'k.A.'}
- Standort: ${location}
${formData.security_art ? `- SICHERHEIT: ${Array.isArray(formData.security_art) ? formData.security_art.join(', ') : formData.security_art} → NUR öffentlicher Dienst! KEINE privaten Sicherheitsfirmen!` : ''}

PFLICHT-CHECKS:
1. Platzhalter [ ] → Alle ersetzen mit echten Werten!
2. Bildungsabschluss: Fachabitur→FH, Realschule→Ausbildung, Abitur→mind. 1 Studiengang
3. Anti-Job widerspricht empfohlenem Beruf? → Beruf ersetzen!
4. Fehlende Gehaltstabellen oder Job-Buttons? → Einfügen!
5. Duplikate (Beruf als Hauptweg UND Alternative)? → Entfernen!
6. Kaputtes HTML? → Reparieren!
7. Markdown (##, **, ---)? → In HTML umwandeln!

WICHTIG: Gib NUR das fertige HTML zurück!

ZU PRÜFENDE ANALYSE:
${combinedDraft}`;

        const completionReview = await callWithRetry(() => openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "Du bist ein präziser HTML-Qualitätsprüfer für Karriereanalysen. Du gibst AUSSCHLIESSLICH korrigiertes HTML zurück – keine Erklärungen, kein Markdown, kein Kommentar."
                },
                { role: "user", content: reviewPrompt }
            ],
            temperature: 0.1,
            max_tokens: 16000,
        }));

        const reviewedAnalysis = completionReview.choices[0].message.content;
        console.log('✅ Review-Loop (Call 3) fertig – finale Analyse bereit!');

        // ── FINALE ANALYSE SPEICHERN ──
        analysisResults.set(sessionId, {
            analysis: reviewedAnalysis,
            timestamp: new Date(),
            formData: formData
        });

        console.log('Analysis complete for session:', sessionId);

        return reviewedAnalysis;
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

// ── BERUFSLEXIKON ENDPOINT ──
app.post('/berufslexikon', async (req, res) => {
    try {
        const { beruf } = req.body;
        if (!beruf) return res.status(400).json({ error: 'Kein Beruf angegeben' });

        console.log(`📚 Berufslexikon angefragt: ${beruf}`);

        const prompt = `Du bist ein Karriereexperte. Erstelle die vollständigste und informativste HTML-Seite über den Beruf/Studiengang: "${beruf}" – besser als Arbeitsagentur und Ausbildung.de zusammen.

Gib NUR reines HTML zurück – kein Markdown, keine Erklärungen, kein Kommentar.

Die HTML-Seite soll folgende Abschnitte enthalten:

1. SCHNELLÜBERSICHT (4 Fakten-Karten):
- Art: Ausbildung / Studium / Beides möglich
- Dauer: Ausbildungsdauer oder Studiendauer
- Einstiegsgehalt
- Mindest-Schulabschluss

2. WAS MACHT EIN ${beruf}?
- Beschreibung (3-4 Sätze, konkret und lebendig)
- Typische Aufgaben (6 Punkte als Grid)
- Arbeitsumfeld & Arbeitszeiten: Büro/Draußen/Schichtarbeit/Wochenende ja/nein

3. WER KANN DIESEN BERUF MACHEN? – EINSTIEGSWEGE je nach Schulabschluss:
Zeige für JEDEN Abschluss den konkreten Weg:
- Hauptschulabschluss → Welche Ausbildung ist möglich? Welche nicht?
- Realschulabschluss → Welche Ausbildung? Welche Weiterbildungen danach?
- Fachabitur → Duales Studium möglich? Welche FH-Studiengänge?
- Abitur → Alle Wege offen: Ausbildung + Studium, welche Uni-Studiengänge?
Wichtig: Zeige auch ob man SPÄTER noch studieren kann (z.B. Ausbildung → danach Studium nachholen)

4. DER WEG ZUM BERUF – KARRIERE-ROADMAP (Schritt für Schritt):
Weg A: Über Ausbildung (mit konkreten Ausbildungsberufen die dazu führen)
Weg B: Über Studium (mit konkreten Studiengängen)
Weg C: Quereinsteiger möglich? Falls ja wie?
Kann man die Ausbildung verkürzen? (z.B. bei guten Noten auf 2 oder 2,5 Jahre)

5. GEHALTSTABELLE
- Ausbildungsvergütung (alle Jahre falls Ausbildung)
- Einstiegsgehalt nach Abschluss
- Nach 3-5 Jahren Erfahrung
- Senior / Spezialist
- Teamleiter / Führungskraft
- Hinweis: "Gehälter variieren je nach Region und Unternehmensgröße"

6. GEHALTSVERGLEICH NACH REGION (Tabelle):
| Region | Einstieg | Nach 5 Jahren |
| Bayern / Baden-Württemberg | X€ | X€ |
| NRW / Hessen | X€ | X€ |
| Norddeutschland | X€ | X€ |
| Ostdeutschland | X€ | X€ |

7. KARRIEREWEGE & AUFSTIEG – WAS KANN MAN ERREICHEN? (3-4 Karten)
- Konkrete Aufstiegspositionen mit Gehalt
- Weiterbildungen die den Aufstieg ermöglichen
- Kann man mit dieser Ausbildung später noch studieren?

8. JOBMÖGLICHKEITEN – WO KANN MAN ARBEITEN?
- Branchen (mindestens 5 konkrete Branchen)
- Typische Arbeitgeber (Konzerne, Mittelstand, öffentlicher Dienst, selbstständig?)
- Ist der Job auch remote/homeoffice möglich?

9. ZUKUNFTSPROGNOSE (4 Balken mit Prozent):
- Jobsicherheit
- Nachfrage am Markt
- KI-Automatisierungsrisiko
- Aufstiegspotenzial
+ 2-3 Sätze: "Was KI in diesem Beruf NICHT ersetzen kann"

10. VORTEILE & NACHTEILE (2 Spalten, je 5 Punkte)

11. WEITERBILDUNGSMÖGLICHKEITEN (4 Karten)
- Konkrete Weiterbildungen mit Gehaltssprung
- Dauer der Weiterbildung

12. VORAUSSETZUNGEN & BEWERBUNG
- Mindest-Schulabschluss
- Wichtige Schulfächer (z.B. Mathe, Biologie, Deutsch)
- Persönliche Eigenschaften
- Wo bewerben: Arbeitsagentur, Indeed, Google Jobs, direkt bei Unternehmen und IHK/HWK

Verwende dieses CSS-Design (inline styles) – WICHTIG: viel Luft und Übersichtlichkeit!:
- Seiten-Wrapper: font-family:'Work Sans',sans-serif; max-width:900px; margin:0 auto; padding:0 20px;
- Sektions-Karten: background:white; border-radius:16px; padding:36px 40px; margin-bottom:32px; box-shadow:0 2px 16px rgba(15,31,61,0.07)
- Überschriften h2: font-family:'Crimson Pro',serif; color:#0f1f3d; font-size:1.7rem; font-weight:700; border-bottom:3px solid #c9a84c; padding-bottom:14px; margin-bottom:24px
- Überschriften h3: font-family:'Crimson Pro',serif; color:#0f1f3d; font-size:1.2rem; margin:24px 0 12px
- Fließtext p: font-size:1rem; line-height:1.8; color:#333; margin-bottom:14px
- Gehaltstabelle: width:100%; border-collapse:collapse; margin:16px 0; mit th background:#0f1f3d color:white padding:14px 16px; td padding:12px 16px; border-bottom:1px solid #eee
- Roadmap-Schritte: background:#f7f8fc; border-left:4px solid #c9a84c; padding:20px 24px; border-radius:0 10px 10px 0; margin-bottom:16px; line-height:1.8
- Aufzählungen li: margin-bottom:10px; line-height:1.7; padding-left:4px
- Grid-Karten: background:#f7f8fc; border-radius:10px; padding:20px; border-left:3px solid #c9a84c

Am Ende IMMER diese CTA-Box:
<div style="background:linear-gradient(135deg,#0f1f3d,#1a3a6b);border-radius:12px;padding:40px;text-align:center;color:white;margin-top:30px;">
<h2 style="font-family:'Crimson Pro',serif;font-size:1.8rem;margin-bottom:12px;color:white;">Passt ${beruf} wirklich zu DIR?</h2>
<p style="color:rgba(255,255,255,0.85);margin-bottom:8px;">Viele wählen einen Beruf der gut klingt – aber nicht zu ihrer Persönlichkeit passt.</p>
<p style="color:rgba(255,255,255,0.85);margin-bottom:24px;">Unsere KI analysiert in 5 Minuten ob dieser Beruf zu DEINEN Stärken, Interessen und Zielen passt.</p>
<a href="/" style="display:inline-block;background:linear-gradient(135deg,#c9a84c,#e8c96a);color:#0f1f3d;padding:14px 32px;border-radius:8px;font-weight:700;text-decoration:none;font-size:1rem;">Jetzt KI-Analyse starten – nur 4,99€</a>
<p style="margin-top:12px;font-size:0.85rem;color:rgba(255,255,255,0.6);">3 konkrete Karrierewege · Persönlicher Aktionsplan · Gehaltsvergleich</p>
</div>

Wichtig – GENAUIGKEIT IST PFLICHT:
- Alle Zahlen müssen 100% korrekt für Deutschland 2025 sein!
- Ausbildungsdauer GENAU recherchieren: z.B. Steuerfachangestellter beim Finanzamt = 2 Jahre nicht 3!
- Ausbildungsvergütung: Offizielle Tarifwerte nutzen – öffentlicher Dienst oft 1.200-1.500€/Monat!
- Im Zweifelsfall Bereich angeben (z.B. "ca. 2-3 Jahre") statt falsche genaue Zahl
- NIEMALS Zahlen erfinden – lieber "variiert je nach Bundesland" schreiben
- Am Ende der Seite IMMER diesen Disclaimer einfügen:
<p style="font-size:0.8rem;color:#999;text-align:center;margin-top:20px;padding:16px;">⚠️ Alle Angaben ohne Gewähr und können je nach Bundesland, Betrieb und Tarifvertrag abweichen. Bitte bei der zuständigen IHK, HWK oder dem Bildungsträger nachfragen.</p>`;

        const completion = await callWithRetry(() => openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: 'Du bist ein Karriereexperte der präzise HTML-Seiten über Berufe erstellt. Gib NUR HTML zurück.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.2,
            max_tokens: 8000,
        }));

        let html = completion.choices[0].message.content;
        html = html.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();

        console.log(`✅ Berufslexikon generiert: ${beruf}`);
        res.json({ html });

    } catch (error) {
        console.error('Berufslexikon Error:', error);
        res.status(500).json({ error: 'Fehler beim Generieren' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log('=================================');
    console.log('✅ SERVER LÄUFT auf Port', PORT);
    console.log('🆕 Partner-Endpoint aktiv!');
    console.log('🤖 Chatbot-Endpoint aktiv!');
    console.log('🔍 "KI hat dich durchschaut" Block aktiv!');
    console.log('🔄 Review-Loop (Call 3) aktiv!');
    console.log('📚 Berufslexikon-Endpoint aktiv!');
    console.log('=================================');
});

module.exports = app;
