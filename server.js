/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: General-purpose AI Research & Synthesis Engine.
 * Features: Pluto-X, Ghost Mode Debugger (Elite Simplicity 3.0), Standard Chat.
 * Failover Logic: Triple-Model Switching (Primary -> Secondary -> Tertiary).
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
const LLAMA_API_KEY = process.env.LLAMA_API_KEY;
const LLAMA_API_URL = process.env.LLAMA_API_URL || "https://api.groq.com/openai/v1/chat/completions";

// TRIPLE MODEL CONFIGURATION (Failover Chain)
// Correct IDs for Groq API: High Intelligence -> Stable Backups
const MODELS = [
    "llama-3.3-70b-versatile", // Tier 1: Max Intelligence (Daily limit ~100k tokens)
    "llama3-70b-8192",         // Tier 2: Mid-tier Logic (Independent limit bucket)
    "llama3-8b-8192"           // Tier 3: High Speed/Throughput (Ultimate safety net)
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
 * Pluto-X Scraper - Optimized for modern AI share links
 */
async function extractConversationData(url) {
    let page;
    await waitForTurn();
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) { req.abort(); } 
            else { req.continue(); }
        });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Auto-scroll to capture lazy-loaded knowledge
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0, distance = 200;
                let timer = setInterval(() => {
                    let scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if(totalHeight >= scrollHeight){ clearInterval(timer); resolve(); }
                }, 150);
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
 * Enhanced AI Call with Triple-Model Failover Switching
 * Logic: Cycles through Tier 1 -> Tier 2 -> Tier 3 on Rate Limits
 */
async function callLlamaSmart(messages, isJson = false) {
    const tryCall = async (modelName, retries = 2) => {
        const delays = [1000, 2000];
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(LLAMA_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLAMA_API_KEY}` },
                    body: JSON.stringify({ 
                        model: modelName, 
                        messages, 
                        temperature: isJson ? 0.2 : 0.7, 
                        max_tokens: 8192 
                    })
                });
                const result = await response.json();
                
                // Signal failover on 429 or daily token limit exhaustion
                if (response.status === 429 || (result.error && result.error.type === 'rate_limit_reached')) {
                    throw { name: "RateLimitError", message: `Limit reached for ${modelName}` };
                }

                if (!response.ok) throw new Error(result.error?.message || `API Error: ${response.status}`);
                return result;
            } catch (err) {
                if (err.name === "RateLimitError") throw err; 
                if (i === retries - 1) throw err;
                await new Promise(res => setTimeout(res, delays[i]));
            }
        }
    };

    let lastError = null;
    for (const modelName of MODELS) {
        try {
            console.log(`🚀 Attempting request with ${modelName}...`);
            return await tryCall(modelName);
        } catch (error) {
            lastError = error;
            if (error.name === "RateLimitError") {
                console.warn(`⚠️ ${modelName} rate limited. Attempting next fallback...`);
                continue; 
            }
            console.error(`❌ Error with ${modelName}: ${error.message}`);
        }
    }
    throw new Error(`All models exhausted. Last error: ${lastError?.message}`);
}

/**
 * GHOST MODE DEBUGGER API (Elite Simplicity 3.0)
 * Handles Algos, ML, and Data Structures for zero-knowledge users.
 */
app.post('/api/debug', async (req, res) => {
    const { code, language } = req.body;
    try {
        const result = await callLlamaSmart([
            { 
                role: "system", 
                content: `You are the Ghost Mode Debugger by Spectrum SyntaX. 
                Trace the following ${language} code. Return a JSON object with a "steps" array.

                CRITICAL RULES:
                1. TARGET: Beginners with ZERO coding knowledge. 
                2. ANALOGY: Provide a real-world ELI5 'analogy' for every single step.
                3. COMPLEXITY: 
                   - ML: Weights -> "Influence," Learning Rate -> "Step Size," Tensors -> "Grids."
                   - Lists: Nodes -> "Train Cars."
                4. POINTER SAFETY: Objects/Nodes MUST be represented as simple strings like "Node(5)" to avoid JSON breakage.
                5. BIG CODE: Max 30 steps. Focus on high-impact logic shifts and final state.

                JSON Step Schema:
                - line: (number)
                - memory: (object) variable: value pairs (values MUST be strings or numbers)
                - stack: (array) function names
                - event: "variable_move" | "loop_cycle" | "func_call" | "normal"
                - commentary: (string) short tech-clear explanation
                - analogy: (string) real-world comparison.
                
                Ensure strictly valid JSON.` 
            },
            { role: "user", content: `LANGUAGE: ${language}\nCODE:\n${code}` }
        ], true);

        const content = result.choices?.[0]?.message?.content;
        const trace = JSON.parse(content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1));
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
            if (validData.length < 200) throw new Error("Extraction Failed. Ensure links are public.");
        }

        const systemPrompt = `You are Pluto Intelligence, an elite synthesizer developed by Spectrum SyntaX. 
        
        PERSONA:
        - Greet with Gen Z vibes (locked in, fr, vibes, cooking).
        - Core briefing must be 100% professional and technical.
        - GROUNDED: If research data is provided, synthesize Gemini and ChatGPT perspectives into one foundation.`;

        const result = await callLlamaSmart([
            { role: "system", content: systemPrompt },
            { role: "user", content: validData ? `DATA:\n${validData}\nTOPIC: ${title}\nTASK: Brief me. Intro with vibes, then facts.` : `SESSION TITLE: ${title}` }
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
                content: `You are Pluto Intelligence, an AI by Spectrum SyntaX. No cap.
                Stay locked in. Use Gen Z slang for small talk and elite technical clarity for facts. 
                Use this knowledge base: \n\n${foundation}` 
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
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Pluto Triple-Failover Backend Active on port ${PORT}`));