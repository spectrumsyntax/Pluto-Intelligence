/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: General-purpose AI Research & Synthesis Engine.
 * Features: Pluto-X, Ghost Mode Debugger (Elite Simplicity 2.0), Standard Chat.
 * Failover Logic: Dual-Model Switching (Primary -> Secondary on Rate Limit).
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

// DUAL MODEL CONFIGURATION
const PRIMARY_MODEL = "llama-3.3-70b-versatile"; // High Intelligence (Max TPD 100k)
const SECONDARY_MODEL = "llama-3-8b-8192";      // High Rate Limit / Backup (Reliable)

// Global browser instance for singleton pattern
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
        
        // Auto-scroll to ensure all lazy-loaded messages are captured
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
 * Enhanced AI Call with Automatic Failover Switching
 * Logic: Try Primary -> If 429/TPD Limit reached -> Switch to Secondary
 */
async function callLlamaSmart(messages, isJson = false) {
    const tryCall = async (modelName, retries = 3) => {
        const delays = [1000, 2000, 4000];
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
                
                // If it's a hard rate limit or token limit, signal failover
                if (response.status === 429 || (result.error && result.error.type === 'rate_limit_reached')) {
                    throw { name: "RateLimitError", message: "Limit reached" };
                }

                if (!response.ok) throw new Error(result.error?.message || `API Error: ${response.status}`);
                return result;
            } catch (err) {
                if (err.name === "RateLimitError") throw err; // Bubble up to trigger switch
                if (i === retries - 1) throw err;
                await new Promise(res => setTimeout(res, delays[i]));
            }
        }
    };

    try {
        // First attempt with the Smartest model
        return await tryCall(PRIMARY_MODEL);
    } catch (error) {
        if (error.name === "RateLimitError") {
            // Automatic switch to the backup model
            console.log(`⚠️ Primary model rate limited. Switching to ${SECONDARY_MODEL}...`);
            return await tryCall(SECONDARY_MODEL);
        }
        throw error;
    }
}

/**
 * GHOST MODE DEBUGGER API
 */
app.post('/api/debug', async (req, res) => {
    const { code, language } = req.body;
    try {
        const result = await callLlamaSmart([
            { 
                role: "system", 
                content: `You are the Ghost Mode Debugger by Spectrum SyntaX. 
                Trace the following ${language} code. Return a JSON object with a "steps" array.

                CRITICAL INSTRUCTIONS FOR ELITE SIMPLICITY:
                1. TARGET AUDIENCE: People with zero coding knowledge. 
                2. ANALOGY FIELD: For every single step, you MUST provide an 'analogy' string that explains the logic using real-world concepts (cooking, driving, sports, etc.).
                3. COMPLEXITY HANDLING: 
                   - For ML (Neural Networks): Simplify weights as "Influence," Gradient Descent as "Finding the lowest valley," and Tensors as "Data Grids."
                   - For Data Structures: Linked Lists are "Linked train cars," Stacks are "Piles of plates."
                4. POINTER SAFETY: Represent object values (Nodes, Tensors) as simplified strings (e.g., "Node(data: 5)") to avoid nested JSON errors.
                5. BIG CODE: Max 30 steps. Skip boilerplates, focus on initialization, loops, logic shifts, and final output.

                Each step MUST have:
                - line: (number) current line executing
                - memory: (object) current variable states (Values MUST be strings or numbers).
                - stack: (array) function names.
                - event: "variable_move" | "loop_cycle" | "func_call" | "normal"
                - commentary: (string) short, technical but simple explanation.
                - analogy: (string) the ELI5 real-world comparison.

                Ensure strictly valid JSON.` 
            },
            { 
                role: "user", 
                content: `LANGUAGE: ${language}\nCODE:\n${code}` 
            }
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

        const systemPrompt = `You are Pluto Intelligence, an elite research synthesizer developed by Spectrum SyntaX. 
        
        PERSONA RULES:
        1. IDENTITY: Created by Spectrum SyntaX. No cap.
        2. SLANG: Use a Gen Z mix (locked in, fr, vibes, bet, cooking) ONLY for intro/outro paragraphs. 
        3. CONTENT: For the technical brief, be 100% professional and academic. No slang in the core facts.
        4. FORMAT: Use bold headers and Markdown tables for comparisons.
        5. SOURCE: Synthesize provided data into one seamless knowledge foundation.`;

        const result = await callLlamaSmart([
            { role: "system", content: systemPrompt },
            { role: "user", content: validData ? `DATA:\n${validData}\nTOPIC: ${title}\nTASK: Give me the briefing. Greet me with vibes, then cook up facts.` : `SESSION TITLE: ${title}` }
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
                content: `You are Pluto Intelligence, an AI developed by Spectrum SyntaX. 
                
                BEHAVIOR:
                - IDENTITY: Created by Spectrum SyntaX. Mention this if asked. No cap.
                - PERSONALITY: Stay "locked in." Use Gen Z slang (fr, lowkey, bet, vibes, cooking) for greetings and transitions.
                - CLARITY: Use high-IQ professional language for technical explanations.
                - CONTEXT: You are strictly grounded in this knowledge foundation: \n\n${foundation}` 
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
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Pluto Failover Backend Active on port ${PORT}`));