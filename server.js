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

// RETRY HELPER – wartet bei Rate-Limit und versucht nochmal
async function callWithRetry(fn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (err.status === 429 && i < maxRetries - 1) {
                const waitMs = (err.headers?.['retry-after-ms'] ? parseInt(err.headers['retry-after-ms']) : 5000) + 1000;
                console.log(`⏳ Rate limit – warte ${waitMs}ms (Versuch ${i+1}/${maxRetries})...`);
                await new Promise(r => setTimeout(r, waitMs));
            } else {
                throw err;
            }
        }
    }
}

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

📋 GENEHMIGTE BERUFSLISTEN – NUR AUS DER PASSENDEN LISTE WÄHLEN!

🚨 OBERSTE REGEL: Der Bildungsabschluss bestimmt welche Liste verwendet wird!
→ ABITUR: NUR aus der 🟣 UNI-LISTE wählen
→ FACHABITUR: NUR aus der 🔵 DUALEN LISTE wählen
→ REALSCHULE / HAUPTSCHULE: NUR aus der 🟢 AUSBILDUNGSLISTE wählen
❌ VERBOTEN: Aus der falschen Liste wählen!
❌ VERBOTEN: Berufe erfinden die nicht in der Liste stehen!

═══════════════════════════════════════════════
🟢 AUSBILDUNGSBERUFE (NUR für Realschule/Hauptschule)
═══════════════════════════════════════════════
⚠️ NUR DIESE BERUFE bei Realschule oder Hauptschule verwenden!

💻 TECHNOLOGIE & COMPUTER:
- Fachinformatiker/in Anwendungsentwicklung
- Fachinformatiker/in Systemintegration
- Fachinformatiker/in Daten- und Prozessanalyse
- Fachinformatiker/in Digitale Vernetzung
- Kaufmann/-frau für IT-Systemmanagement
- Kaufmann/-frau für Digitalisierungsmanagement
- IT-System-Elektroniker/in
- Mathematisch-technische/r Softwareentwickler/in (MaTSE)
- Elektroniker/in für Informations- und Systemtechnik
- Kaufmann/-frau im E-Commerce
- Mikrotechnologe/-technologin
- Mediengestalter/in Digital und Print
- Informationselektroniker/in
- Systeminformatiker/in
- Elektroniker/in für Automatisierungstechnik
- Geomatiker/in
- Vermessungstechniker/in
- Kaufmann/-frau für Marketingkommunikation
- Fachkraft für Medien- und Informationsdienste
- Physiklaborant/in
- Elektroniker/in für Geräte und Systeme
- Mechatroniker/in
- Film- und Videoeditor/in
- Fachkraft für Veranstaltungstechnik
- Kaufmann/-frau für audiovisuelle Medien

🎨 KREATIVITÄT & DESIGN:
- Mediengestalter/in Bild und Ton
- Mediengestalter/in Digital und Print
- Fotograf/in
- Goldschmied/in
- Tischler/in (Möbeldesign)
- Raumausstatter/in
- Schilder- und Lichtreklamehersteller/in
- Technischer Produktdesigner/in
- Modeschneider/in
- Maßschneider/in
- Buchbinder/in
- Holzbildhauer/in
- Steinmetz/in und Steinbildhauer/in
- Uhrmacher/in
- Florist/in
- Maskenbildner/in
- Keramiker/in
- Fachkraft für Möbel-, Küchen- und Umzugsservice
- Gestalter/in für visuelles Marketing
- Musikinstrumentenbauer/in
- Graveur/in
- Textil- und Modegestalter/in

👥 ARBEIT MIT MENSCHEN:
- Erzieher/in
- Heilerziehungspfleger/in
- Pflegefachmann/-frau
- Sozialversicherungsfachangestellte/r
- Kaufmann/-frau im Gesundheitswesen
- Fachangestellte/r für Arbeitsmarktdienstleistungen
- Verwaltungsfachangestellte/r
- Hauswirtschafter/in
- Kinderpfleger/in
- Sozialassistent/in
- Medizinische/r Fachangestellte/r (MFA)
- Zahnmedizinische/r Fachangestellte/r (ZFA)
- Bestattungsfachkraft
- Diätassistent/in
- Altenpflegehelfer/in
- Rettungssanitäter/in
- Podologe/in
- Pharmazeutisch-kaufmännische/r Angestellte/r (PKA)
- Sport- und Fitnesskaufmann/-frau
- Kaufmann/-frau für Tourismus und Freizeit
- Fachangestellte/r für Bäderbetriebe

💰 WIRTSCHAFT & FINANZEN:
- Bankkaufmann/-frau
- Industriekaufmann/-frau
- Kaufmann/-frau für Büromanagement
- Kaufmann/-frau im Einzelhandel
- Verkäufer/in
- Kaufmann/-frau im Groß- und Außenhandelsmanagement
- Steuerfachangestellte/r
- Rechtsanwaltsfachangestellte/r
- Notarfachangestellte/r
- Immobilienkaufmann/-frau
- Automobilkaufmann/-frau
- Kaufmann/-frau für Spedition und Logistikdienstleistung
- Kaufmann/-frau für Versicherungen und Finanzanlagen
- Investmentfondskaufmann/-frau
- Kaufmann/-frau für Marketingkommunikation
- Veranstaltungskaufmann/-frau
- Hotelkaufmann/-frau
- Tourismuskaufmann/-frau
- Luftverkehrskaufmann/-frau
- Fachkraft für Lagerlogistik
- Fachlagerist/in
- Kaufmann/-frau für Dialogmarketing
- Personaldienstleistungskaufmann/-frau
- Buchhändler/in
- Drogerist/in
- Gestalter/in für visuelles Marketing

🏥 GESUNDHEIT & MEDIZIN:
- Pflegefachmann/-frau
- Medizinische/r Fachangestellte/r (MFA)
- Zahnmedizinische/r Fachangestellte/r (ZFA)
- Notfallsanitäter/in
- Pharmazeutisch-technische/r Assistent/in (PTA)
- Pharmazeutisch-kaufmännische/r Angestellte/r (PKA)
- Med. Technologe f. Radiologie (MTR)
- Med. Technologe f. Laboratoriumsanalytik (MTL)
- Operationstechnische/r Assistent/in (OTA)
- Anästhesietechnische/r Assistent/in (ATA)
- Hörakustiker/in
- Augenoptiker/in
- Orthopädietechnik-Mechaniker/in
- Zahntechniker/in
- Masseur/in und med. Bademeister/in
- Diätassistent/in
- Podologe/in
- Fachkraft für Medizinprodukteaufbereitung
- Kaufmann/-frau im Gesundheitswesen
- Tiermedizinische/r Fachangestellte/r (TFA)
- Chirurgiemechaniker/in
- Pflegefachassistent/in

🔧 HANDWERKLICH ARBEITEN:
- Kfz-Mechatroniker/in
- Anlagenmechaniker/in SHK
- Elektroniker/in für Energie- und Gebäudetechnik
- Tischler/in / Schreiner/in
- Maurer/in
- Metallbauer/in
- Industriemechaniker/in
- Mechatroniker/in
- Maler/in und Lackierer/in
- Dachdecker/in
- Zimmerer/in
- Werkzeugmechaniker/in
- Zerspanungsmechaniker/in
- Feinwerkmechaniker/in
- Karosserie- und Fahrzeugbaumechaniker/in
- Beton- und Stahlbetonbauer/in
- Fliesen-, Platten- und Mosaikleger/in
- Stuckateur/in
- Elektroniker/in für Betriebstechnik
- Konstruktionsmechaniker/in
- Verfahrensmechaniker/in Kunststoff/Kautschuk
- Gießereimechaniker/in
- Oberflächenbeschichter/in
- Kälteanlagenbauer/in
- Bootsbauer/in

🌿 NATUR, TIERE & UMWELT:
- Gärtner/in (Garten- und Landschaftsbau)
- Gärtner/in (Zierpflanzenbau)
- Landwirt/in
- Forstwirt/in
- Tierpfleger/in
- Tiermedizinische/r Fachangestellte/r
- Revierjäger/in
- Winzer/in
- Fischwirt/in
- Pferdewirt/in
- Pflanzentechnologe/-technologin
- Fachkraft für Agrarservice
- Biologielaborant/in
- Chemielaborant/in
- Fachkraft für Wasserversorgungstechnik
- Fachkraft für Abwassertechnik
- Fachkraft für Kreislauf- und Abfallwirtschaft
- Milchtechnologe/-technologin
- Brenner/in
- Molkereifachmann/-frau
- Baumpfleger/in

🛡️ SICHERHEIT & SCHUTZ:
- Polizeivollzugsdienst mittlerer Dienst (Landespolizei)
- Polizeivollzugsdienst mittlerer Dienst (Bundespolizei)
- Fachkraft für Schutz und Sicherheit
- Servicekraft für Schutz und Sicherheit
- Fachangestellte/r für Bäderbetriebe
- Brandmeisteranwärter/in (Feuerwehr)
- Justizfachangestellte/r
- Zollbeamte/r (Mittlerer Dienst)
- Werkfeuerwehrmann/-frau
- Luftsicherheitsassistent/in
- Rettungssanitäter/in
- Bundeswehr – Soldat auf Zeit (Mannschaft)
- Bundeswehr – Unteroffizier im Fachdienst
- Bundeswehr – Feldwebelanwärter
- Alarm- und Sicherheitstechniker/in
- Elektroniker/in für Überwachungssysteme

✈️ LUFT- & RAUMFAHRT:
- Fluggerätmechaniker/in (Fertigung)
- Fluggerätmechaniker/in (Instandhaltung)
- Fluggerätmechaniker/in (Triebwerk)
- Luftverkehrskaufmann/-frau
- Flugbegleiter/in
- Fachkraft für Bodenabfertigung
- Triebwerkmechaniker/in
- Flugzeuglackierer/in
- Mechatroniker/in (Luftfahrt)
- Luftsicherheitskontrollkraft
- Avioniker/in
- Luftfahrttechniker/in

═══════════════════════════════════════════════
🔵 DUALE STUDIENGÄNGE / FH (NUR für Fachabitur)
═══════════════════════════════════════════════
⚠️ NUR DIESE STUDIENGÄNGE bei Fachabitur verwenden!

💻 TECHNOLOGIE & COMPUTER:
- Wirtschaftsinformatik
- Cyber Security
- Software Engineering
- Data Science & Business Analytics
- Künstliche Intelligenz (KI)
- IT-Management
- Digitale Transformation
- Mobile Computing
- Cloud Computing
- Netzwerktechnik & Web-Informatik
- Angewandte Informatik
- Medieninformatik
- IT-Security Management
- E-Commerce & Web-Entwicklung
- Automatisierungsinformatik
- Technische Informatik
- Computational Engineering
- Digital Business Management
- Verwaltungsinformatik (E-Government)
- Internet der Dinge (IoT)
- Geoinformatik
- Medizininformatik
- UX/UI Design & Informatik
- Industrie 4.0 (Smart Manufacturing)
- IT-Forensik
- Robotik & Autonome Systeme

🎨 KREATIVITÄT & DESIGN:
- Mediendesign
- Kommunikationsdesign
- Marketingkommunikation & Design
- UX/UI Design
- Architektur (Bauleitung-Fokus)
- Innenarchitektur
- Produktdesign
- Industriedesign
- Digitale Medien & Animation
- Game Design
- Content Creation & Online Marketing
- Modedesign
- Textilmanagement & Design
- Visuelle Kommunikation
- Interaktive Medien
- Digital Media & Marketing
- Foto- & Videodesign
- Gestaltung & Designmanagement
- Virtual Reality Design
- Motion Design
- Medienmanagement
- Grafikdesign & Branding
- Kunst- & Kulturmanagement
- Webdesign
- Nachhaltiges Designmanagement

👥 ARBEIT MIT MENSCHEN:
- Soziale Arbeit (Jugendhilfe)
- Soziale Arbeit (Altenhilfe)
- Kindheitspädagogik
- Sozialmanagement
- Heilpädagogik
- Inklusionspädagogik
- Sozialpädagogik & Management
- Bildung & Erziehung im Kindesalter
- Wirtschaftspsychologie (HR-Fokus)
- Personalmanagement
- Management sozialer Dienstleistungen
- Rehabilitationspädagogik
- Sportmanagement
- Nonprofit Management
- Gesundheits- & Sozialmanagement
- Interkulturelles Management
- Pädagogik der frühen Kindheit
- Beratung & Coaching
- Öffentliche Verwaltung
- Kommunaler Verwaltungsdienst
- Sozialversicherungsmanagement
- Bildungsmanagement
- Gerontologie (Management)
- Sozialwirtschaft
- Mediation & Konfliktmanagement

💰 WIRTSCHAFT & FINANZEN:
- Betriebswirtschaftslehre (BWL)
- Bankwesen (Finance)
- Versicherungswirtschaft
- Steuern & Prüfungswesen
- Controlling & Management
- International Business
- Marketing Management
- Logistik & Supply Chain Management
- Immobilienwirtschaft
- Tourismusmanagement
- Eventmanagement
- Handelsmanagement (Retail)
- Personalwesen (HR)
- Wirtschaftsrecht
- E-Commerce
- Finance & Asset Management
- Digital Business
- Nachhaltigkeitsmanagement (ESG)
- Energiewirtschaft
- Gesundheitsökonomie
- Sportökonomie
- Hotel- & Gastronomiemanagement
- Wirtschaftsprüfung
- Technischer Vertrieb
- Entrepreneurship
- Public Management
- Innovationsmanagement
- Rechnungswesen & Finanzverwaltung

🏥 GESUNDHEIT & MEDIZIN:
- Pflegefachmann / Pflege (B.Sc.)
- Hebammenwissenschaft
- Physiotherapie (Duales Modell)
- Ergotherapie (Duales Modell)
- Logopädie (Duales Modell)
- Gesundheitsmanagement
- Medizintechnik
- Physician Assistant
- Gesundheitspsychologie
- Angewandte Therapiewissenschaften
- Rettungsingenieurwesen
- Pharmamanagement
- Krankenhausmanagement
- Ernährungswissenschaften
- Gesundheitsinformatik
- Fitness- & Gesundheitsmanagement
- Pflegepädagogik
- Prävention & Gesundheitsförderung
- E-Health Management
- Public Health Management

🔧 HANDWERK & INGENIEURWESEN:
- Bauingenieurwesen
- Maschinenbau
- Mechatronik
- Elektrotechnik
- Wirtschaftsingenieurwesen
- Holztechnik
- Kunststofftechnik
- Verfahrenstechnik
- Energietechnik
- Fahrzeugtechnik (Automotive)
- Baumanagement
- Projektmanagement (Bau)
- TGA (Technische Gebäudeausrüstung)
- Produktionstechnik
- Werkstofftechnik
- Lebensmitteltechnologie
- Verpackungstechnologie
- Facility Management
- Vermessungstechnik
- Umwelttechnik
- Automatisierungstechnik
- Sicherheitstechnik

🌿 NATUR, TIERE & UMWELT:
- Agrarmanagement
- Agrarwirtschaft
- Landschaftsbau & -management
- Forstwirtschaft
- Nachhaltiges Management
- Erneuerbare Energien
- Wasserwirtschaft
- Abfall- & Kreislaufwirtschaft
- Ökologische Landwirtschaft
- Gartenbau
- Lebensmittelmanagement
- Agribusiness
- Klimaschutzmanagement
- Naturschutz & Landschaftsplanung
- Forstingenieurwesen
- Umweltschutztechnik
- Bioökonomie
- Tiergesundheitsmanagement

🛡️ SICHERHEIT & SCHUTZ:
- Polizeivollzugsdienst (g.D.)
- Sicherheitsmanagement
- Kriminalistik & Kriminaltechnik
- Recht & Verwaltung (Justiz)
- Cyber Security Management
- Brandschutz & Sicherheitstechnik
- Rettungsingenieurwesen
- Zollvollzugsdienst (Gehobener Dienst)
- Gefahrenabwehr & Katastrophenschutz
- IT-Sicherheit & Forensik
- Risiko- & Krisenmanagement
- Arbeitssicherheit (HSE)
- Compliance & Wirtschaftsrecht
- Wehrtechnik (Bundeswehr)
- Informationssicherheit

✈️ LUFT- & RAUMFAHRT:
- Luft- & Raumfahrttechnik
- Aviation Management
- Flugzeugbau & Instandhaltung
- Luftverkehrsmanagement
- Avionik
- Airport Management
- Unbemannte Systeme (Drohnen)
- Luft- & Raumfahrtinformatik
- Antriebssysteme
- Leichtbau & Werkstofftechnik
- Logistik & Luftfrachtmanagement
- Space Systems Engineering
- Wirtschaftsingenieurwesen (Aviation)
- Sicherheit in der Luftfahrt

═══════════════════════════════════════════════
🟣 UNI-STUDIENGÄNGE (NUR mit Abitur)
═══════════════════════════════════════════════
⚠️ NUR DIESE STUDIENGÄNGE bei Abitur verwenden!

- Humanmedizin (Staatsexamen)
- Rechtswissenschaft / Jura (Staatsexamen)
- Zahnmedizin (Staatsexamen)
- Pharmazie (Staatsexamen)
- Lehramt an Gymnasien (Staatsexamen)
- Tiermedizin (Staatsexamen)
- Sonderpädagogik (Staatsexamen/B.A.)
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
- Bioinformatik (B.Sc.)
- Verfahrenstechnik (B.Sc.)
- Wirtschaftsrecht (B.A.)
- Theater-, Film- und Fernsehwissenschaft (B.A.)
- Religionswissenschaft / Theologie (B.A.)
- Archäologie (B.A.)
- Renewable Energy Systems (B.Sc.)
- Computational Engineering (B.Sc.)
- Gesundheitswissenschaften (B.Sc.)
- Pflegewissenschaft (B.Sc.)
- Ernährungswissenschaften (B.Sc.)
- Sportwissenschaft & Sportmedizin (B.Sc.)

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

<div class="section-container">
  <h3>⚠️ Ehrlicher Check: Deine Noten & was das bedeutet</h3>
  <p>
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

<div class="section-container">
  <h3>🔍 Was wir in DIR gesehen haben</h3>
  <p>
  [WICHTIG FÜR FORMATIERUNG IN DIESEM BLOCK:
   - Wichtige Eigenschaften und Stärken in WEISSEN GROSSBUCHSTABEN hervorheben: <strong>ANALYTISCH</strong>
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
  <p>
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
     <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+ausbildung+${locationEncoded}&ibp=htl;jobs" target="_blank" class="btn btn-accent">🔍 Google Jobs</a>
     <a href="https://www.ausbildung.de/suche?what=[BERUFSBEZEICHNUNG]&where=${locationEncoded}" target="_blank" class="btn">📋 Ausbildung.de</a>
     <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]+ausbildung&l=${locationEncoded}" target="_blank" class="btn">💼 Indeed</a>
     <a href="https://www.arbeitsagentur.de/jobsuche/suche?was=[BERUFSBEZEICHNUNG]+Ausbildung&wo=${locationEncoded}" target="_blank" class="btn">🏛️ Arbeitsagentur</a>
     <a href="https://www.azubiyo.de/berufe/?q=[BERUFSBEZEICHNUNG]" target="_blank" class="btn">🎓 Azubiyo</a>
   </div>

   WENN ÖFFENTLICHER DIENST (Verwaltung, Zoll, Polizei, Bundeswehr, Bundesbehörden):
   <h4>📍 Stellen im öffentlichen Dienst in ${location}:</h4>
   <div class="job-search-buttons">
     <a href="https://www.bund.de/DE/Service/Stellen/stellen_node.html" target="_blank" class="btn btn-accent">🇩🇪 Bund.de – Bundesstellen</a>
     <a href="https://www.arbeitsagentur.de/jobsuche/suche?was=[BERUFSBEZEICHNUNG]&wo=${locationEncoded}" target="_blank" class="btn">🏛️ Arbeitsagentur</a>
     <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+öffentlicher+Dienst+${locationEncoded}&ibp=htl;jobs" target="_blank" class="btn">🔍 Google Jobs</a>
     <a href="https://www.ausbildung.de/berufe/suche/?q=[BERUFSBEZEICHNUNG]" target="_blank" class="btn">📋 Ausbildung.de – Berufsprofil</a>
   </div>

   WENN STUDIUM:
   <h4>📍 Studiengänge finden in ${location}:</h4>
   <div class="job-search-buttons">
     <a href="https://www.google.com/search?q=[STUDIENGANG]+Studium+${location}" target="_blank" class="btn btn-accent">🎓 Google – Studiengang suchen</a>
     <a href="https://www.studycheck.de/suche?q=[STUDIENGANG]&location=${locationEncoded}" target="_blank" class="btn">📚 StudyCheck</a>
     <a href="https://www.google.com/search?q=[STUDIENGANG]+Studium+Deutschland+Hochschule+site:hochschulkompass.de" target="_blank" class="btn">🏛️ Hochschulkompass</a>
     <a href="https://www.google.com/search?q=[STUDIENGANG]+duales+Studium+${location}" target="_blank" class="btn">💼 Duales Studium</a>
     <a href="https://www.arbeitsagentur.de/jobsuche/suche?was=[STUDIENGANG]&wo=${locationEncoded}&angebotsart=4" target="_blank" class="btn">🏛️ Arbeitsagentur – Studium</a>
   </div>

   WENN BERUFSTÄTIGE/ABSOLVENTEN:
   <h4>📍 Jobs in ${location}:</h4>
   <div class="job-search-buttons">
     <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+${locationEncoded}&ibp=htl;jobs" target="_blank" class="btn btn-accent">🔍 Google Jobs</a>
     <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]&l=${locationEncoded}" target="_blank" class="btn">💼 Indeed</a>
     <a href="https://www.stepstone.de/jobs/[BERUFSBEZEICHNUNG]/in-${locationEncoded}" target="_blank" class="btn">📋 StepStone</a>
     <a href="https://www.arbeitsagentur.de/jobsuche/suche?was=[BERUFSBEZEICHNUNG]&wo=${locationEncoded}" target="_blank" class="btn">🏛️ Arbeitsagentur</a>
     <a href="https://www.ausbildung.de/berufe/suche/?q=[BERUFSBEZEICHNUNG]" target="_blank" class="btn">📋 Ausbildung.de – Berufsprofil</a>
   </div>

   **Karriere-Turbo:** Weiterbildung + konkreter Gehaltssprung (bereits in success-box oben)
   
   **Warum dieser Beruf zu DIR passt:** Konkrete Bezüge zu Stärken und Interessen

   **📋 STECKBRIEF – Was auf DICH zukommt:**
   
   <h4>📋 Steckbrief – Was auf DICH zukommt</h4>
   <div class="info-box">
   
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
   <div class="info-box">
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

   Gruppe Staatsberufe → Einstellungstest, Sporttest, Bewerbungslink, KEIN Udemy
   Gruppe IT/Technik → CS50/edX, Python codecademy, Google/Microsoft Zertifikat
   Gruppe Kreativ → Tool (Canva/Blender), Portfolio auf Behance/Instagram
   Gruppe Handwerk/Pflege → Erste-Hilfe-Schein, YouTube Arbeitsalltag
   Gruppe BWL/Kaufmännisch → Excel YouTube, Canva Bewerbung, Handelsblatt App
   Gruppe Uni/NC → NC-Vorbereitung, Hochschulstart.de, Wartesemester
     <h3>📚 Nächste Schritte & Tipps für DEINE Karrierewege</h3>
     
     <h4>[EXAKTER BERUFSNAME KARRIEREWEG 1]:</h4>
     <ul>
       <li><strong>[Passender Label je Gruppe – z.B. "Einstellungstest" / "Kostenlos üben" / "Tool" / "Skill"]:</strong> [Konkreter Tipp NUR für diesen Beruf]</li>
       <li><strong>[Passender Label]:</strong> [Konkreter Tipp]</li>
       <li><strong>[Passender Label]:</strong> [Konkreter Tipp]</li>
     </ul>
     
     <h4>[EXAKTER BERUFSNAME KARRIEREWEG 2]:</h4>
     <ul>
       <li><strong>[Passender Label je Gruppe]:</strong> [Konkreter Tipp NUR für diesen Beruf]</li>
       <li><strong>[Passender Label]:</strong> [Konkreter Tipp]</li>
       <li><strong>[Passender Label]:</strong> [Konkreter Tipp]</li>
     </ul>
     
     <h4>[EXAKTER BERUFSNAME KARRIEREWEG 3]:</h4>
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
   Staatsberufe: YouTube Tag bei [Beruf], offizielles Portal, Sporttest vorbereiten, Bewerbungsfrist, Aufstieg
   Ausbildung: YouTube Azubi Alltag, Azubiyo Profil, Schnupperpraktikum, Canva+ChatGPT Bewerbung, Meister/Aufstieg
   Duales Studium: YouTube Erfahrung, ausbildungsplatz.de, zuerst Firma dann FH, Assessment Center, Master
   Uni/NC: hochschulstart.de NC checken, Fächer für NC, Plan B Wartesemester, Fristen 15.Jan/15.Jul, Spezialisierung

   🚨 PFLICHT: Der 5-Stufen-Plan bezieht sich IMMER auf KARRIEREWEG 1 – nicht auf Karriereweg 2 oder 3!

   <div class="section-container">
     <h3>🎯 DEIN 5-Stufen-Erfolgsplan – [KARRIEREWEG 1 NAME einsetzen]</h3>
     <div class="step-item">
       <span class="step-number">1</span>
       <div class="step-content"><strong>⚡ Der "Quick-Win" (Heute – 5 Min.):</strong> [Gruppe von KW1 erkennen → YouTube-Suchbegriff für KW1 nennen – NIEMALS Kanalnamen erfinden!]</div>
     </div>
     <div class="step-item">
       <span class="step-number">2</span>
       <div class="step-content"><strong>🔍 Der "Reality-Check" (Diese Woche – 15 Min.):</strong> [Gruppe von KW1 → konkreter Schritt mit echten Links/Plattformen für KW1]</div>
     </div>
     <div class="step-item">
       <span class="step-number">3</span>
       <div class="step-content"><strong>🎯 Das "Insider-Manöver" (Nächste 1-2 Wochen):</strong> [Gruppe von KW1 → Fuß in die Tür, echte Firma/Institution für KW1 nennen]</div>
     </div>
     <div class="step-item">
       <span class="step-number">4</span>
       <div class="step-content"><strong>🚀 Die "Bewerbungs-Abkürzung" (Nächste 2-3 Wochen):</strong> [Gruppe von KW1 → Bewerbung schnell + schlau für KW1, NICHT "nächsten Monat"!]</div>
     </div>
     <div class="step-item">
       <span class="step-number">5</span>
       <div class="step-content"><strong>💰 Der "Zukunfts-Check" (Langfristig):</strong> [Gruppe von KW1 → konkreter Aufstieg + echte Gehaltszahlen für KW1]</div>
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
  <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+ausbildung+${locationEncoded}&ibp=htl;jobs" target="_blank" class="btn btn-accent">🔍 Ausbildungsplätze finden</a>
  <a href="https://www.ausbildung.de/suche?what=[BERUFSBEZEICHNUNG]&where=${locationEncoded}" target="_blank" class="btn">📋 Auf Ausbildung.de suchen</a>
  <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]+ausbildung&l=${locationEncoded}" target="_blank" class="btn">💼 Auf Indeed suchen</a>
</div>

**JOB-SUCH-BUTTONS FÜR STUDIUM:**
<div class="job-search-buttons">
  <a href="https://www.google.com/search?q=[STUDIENGANG]+Studium+${location}" target="_blank" class="btn btn-accent">🎓 Studiengang suchen</a>
  <a href="https://www.studycheck.de/suche?q=[STUDIENGANG]&location=${locationEncoded}" target="_blank" class="btn">📚 StudyCheck</a>
  <a href="https://www.google.com/search?q=[STUDIENGANG]+duales+Studium+${location}" target="_blank" class="btn">💼 Duales Studium</a>
</div>

**JOB-SUCH-BUTTONS FÜR BERUFSTÄTIGE/ABSOLVENTEN:**
<div class="job-search-buttons">
  <a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+${locationEncoded}&ibp=htl;jobs" target="_blank" class="btn btn-accent">🔍 Jobs auf Google finden</a>
  <a href="https://de.indeed.com/jobs?q=[BERUFSBEZEICHNUNG]&l=${locationEncoded}" target="_blank" class="btn">💼 Auf Indeed suchen</a>
  <a href="https://www.stepstone.de/jobs/[BERUFSBEZEICHNUNG]/in-${locationEncoded}" target="_blank" class="btn">📋 Auf StepStone suchen</a>
</div>

**🚨 PFLICHT – ALLE 3 KARRIEREWEGE MÜSSEN AM ENDE DIESE 3 BLÖCKE HABEN:**

Block A) 🔮 Zukunft & Jobmarkt-Trend (wie oben beschrieben)

Block B) 🎯 Warum dieser Weg zu DIR passt:
<h4>🎯 Warum dieser Weg zu DIR passt:</h4>
<div class="info-box">
  <p>[Konkrete Begründung mit direktem Bezug auf Stärken, Flow, Interessen, Prioritäten]</p>
</div>

Block C) 🔀 3 ähnliche Alternativen:
<h4>🔀 2 ähnliche Alternativen die ebenfalls passen könnten:</h4>
<div class="info-box">
  <p><strong>Alternative 1:</strong> [Beruf] – [Warum + Unterschied]</p>
  <p><strong>Alternative 2:</strong> [Beruf] – [Warum + Unterschied]</p>
  <p><strong>Alternative 3:</strong> [Beruf] – [Warum + Unterschied]</p>
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
<a href="https://www.google.com/search?q=[BERUFSBEZEICHNUNG]+Praktikum+${locationEncoded}" target="_blank" class="btn">🎯 Praktikum finden</a>
` : ''}

**🏭 LOKALE FIRMEN – PFLICHT:**
Nenne bei jedem Karriereweg 1-2 echte Firmen aus ${location} die in diesem Bereich ausbilden/einstellen. Keine generischen Aussagen.
`;

        // Bildungsweg-Regel dynamisch berechnen
        const bildungswegRegel = (formData.education === 'abitur' || formData.education === 'abitur_ziel')
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

        const reviewPrompt = `Du bist ein kritischer Qualitätsprüfer für KI-generierte Karriereanalysen. 
Deine Aufgabe: Prüfe die folgende Analyse STRIKT auf Fehler und gib NUR die korrigierte, fertige HTML-Version zurück.

NUTZERPROFIL ZUR PRÜFUNG:
- Bildungsabschluss: ${formData.education}
- Noten: Deutsch ${formData.note_deutsch || 'k.A.'} | Mathe ${formData.note_mathe || 'k.A.'} | Englisch ${formData.note_englisch || 'k.A.'} | Rest: ${formData.noten_rest || 'k.A.'}
- Anti-Job (was der User NICHT will): ${Array.isArray(formData.anti_job) ? formData.anti_job.join(', ') : formData.anti_job}
- Persönlichkeitsrolle: ${Array.isArray(formData.rolle) ? formData.rolle.join(', ') : (formData.rolle || 'k.A.')}
- Interessen: ${Array.isArray(formData.interests) ? formData.interests.join(', ') : formData.interests}
${formData.security_art ? `- **SICHERHEIT-UNTERPUNKTE: ${Array.isArray(formData.security_art) ? formData.security_art.join(', ') : formData.security_art}** → NUR öffentlicher Dienst/staatliche Berufe! NIEMALS private Sicherheitsfirmen, Wachdienst, Sicherheitsunternehmen! Erlaubt: Polizei, Bundeswehr, Feuerwehr, Zoll, Notfallsanitäter.` : ''}
${formData.aviation_art ? `- **LUFTFAHRT-UNTERPUNKTE: ${Array.isArray(formData.aviation_art) ? formData.aviation_art.join(', ') : formData.aviation_art}** → Muss in konkretem Luftfahrtberuf resultieren!` : ''}
${formData.tech_art ? `- Technologie-Unterpunkte: ${Array.isArray(formData.tech_art) ? formData.tech_art.join(', ') : formData.tech_art}` : ''}
${formData.business_art ? `- Wirtschaft-Unterpunkte: ${Array.isArray(formData.business_art) ? formData.business_art.join(', ') : formData.business_art}` : ''}
${formData.health_art ? `- Gesundheit-Unterpunkte: ${Array.isArray(formData.health_art) ? formData.health_art.join(', ') : formData.health_art}` : ''}
- Flow-Aktivität: ${formData.flow_activity || 'k.A.'}
- Energie-Quellen: ${Array.isArray(formData.energy) ? formData.energy.join(', ') : (formData.energy || 'k.A.')}
- Arbeitsstil: ${Array.isArray(formData.work_style) ? formData.work_style.join(', ') : (formData.work_style || 'k.A.')}
- Routine/Abwechslung: ${Array.isArray(formData.routine) ? formData.routine.join(', ') : (formData.routine || 'k.A.')}
- Risikobereitschaft: ${Array.isArray(formData.risk) ? formData.risk.join(', ') : (formData.risk || 'k.A.')}
- Prioritäten: ${Array.isArray(formData.priority) ? formData.priority.join(', ') : (formData.priority || 'k.A.')}
- Standort: ${location}

PRÜFLISTE – checke jeden Punkt:

1. PLATZHALTER-CHECK:
   ❌ Gibt es noch eckige Klammern [ ] im Text? → Alle ersetzen mit echten Werten!
   ❌ Steht irgendwo "[Karriereweg 1]", "[BERUFSBEZEICHNUNG]", "[X]", "[Konkret]"? → Sofort ersetzen!

2. NOTEN-REALITÄTS-CHECK:
   - Wurde ein Studium (Medizin, Jura, Pharmazie) mit einem Notenschnitt von 4,0 oder schlechter empfohlen? → Unrealistisch! Ersetze durch passende Alternative!
   - Wurde eine kompetitive IT/Bank/Versicherungs-Ausbildung bei Note 4-5 empfohlen? → Unrealistisch! Durch Handwerk/Pflege/Gastronomie ersetzen!
   - Gibt es einen Rettungsplan-Block wenn die Noten eine Hürde darstellen? → Falls nicht: einfügen!

3. ANTI-JOB-CHECK:
   - Wurde ein Beruf empfohlen der direkt dem Anti-Job widerspricht?
   Beispiele: Anti-Job "Mathe" → kein Ingenieursstudium | Anti-Job "Körperlich" → kein Handwerksberuf | Anti-Job "Einzel" → kein Solo-Freelancer
   → Falls Widerspruch: Beruf durch passende Alternative ersetzen!

4. BILDUNGSABSCHLUSS-CHECK:
   - Fachabitur → wurde eine Uni (keine FH!) empfohlen? → Durch FH ersetzen!
   - Realschule/Hauptschule → wurde ein Studium ohne 2. Bildungsweg empfohlen? → Durch Ausbildung ersetzen!
   - Abitur → wurde mindestens 1 Studiengang empfohlen? → Falls nicht: ergänzen!

5. HTML-QUALITÄTS-CHECK:
   - Gibt es kaputte HTML-Tags (nicht geschlossene div, table, etc.)? → Reparieren!
   - Gibt es Markdown (##, **, ---)? → In HTML-Tags umwandeln!
   - Fehlen Gehaltstabellen bei einem Karriereweg? → Einfügen!
   - Fehlen Job-Buttons bei einem Karriereweg? → Einfügen!

6. DUPLIKAT-CHECK:
   - Kommt ein Beruf mehrfach vor (als Hauptweg UND als Alternative)? → Duplicate entfernen, anderen Beruf wählen!

7. PERSÖNLICHKEITSROLLEN-CHECK:
   - Werden die Rollen (${Array.isArray(formData.rolle) ? formData.rolle.join(', ') : (formData.rolle || 'k.A.')}) wörtlich in der Analyse erwähnt? → Falls nicht: einbauen!

8. PSYCHOLOGIE-CHECK – INTER-SOURCE-VALIDATION:
   Prüfe ob die empfohlenen Berufe zum psychologischen Gesamtprofil passen.
   Vergleiche ALLE folgenden Kombinationen und korrigiere bei Widerspruch:

   ROLLE vs. BERUF:
   - Rolle "Denker" + Beruf mit reiner Routine (z.B. Lagerist, Kassier) → WIDERSPRUCH! Denker brauchen komplexe Probleme → durch analytischen Beruf ersetzen!
   - Rolle "Macher" + reiner Schreibtischjob ohne sichtbare Ergebnisse → WIDERSPRUCH! Macher brauchen Hands-on-Tätigkeiten!
   - Rolle "Kreativer" + Beruf mit starren Regeln ohne Gestaltungsspielraum (z.B. Verwaltungsfachangestellter) → WIDERSPRUCH! Kreativer braucht Freiraum!
   - Rolle "Kommunikator" + Beruf ohne Menschenkontakt (z.B. Programmierer alleine) → WIDERSPRUCH! Kommunikator braucht Interaktion!
   - Rolle "Planer" + chaotischer Kreativberuf ohne Struktur → WIDERSPRUCH! Planer braucht Struktur und klare Prozesse!
   - Rolle "Teamplayer" + Solo-Selbstständigkeit oder Einzelkämpfer-Beruf → WIDERSPRUCH! Teamplayer braucht Kollegen!

   ENERGIE vs. ARBEITSUMGEBUNG:
   - Energie aus "Ruhe/Konzentration" + Beruf im Großraumbüro, Call-Center oder mit ständigem Lärm → WIDERSPRUCH! → ruhigeren Beruf wählen!
   - Energie aus "Menschen/Team" + einsamer Beruf (Nachtwächter, Lkw-Fahrer alleine) → WIDERSPRUCH! → sozialen Beruf wählen!
   - Energie aus "körperlicher Aktivität" + reiner Bürojob → WIDERSPRUCH! → aktiven Beruf wählen!
   - Energie aus "kreativen Aufgaben" + rein ausführender Beruf ohne Eigeninitiative → WIDERSPRUCH! → kreativeren Beruf wählen!

   ROUTINE vs. BERUF:
   - User mag "Routine/klare Abläufe" + Beruf mit ständig wechselnden Projekten (Eventmanager, Journalist) → WIDERSPRUCH! → strukturierteren Beruf wählen!
   - User mag "Abwechslung/neue Herausforderungen" + reiner Routineberuf (Fließbandarbeit, Dateneingabe) → WIDERSPRUCH! → abwechslungsreicheren Beruf wählen!

   FLOW-AKTIVITÄT vs. BERUF:
   - Flow "Dinge reparieren/bauen" + reiner Büro-/Verwaltungsberuf → WIDERSPRUCH! → handwerklich-technischen Beruf wählen!
   - Flow "Mit Menschen arbeiten/helfen" + technischer Einzelberuf ohne Kundenkontakt → WIDERSPRUCH! → sozialen oder beratenden Beruf wählen!
   - Flow "Analysieren/Verstehen" + ausführender Beruf ohne Denkaufgaben → WIDERSPRUCH! → analytischen Beruf wählen!
   - Flow "Gestalten/Kreieren" + normativer Beruf ohne Kreativspielraum → WIDERSPRUCH! → kreativeren Beruf wählen!

   RISIKO vs. BERUF:
   - Risikobereitschaft "sehr niedrig/Sicherheit wichtig" + Beruf in unsicherer Branche oder Startup-Umfeld → WIDERSPRUCH! → krisensicheren Beruf (öffentlicher Dienst, Handwerk) wählen!
   - Risikobereitschaft "hoch/Abenteuerlust" + rein beamteter Beruf ohne Dynamik → SUBOPTIMAL! → Hinweis in der Analyse ergänzen!

   INTER-SOURCE-VALIDATION – KOMBINATIONSCHECK:
   Prüfe ob Flow-Aktivität + dominante Rolle + Anti-Job gleichzeitig im empfohlenen Beruf erfüllt sind:
   - Flow "${formData.flow_activity || 'k.A.'}" muss sich im Beruf wiederfinden
   - Rolle "${Array.isArray(formData.rolle) ? formData.rolle.join(', ') : (formData.rolle || 'k.A.')}" muss im Berufsalltag gelebt werden können
   - Anti-Job "${Array.isArray(formData.anti_job) ? formData.anti_job.join(', ') : formData.anti_job}" darf KEIN Kernbestandteil des Berufs sein
   → Wenn alle 3 gleichzeitig erfüllt: ✅ Beruf ist valide
   → Wenn einer fehlt: ❌ Beruf durch bessere Kombination ersetzen und Begründung in der Analyse ergänzen!

   BEI KORREKTUR GILT:
   - Ersetze den Beruf durch einen der alle 3 Kriterien erfüllt
   - Erkläre in der "Warum dieser Weg zu DIR passt" Box konkret warum der neue Beruf besser passt
   - NIEMALS einfach den Berufsnamen ändern ohne die Begründung anzupassen!

WICHTIG – DEINE AUSGABE:
- Gib NUR das fertige, korrigierte HTML zurück!
- KEIN Kommentar, KEINE Erklärung was du geändert hast!
- KEIN Markdown!
- Wenn alles korrekt ist → gib die Analyse unverändert zurück!
- Die Ausgabe wird direkt in eine Webseite eingebettet!

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

// Start server
app.listen(PORT, () => {
    console.log('=================================');
    console.log('✅ SERVER LÄUFT auf Port', PORT);
    console.log('🆕 Partner-Endpoint aktiv!');
    console.log('🤖 Chatbot-Endpoint aktiv!');
    console.log('🔍 "KI hat dich durchschaut" Block aktiv!');
    console.log('🔄 Review-Loop (Call 3) aktiv!');
    console.log('=================================');
});

module.exports = app;
