/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: General-purpose AI Research & Synthesis Engine.
 * Features: Pluto-X, Ghost Mode Debugger (Elite Simplicity 3.0), Standard Chat.
 * Failover Logic: Multi-Key Rotation + Triple-Model Switching.
 * Identity: Developed by Spectrum SyntaX.
 * Persona: Gen Z Mixed (Locked in, fr, no cap) + Elite Technical Clarity.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); 
const puppeteer = require('puppeteer'); 
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

/**
 * API KEY POOL
 * Supports multiple accounts. Provide as: "key_acc1, key_acc2, key_acc3" in your env.
 * The system will exhaust ALL keys for the best model before falling back.
 */
const API_KEYS = (process.env.LLAMA_API_KEY || "").split(',').map(k => k.trim()).filter(k => k);
let currentKeyIndex = 0;

const LLAMA_API_URL = process.env.LLAMA_API_URL || "https://api.groq.com/openai/v1/chat/completions";

/**
 * INTELLIGENCE TIERS (Triple-Model Failover)
 * Standardized Groq IDs to ensure failover works without 404 errors.
 */
const MODELS = [
    "llama-3.3-70b-versatile", // Tier 1: Max Intelligence (Priority)
    "llama3-70b-8192",         // Tier 2: Mid-tier Logic
    "llama3-8b-8192"           // Tier 3: Ultimate Reliability Safety Net
];

// Global browser instance for singleton pattern (Crucial for Render RAM limits)
let globalBrowser = null;
let activeScrapes = 0;
const MAX_CONCURRENT_SCRAPES = 1; 

/**
 * Concurrency Queue to handle multiple users on Render's RAM limits
 */
async function waitForTurn() {
    while (activeScrapes >= MAX_CONCURRENT_SCRAPES) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    activeScrapes++;
}

/**
 * Chrome path resolution for Docker/Render environments
 */
function resolveChromePath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const dockerPath = '/usr/bin/google-chrome-stable';
    if (fs.existsSync(dockerPath)) return dockerPath;
    try {
        const dynamicPath = execSync('which google-chrome-stable || which google-chrome || which chromium').toString().trim();
        if (dynamicPath && fs.existsSync(dynamicPath)) return dynamicPath;
    } catch (e) {}
    return dockerPath;
}

/**
 * Singleton Browser Management
 */
async function getBrowser() {
    if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
    const chromePath = resolveChromePath();
    globalBrowser = await puppeteer.launch({ 
        executablePath: chromePath,
        headless: "new", 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process', '--disable-gpu'] 
    });
    return globalBrowser;
}

/**
 * Scrub boilerplate and noise from scraped text
 */
function sanitizeScrapedContent(text) {
    if (!text) return "";
    return text
        .replace(/Terms of Service|Privacy Policy|Cookie Preferences|Report conversation|By messaging ChatGPT|Check important info|Sign in|Explore our other|Try Gemini|Try ChatGPT|Verify you are human/gi, "")
        .replace(/[^\x20-\x7E\n]/g, " ") 
        .trim()
        .substring(0, 18000);
}

/**
 * Pluto-X Scraper - Optimized for modern AI share links with auto-scroll
 */
async function extractConversationData(url) {
    let page;
    await waitForTurn();
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        // Stealth headers to bypass basic bot detection
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) { req.abort(); } 
            else { req.continue(); }
        });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Auto-scroll to ensure all lazy-loaded messages are captured
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0, distance = 250;
                let timer = setInterval(() => {
                    let scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if(totalHeight >= scrollHeight){ clearInterval(timer); resolve(); }
                }, 100);
            });
        });

        await new Promise(r => setTimeout(r, 4000));

        const result = await page.evaluate(() => {
            const selectors = ['.markdown', '.message-content', '.model-response-text', 'div[data-message-author-role]', 'article', '.p-4.md\\:p-6', '.conversation-container', 'div[class*="message"]', 'div[class*="content"]', 'main'];
            let data = [];
            selectors.forEach(s => {
                document.querySelectorAll(s).forEach(el => {
                    const txt = el.innerText.trim();
                    if (txt.length > 60) data.push(txt);
                });
            });
            return { content: data.join('\n\n---\n\n') };
        });
        
        await page.close();
        activeScrapes--;
        return sanitizeScrapedContent(result.content);
    } catch (e) {
        if (page) await page.close();
        activeScrapes--;
        return `DATA_ERROR: ${e.message}`;
    }
}

/**
 * Robust JSON Extractor
 */
function extractJSON(text) {
    try {
        const first = text.indexOf('{');
        const last = text.lastIndexOf('}');
        if (first === -1 || last === -1) return null;
        return JSON.parse(text.substring(first, last + 1));
    } catch (e) {
        return null;
    }
}

/**
 * callLlamaSmart: The Ultimate Failover Core
 */
async function callLlamaSmart(messages, isJson = false) {
    const rotateKey = () => {
        currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
        console.log(`🔑 Rotating to Account Key Index: ${currentKeyIndex}`);
    };

    const tryModelWithRotation = async (modelName) => {
        let keysTriedForThisModel = 0;

        while (keysTriedForThisModel < API_KEYS.length) {
            const currentKey = API_KEYS[currentKeyIndex];
            try {
                const response = await fetch(LLAMA_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentKey}` },
                    body: JSON.stringify({ 
                        model: modelName, 
                        messages, 
                        temperature: isJson ? 0.1 : 0.7, 
                        max_tokens: 8192 
                    })
                });
                const result = await response.json();
                
                if (response.status === 429 || (result.error && result.error.type === 'rate_limit_reached')) {
                    console.warn(`⚠️ Account Key Index ${currentKeyIndex} hit limit on ${modelName}. Rotating...`);
                    rotateKey();
                    keysTriedForThisModel++;
                    continue; 
                }

                if (!response.ok) throw new Error(result.error?.message || `API Error: ${response.status}`);
                return result;
            } catch (err) {
                if (err.message && err.message.includes("fetch")) throw err; 
                rotateKey();
                keysTriedForThisModel++;
            }
        }
        throw { name: "AllKeysExhausted", message: `All account keys exhausted for ${modelName}` };
    };

    let lastError = null;
    for (const modelName of MODELS) {
        try {
            console.log(`🚀 Requesting logic with ${modelName}...`);
            return await tryModelWithRotation(modelName);
        } catch (error) {
            lastError = error;
            if (error.name === "AllKeysExhausted") {
                console.warn(`🚨 Intelligence Tier ${modelName} fully exhausted across all accounts. Moving to safety tier...`);
                continue; 
            }
            console.error(`❌ System error with ${modelName}: ${error.message}`);
        }
    }
    throw new Error(`CRITICAL: Every account and every fallback model has hit its limit. Pluto is offline until reset. fr.`);
}

/**
 * GHOST MODE DEBUGGER API
 * Feature: Elite Simplicity 3.0 + ML support + Language Specific Lockdown.
 */
app.post('/api/debug', async (req, res) => {
    const { code, language } = req.body;

    const accuracyRules = language === 'c' ? `
        CRITICAL ACCURACY RULES (C-SPECIFIC LOCKDOWN):
        1. You are a physical line-by-line scanner. 
        2. TOTAL SYNCHRONIZATION: You MUST generate exactly one step for EVERY physical line provided in the code, starting from Line 1 to the end.
        3. NO SKIPPING: Even if a line is empty, contains only a bracket '{' or '}', or a comment, you MUST create a step for it.
        4. MANDATORY COMMENTARY FOR NON-LOGIC LINES:
           - If the line is '{' -> Commentary: "Scope start / Opening bracket."
           - If the line is '}' -> Commentary: "Scope end / Closing bracket."
           - If the line is EMPTY -> Commentary: "Empty line / Whitespace."
           - If the line is a COMMENT -> Commentary: "Code documentation/comment."
        5. DO NOT EXPLAIN THE NEXT LINE'S LOGIC ON A BRACKET LINE. Wait until you physically reach that line number.
        6. MEMORY PERSISTENCE: The "memory" object MUST contain the full, current state of ALL variables in scope. Even on bracket or empty lines, you MUST list all variables and their current values. NEVER send an empty {} if variables have been defined earlier.
        7. The "line" integer in your JSON must increment perfectly (1, 2, 3...) unless the code actually jumps (like a loop).
    ` : `
        CRITICAL ACCURACY RULES:
        1. Point EXACTLY to the code line where logic happens.
        2. Include EVERY physical line number exactly as it appears in the provided source code.
        3. DO NOT SKIP lines containing only brackets like '{' or '}', comments, or whitespace. Every physical line must be counted.
        4. BRACKET TRACKING: Whenever you encounter a line with { or }, you MUST count its physical line number. In the "commentary," briefly mention "Scope opened" or "Scope closed" to stay synced.
        5. MEMORY PERSISTENCE: The "memory" object MUST contain the full state of all variables. Do not send {} on bracket steps.
        6. Every step MUST include: 
           - "line": (integer) The EXACT physical line number.
           - "memory": (object) Current variable states. Use {} if empty. NEVER leave as undefined.
           - "commentary": (string) Technical explanation.
           - "analogy": (string) A real-world ELI5 comparison.
        7. If code involves pointers or nodes, represent them as strings like "Node(5)".
        8. Do NOT skip logic milestones. Trace accurately for beginners.
    `;

    try {
        const result = await callLlamaSmart([
            { 
                role: "system", 
                content: `You are the Ghost Mode Debugger by Spectrum SyntaX. 
                Trace the provided ${language} code line-by-line. 
                Return strictly a JSON object with a "steps" array.

                ${accuracyRules}
                
                Return JSON ONLY.` 
            },
            { role: "user", content: `CODE:\n${code}` }
        ], true);

        const trace = extractJSON(result.choices?.[0]?.message?.content);
        if (!trace || !trace.steps) throw new Error("AI returned malformed trace data.");
        res.json({ success: true, trace });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * INITIALIZATION API (Pluto-X Research Synthesis)
 */
app.post('/api/initialize', async (req, res) => {
    const { links, title } = req.body;
    try {
        let validData = "";
        if (links && links.length > 0) {
            const transcripts = [];
            for (const l of links) if (l.url) transcripts.push(await extractConversationData(l.url));
            validData = transcripts.filter(t => !t.startsWith("DATA_ERROR")).join('\n\n');
        }

        const systemPrompt = `You are Pluto Intelligence, an elite synthesizer developed by Spectrum SyntaX. 
        
        PERSONA RULES:
        1. Greet with massive Gen Z vibes (fr, no cap, locked in).
        2. IDENTITY: Mention you are developed by Spectrum SyntaX.
        3. DYNAMIC BEHAVIOR:
           - If research data IS provided: Synthesize Gemini and ChatGPT perspectives into a professional Technical Brief.
           - If NO research data is provided (Standard Session): Greet the user and ask what we are cooking today.`;

        const result = await callLlamaSmart([
            { role: "system", content: systemPrompt },
            { role: "user", content: validData ? `DATA:\n${validData}\nTOPIC: ${title}` : `Initialize Standard Session. Greet user and wait for instructions.` }
        ]);
        
        res.json({ success: true, foundation: result.choices?.[0]?.message?.content });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * INTERACTIVE CHAT API
 */
app.post('/api/chat', async (req, res) => {
    const { foundation, history } = req.body;
    try {
        const messages = [
            { 
                role: "system", 
                content: `You are Pluto Intelligence by Spectrum SyntaX. No cap.
                Use Gen Z slang for transitions and professional clarity for technical facts. 
                Context for this session: \n\n${foundation}` 
            },
            ...history
        ];
        const result = await callLlamaSmart(messages);
        res.json({ success: true, reply: result.choices?.[0]?.message?.content });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Pluto Multi-Account Triple-Failover Backend Active on port ${PORT}`));